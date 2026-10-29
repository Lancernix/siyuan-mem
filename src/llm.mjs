/**
 * 模型调用层：只认 OpenAI 兼容的 /chat/completions。
 *
 * 为什么不装 SDK：DeepSeek、通义（compatible-mode）、Kimi、智谱、OpenRouter、火山、
 * ollama、LM Studio、vLLM 全都吃这一条协议，装 SDK 等于为同一种请求形状引入几百 KB
 * 和一堆我们不需要的默认行为（流式、自动重试、把 provider 藏在 client 构造里）。
 * 这里显式写 baseUrl + model，出问题时一眼看得出打的是谁。
 *
 * 但"不用库"不等于"裸 fetch 就够"。真正缺的四件事在这里补齐：
 *   1. 重试与退避：回灌一百多个会话时一定会撞 429，一次失败就降级成规则抽取，
 *      等于把整段会话标成需要重跑。
 *   2. JSON 模式：能开就开，400 了自动退回提示词约束——各家支持程度不一样，
 *      不能指望一个开关全局生效。
 *   3. 用量记账：usage 字段原来直接扔掉，回灌完根本不知道花了多少钱。
 *   4. provider 预设：少手抄 baseUrl，少一个错字就少半小时排查。
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR, CONFIG_PATH, ensureDirs } from "./config.mjs";

/** 各家预设。baseUrl 要写到版本号为止，因为我们自己拼 /chat/completions。 */
export const PROVIDERS = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", jsonMode: true },
  qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", jsonMode: true },
  moonshot: { baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k", jsonMode: true },
  zhipu: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-plus", jsonMode: true },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", jsonMode: true },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat", jsonMode: true },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:14b", jsonMode: false, keyless: true },
  lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", jsonMode: false, keyless: true },
};

export const USAGE_PATH = join(HOME_DIR, "usage.jsonl");

/** 把 config.model 补成完整的一份：预设打底，用户显式写的覆盖预设。 */
export function resolveModel(cfg) {
  const m = cfg?.model ?? {};
  const preset = PROVIDERS[m.provider] ?? null;
  return {
    baseUrl: (m.baseUrl || preset?.baseUrl || "").replace(/\/+$/, ""),
    model: m.name || preset?.model || "",
    apiKey: m.apiKey || "",
    jsonMode: m.jsonMode ?? preset?.jsonMode ?? false,
    timeoutMs: m.timeoutMs ?? 45_000,
    provider: m.provider ?? "custom",
  };
}

/** 有 key，或者本地部署（ollama/lmstudio 不要 key）。 */
export function hasModel(cfg) {
  const m = resolveModel(cfg);
  const keyless = PROVIDERS[m.provider]?.keyless;
  return Boolean(m.baseUrl && m.model && (m.apiKey || keyless));
}

function record(entry) {
  try {
    ensureDirs();
    appendFileSync(USAGE_PATH, JSON.stringify(entry) + "\n");
  } catch {
    /* 记账失败不影响主流程 */
  }
}

/** 今天的调用次数与 token 消耗。没配 key 时返回全零，不报错。 */
export function usageToday() {
  const day = new Date().toISOString().slice(0, 10);
  const out = { calls: 0, prompt: 0, completion: 0, failed: 0 };
  if (!existsSync(USAGE_PATH)) return out;
  for (const line of readFileSync(USAGE_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!String(r.at ?? "").startsWith(day)) continue;
    out.calls++;
    out.prompt += r.prompt ?? 0;
    out.completion += r.completion ?? 0;
    if (r.error) out.failed++;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 一次 chat 调用，带重试。
 *
 * 重试只看"可能是临时的"：429、5xx、网络超时。400/401/403 立刻抛——那是配置错了，
 * 重试三遍只会把同一个错误写三遍日志。
 */
export async function chat(cfg, { messages, json = false, maxTokens, retries = 3, timeoutMs, tag = "" } = {}) {
  const m = resolveModel(cfg);
  if (!m.baseUrl) throw new Error("没有配置 model.baseUrl");
  if (!m.apiKey && !PROVIDERS[m.provider]?.keyless) throw new Error("没有配置 model.apiKey");

  let wantJson = json && m.jsonMode;
  let attempt = 0;
  let lastErr = "";
  const t0 = Date.now();

  while (attempt <= retries) {
    attempt++;
    const body = {
      model: m.model,
      temperature: 0.2,
      messages,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(wantJson ? { response_format: { type: "json_object" } } : {}),
    };

    let res;
    try {
      res = await fetch(`${m.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(m.apiKey ? { Authorization: `Bearer ${m.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? m.timeoutMs),
      });
    } catch (e) {
      lastErr = `${e.name === "TimeoutError" ? "超时" : "网络错误"}：${e.message}`;
      if (attempt > retries) break;
      await sleep(400 * 2 ** (attempt - 1));
      continue;
    }

    const text = await res.text();

    if (res.ok) {
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`接口回了非 JSON：${text.slice(0, 200)}`);
      }
      const usage = payload?.usage ?? {};
      const out = {
        text: payload?.choices?.[0]?.message?.content ?? "",
        usage: { prompt: usage.prompt_tokens ?? 0, completion: usage.completion_tokens ?? 0 },
        attempts: attempt,
        ms: Date.now() - t0,
      };
      record({ at: new Date().toISOString(), model: m.model, tag, ...out.usage, attempts: attempt, ms: out.ms });
      return out;
    }

    // 不支持 response_format 的实现会回 400，并且正文里提到它。退回纯提示词约束，不算失败。
    if (res.status === 400 && wantJson && /response_format|json_object|json mode/i.test(text)) {
      wantJson = false;
      attempt--; // 这一轮不算重试次数：我们改的是请求形状，不是撞运气
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastErr = `HTTP ${res.status}：${text.slice(0, 160)}`;
      if (attempt > retries) break;
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : 800 * 2 ** (attempt - 1));
      continue;
    }

    // 4xx 其余：配置或权限问题，重试没有意义。
    record({ at: new Date().toISOString(), model: m.model, tag, error: `HTTP ${res.status}` });
    throw new Error(`模型接口 HTTP ${res.status}：${text.slice(0, 300)}`);
  }

  record({ at: new Date().toISOString(), model: m.model, tag, error: lastErr });
  throw new Error(`模型调用失败（试了 ${attempt} 次）：${lastErr}`);
}

/** 自证：真发一次请求，确认 key、地址、JSON 模式、token 记账这条链都通。 */
export async function probe(cfg) {
  const m = resolveModel(cfg);
  const r = await chat(
    cfg,
    {
      messages: [
        { role: "system", content: "只输出 JSON，不要解释。" },
        { role: "user", content: '回复 {"ok":true}，不要别的。' },
      ],
      json: true,
      maxTokens: 32,
      retries: 1,
      tag: "probe",
    }
  );
  const trimmed = r.text.trim();
  return { ...r, provider: m.provider, model: m.model, jsonOk: /"ok"\s*:\s*true/.test(trimmed), sample: trimmed.slice(0, 120) };
}

/** 把预设写进配置。key 只写进 home 下的 config.json（0600），不进项目目录。 */
export function saveModelChoice(provider, { apiKey, model } = {}) {
  const preset = PROVIDERS[provider];
  if (!preset) throw new Error(`不认识的 provider：${provider}。可选：${Object.keys(PROVIDERS).join(", ")}`);
  ensureDirs();
  let cfg = {};
  if (existsSync(CONFIG_PATH)) cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  cfg.model = {
    ...(cfg.model ?? {}),
    provider,
    baseUrl: preset.baseUrl,
    name: model || preset.model,
    ...(apiKey ? { apiKey } : {}),
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {}
  return resolveModel({ model: cfg.model });
}

export function maskKey(key) {
  if (!key) return "（未配置）";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
