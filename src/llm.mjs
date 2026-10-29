/**
 * 模型调用层：三种协议、一个接口。
 *
 *   openai     /chat/completions           —— DeepSeek、通义、Kimi、智谱、OpenRouter、ollama、LM Studio
 *   anthropic  /v1/messages                —— Claude
 *   gemini     /models/{m}:generateContent —— Gemini
 *
 * 三层分工，别混：
 *   wire/*.mjs  只管"这种协议怎么拼请求、怎么读回复"；
 *   llm.mjs     管策略：重试、JSON 模式回退、用量记账、provider 预设；
 *   调用方      只给 messages，拿 {text, usage}。
 *
 * 为什么 openai 用官方 SDK、另两家手写：SDK 只对同一种形状有收益，而且它零传递
 * 依赖、纯 JS，编进单文件只多 1MB；Anthropic / Gemini 的请求体差异太大（system
 * 是顶层字段、模型名在路径里、角色叫 model、token 字段名字不同），各自五六十行
 * 写完，比再装两个 SDK 更好审。三者都懒加载：不碰模型的命令启动不受影响。
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR, CONFIG_PATH, ensureDirs } from "./config.mjs";

/** 各家预设。baseUrl 写到版本号为止，具体路径由 wire 拼。 */
export const PROVIDERS = {
  deepseek: { wire: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", jsonMode: true },
  qwen: { wire: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", jsonMode: true },
  moonshot: { wire: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k", jsonMode: true },
  zhipu: { wire: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-plus", jsonMode: true },
  openai: { wire: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", jsonMode: true },
  openrouter: { wire: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat", jsonMode: true },
  anthropic: { wire: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6", jsonMode: false },
  gemini: { wire: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3.5-flash", jsonMode: true },
  ollama: { wire: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:14b", jsonMode: false, keyless: true },
  lmstudio: { wire: "openai", baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", jsonMode: false, keyless: true },
};

/** 协议名 → 模块。懒加载，谁用谁拉。 */
const WIRES = {
  openai: () => import("./wire/openai.mjs"),
  anthropic: () => import("./wire/anthropic.mjs"),
  gemini: () => import("./wire/gemini.mjs"),
};

export const USAGE_PATH = join(HOME_DIR, "usage.jsonl");

/** 把 config.model 补成完整的一份：预设打底，用户显式写的覆盖预设。 */
export function resolveModel(cfg) {
  const m = cfg?.model ?? {};
  const preset = PROVIDERS[m.provider] ?? null;
  return {
    provider: m.provider ?? "custom",
    wire: m.wire || preset?.wire || "openai",
    baseUrl: (m.baseUrl || preset?.baseUrl || "").replace(/\/+$/, ""),
    model: m.name || preset?.model || "",
    apiKey: m.apiKey || "",
    jsonMode: m.jsonMode ?? preset?.jsonMode ?? false,
    timeoutMs: m.timeoutMs ?? 45_000,
    retries: m.retries ?? 3,
    anthropicVersion: m.anthropicVersion,
    temperature: m.temperature,
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

/** 服务端拒 JSON 模式时的措辞各家不同，一起匹配。 */
const JSON_MODE_REJECTED = /response_format|json_object|json mode|responseMimeType|response_mime_type/i;

/**
 * 重试策略三家统一：429/408/409/5xx 退避重试（认 retry-after），4xx 其余立刻抛。
 * 统一在策略层而不是各家 adapter 里，否则"试了几次"在不同 provider 之间不可比。
 */
async function withRetry(m, adapter, opts) {
  const tries = Math.max(0, m.retries) + 1;
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return { ...(await adapter.send(m, opts)), attempts: attempt };
    } catch (e) {
      last = e;
      if (!e.retryable || attempt === tries) break;
      await sleep(e.retryAfterMs ?? Math.min(30_000, 800 * 2 ** (attempt - 1)));
    }
  }
  throw last;
}

/**
 * 一次 chat 调用。
 *
 * JSON 模式被拒时去掉该能力重发一次，不算失败：那是服务端不支持，不是配置错，
 * 也不该让整段会话降级成规则抽取。
 */
export async function chat(cfg, { messages, json = false, maxTokens, tag = "" } = {}) {
  const m = resolveModel(cfg);
  if (!hasModel(cfg)) throw new Error("没有配置模型：mem model use <provider> --key ...");
  const loader = WIRES[m.wire];
  if (!loader) throw new Error(`不认识的协议：${m.wire}（可用：${Object.keys(WIRES).join(", ")}）`);
  const adapter = await loader();

  let wantJson = json && m.jsonMode && adapter.caps.json;
  const opts = { messages, json: wantJson, maxTokens, temperature: m.temperature };
  let fallback = false;
  const t0 = Date.now();

  let res;
  try {
    res = await withRetry(m, adapter, opts);
  } catch (e) {
    if (wantJson && e.status === 400 && JSON_MODE_REJECTED.test(e.message)) {
      fallback = true;
      try {
        res = await withRetry(m, adapter, { ...opts, json: false });
      } catch (e2) {
        record({ at: new Date().toISOString(), model: m.model, wire: m.wire, tag, error: describe(e2) });
        throw new Error(`模型调用失败：${describe(e2)}`);
      }
    } else {
      record({ at: new Date().toISOString(), model: m.model, wire: m.wire, tag, error: describe(e) });
      throw new Error(`模型调用失败：${describe(e)}`);
    }
  }

  const out = {
    text: res.text,
    usage: res.usage,
    attempts: res.attempts,
    jsonFallback: fallback,
    wire: m.wire,
    ms: Date.now() - t0,
  };
  record({
    at: new Date().toISOString(),
    model: m.model,
    wire: m.wire,
    tag,
    ...res.usage,
    ms: out.ms,
    ...(fallback ? { fallback } : {}),
  });
  return out;
}

function describe(e) {
  if (e?.status) return `HTTP ${e.status}：${(e.message ?? "").slice(0, 300)}`;
  if (e?.name === "APIConnectionTimeoutError" || e?.name === "TimeoutError") return `超时：${e.message}`;
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
export function saveModelChoice(provider, { apiKey, model, wire } = {}) {
  const preset = PROVIDERS[provider];
  if (!preset) throw new Error(`不认识的 provider：${provider}。可选：${Object.keys(PROVIDERS).join(", ")}`);
  ensureDirs();
  let cfg = {};
  if (existsSync(CONFIG_PATH)) cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  cfg.model = {
    ...(cfg.model ?? {}),
    provider,
    wire: wire || preset.wire,
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
