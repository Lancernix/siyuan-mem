/**
 * 模型调用层：OpenAI 兼容的 chat.completions，走官方 SDK。
 *
 * 为什么最后用了 SDK：重试（429/408/409/5xx、认 retry-after）、超时、代理、
 * keep-alive、错误分类这些 HTTP 细节它都做过了，而且是零传递依赖、纯 JS，
 * 编译进单文件只多 1MB（85→86MB，bun 会 tree-shake）。自己写这 40 行不值。
 *
 * 但 SDK 替不掉三件事，所以外面还包一层：
 *   1. JSON 模式不可用时自动回退：有些实现不认 response_format，回 400 时把字段
 *      去掉重发一次，而不是让整段会话降级成规则抽取。
 *   2. 按调用打 tag 的用量账本：SDK 只返回 usage，不知道那是"抽取"还是"自证"。
 *   3. provider 预设与免 key 的本地部署（ollama/lmstudio 不收 key）。
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR, CONFIG_PATH, ensureDirs } from "./config.mjs";

/** 各家预设。baseUrl 写到版本号为止，SDK 自己拼 /chat/completions。 */
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
    retries: m.retries ?? 3,
    provider: m.provider ?? "custom",
  };
}

/** 有 key，或者本地部署（ollama/lmstudio 不要 key）。 */
export function hasModel(cfg) {
  const m = resolveModel(cfg);
  const keyless = PROVIDERS[m.provider]?.keyless;
  return Boolean(m.baseUrl && m.model && (m.apiKey || keyless));
}

/**
 * SDK 是懒加载的：顶层 import 要 880ms（node）/ 170ms（bun 产物），而 CLI 大多数
 * 命令根本不碰模型（status/scan/search）。为了这点把每条命令都拖慢一个数量级不值得。
 */
export async function makeClient(cfg) {
  const { default: OpenAI } = await import("openai");
  const m = resolveModel(cfg);
  const keyless = PROVIDERS[m.provider]?.keyless;
  return new OpenAI({
    apiKey: m.apiKey || (keyless ? "not-needed" : ""),
    baseURL: m.baseUrl || undefined,
    maxRetries: m.retries,
    timeout: m.timeoutMs,
  });
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

const JSON_MODE_REJECTED = /response_format|json_object|json mode|json mode is not/i;

/**
 * 一次 chat 调用。
 *
 * 重试交给 SDK（maxRetries），我们只处理"这个实现不支持 JSON 模式"这一种可恢复错误：
 * 去掉 response_format 重发一次。它不算配置错误，也不该让整段会话降级。
 */
export async function chat(cfg, { messages, json = false, maxTokens, tag = "" } = {}) {
  const m = resolveModel(cfg);
  if (!hasModel(cfg)) throw new Error("没有配置模型：mem model use <provider> --key ...");

  const api = await makeClient(cfg);
  const base = {
    model: m.model,
    temperature: 0.2,
    messages,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  };
  const t0 = Date.now();
  let wantJson = json && m.jsonMode;
  let fallback = false;

  const call = (withJson) =>
    api.chat.completions.create({ ...base, ...(withJson ? { response_format: { type: "json_object" } } : {}) });

  let res;
  try {
    res = await call(wantJson);
  } catch (e) {
    if (wantJson && e?.status === 400 && JSON_MODE_REJECTED.test(e?.message ?? "")) {
      wantJson = false;
      fallback = true;
      try {
        res = await call(false);
      } catch (e2) {
        record({ at: new Date().toISOString(), model: m.model, tag, error: describe(e2) });
        throw new Error(`模型调用失败：${describe(e2)}`);
      }
    } else {
      record({ at: new Date().toISOString(), model: m.model, tag, error: describe(e) });
      throw new Error(`模型调用失败：${describe(e)}`);
    }
  }

  const out = {
    text: res.choices?.[0]?.message?.content ?? "",
    usage: { prompt: res.usage?.prompt_tokens ?? 0, completion: res.usage?.completion_tokens ?? 0 },
    jsonFallback: fallback,
    ms: Date.now() - t0,
  };
  record({ at: new Date().toISOString(), model: m.model, tag, ...out.usage, ms: out.ms, ...(fallback ? { fallback } : {}) });
  return out;
}

/** SDK 的错误信息带上状态码和响应正文，别只丢一句 "Request failed"。 */
function describe(e) {
  if (e?.name === "APIConnectionTimeoutError") return `超时：${e.message}`;
  if (e?.name === "APIConnectionError") return `网络错误：${e.message}`;
  if (typeof e?.status === "number") return `HTTP ${e.status}：${(e.message ?? "").slice(0, 300)}`;
  return e?.message ?? String(e);
}

/** 自证：真发一次请求，确认 key、地址、JSON 模式、记账这条链都通。 */
export async function probe(cfg) {
  const m = resolveModel(cfg);
  const r = await chat(cfg, {
    messages: [
      { role: "system", content: "只输出 JSON，不要解释。" },
      { role: "user", content: '回复 {"ok":true}，不要别的。' },
    ],
    json: true,
    maxTokens: 32,
    tag: "probe",
  });
  const trimmed = r.text.trim();
  return {
    ...r,
    provider: m.provider,
    model: m.model,
    jsonOk: /"ok"\s*:\s*true/.test(trimmed),
    sample: trimmed.slice(0, 120),
  };
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
