/**
 * 模型调用层：三种协议、一个接口。
 *
 *   openai     /chat/completions           —— DeepSeek、通义、Kimi、智谱、OpenRouter、火山、ollama
 *   anthropic  /v1/messages                —— Claude
 *   gemini     /models/{m}:generateContent —— Gemini
 *
 * 传输一律走 AI SDK（`ai` + 对应的 provider 包），这里只留策略：重试、JSON 回退、
 * 用量记账、provider 预设。调用方只给 messages，拿 {text|object, usage}。
 *
 * 为什么不再手写三种协议的请求体：那三个文件能跑，但它们解决的是"协议变了我不怕"，
 * 而这个项目一年也碰不到一次协议变更；真正的痛点是换厂商要改代码（火山额度到期换
 * DeepSeek），以及三家 JSON 方式不统一。这两件事 AI SDK 直接给了。
 * 换过来的代价是依赖从 1 个变成 5 个，容器镜像大一点——换来的是配置里改两行就换家。
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR, CONFIG_PATH, ensureDirs } from "./config.mjs";
import { event } from "./log.mjs";

/**
 * 各家预设。baseUrl 写到版本号为止，具体路径由 wire 拼。
 *
 * `env` 是这家惯用的 key 环境变量。写在这里是因为原来只有"目录里的 provider"
 * 才查环境变量，预设里的十家一律不查——于是 `OPENAI_API_KEY=... mem once` 会被
 * 判成"没配模型"，或者在别处被静默降级成规则抽取。同一个东西两种认定，很坑。
 */
export const PROVIDERS = {
  deepseek: { wire: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", jsonMode: true, env: "DEEPSEEK_API_KEY" },
  qwen: { wire: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", jsonMode: true, env: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"] },
  moonshot: { wire: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k3", jsonMode: true, env: "MOONSHOT_API_KEY" },
  zhipu: { wire: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.7", jsonMode: true, env: ["ZHIPU_API_KEY", "GLM_API_KEY"] },
  openai: { wire: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini", jsonMode: true, env: "OPENAI_API_KEY" },
  openrouter: { wire: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-v4-flash", jsonMode: true, env: "OPENROUTER_API_KEY" },
  anthropic: { wire: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6", jsonMode: false, env: "ANTHROPIC_API_KEY" },
  gemini: { wire: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3.5-flash", jsonMode: true, env: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] },
  ollama: { wire: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:14b", jsonMode: false, keyless: true },
  lmstudio: { wire: "openai", baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", jsonMode: false, keyless: true },
  volcengine: { wire: "openai", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-1-6", jsonMode: true, env: ["ARK_API_KEY"] },
};

/** 预设 provider 的 key 环境变量。命中第一个非空的就是它。 */
function presetEnvKey(provider) {
  const spec = PROVIDERS[provider]?.env;
  if (!spec) return null;
  for (const name of Array.isArray(spec) ? spec : [spec]) {
    const value = process.env[name];
    if (value) return { name, value };
  }
  return null;
}

/** 协议名 → 模块。懒加载，谁用谁拉。 */
/**
 * 传输层：一律走 AI SDK。
 *
 * 原来三份手写 wire（openai / anthropic / gemini 各一个文件）能跑，但有两个问题：
 *
 *   1. 换厂商要改代码。而"火山额度到期换 DeepSeek"是必然会发生的，我们真正需要的
 *      通用性在这儿，不在"自己实现协议"。
 *   2. 结构化输出没人统一。三家各有各的 JSON 方式，出问题只能一家一家调。
 *
 * 换过来之后：换厂商只改配置（provider + baseUrl + 模型名），换协议只改 model.wire。
 *
 * 关键开关是 supportsStructuredOutputs。实测（火山 plan 端点，2026-11-05）：
 *
 *   json_object  → 模型自己发明键名（{"条目":[{"主题":…,"结论":…}]}），schema 校验失败；
 *                  而且火山还要求 prompt 里必须出现 "json" 字样，否则直接 400。
 *   json_schema  → 严格按 schema 返回，字段名、枚举都对，服务端强制。
 *
 * 所以这里必开。不开等于把"字段由谁保证"从服务端退回到提示词。
 */
/**
 * 哪些「地址 + 模型」不吃 json_schema。踩一次就记住，后面直接走 json_object。
 *
 * 这不是假设：DeepSeek 官方 API、智谱 GLM、MiniMax 都只支持 json_object，
 * 不支持 schema 约束（2026-10 的实测清单里 DeepSeek 是 0/2）。现在用的火山方舟
 * 走的是自己的端点，支持；但哪天换回 DeepSeek 官方 API，第一次会 400。
 */
const noSchema = new Set();

async function modelFor(m, { json = false } = {}) {
  const base = {
    apiKey: m.apiKey || "not-needed",
    maxRetries: 0, // 重试统一在 withRetry：两层都重试，日志里"试了几次"就没法看了
    ...(m.baseUrl ? { baseURL: m.baseUrl } : {}),
  };

  if (m.wire === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic(base)(m.model);
  }
  if (m.wire === "gemini") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    return createGoogleGenerativeAI(base)(m.model);
  }

  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  return createOpenAICompatible({
    name: m.provider || "custom",
    ...base,
    includeUsage: true,
    supportsStructuredOutputs: true,
    // 非标准字段从这里塞。默认什么都不加＝用各家默认，也就是说 thinking 是开着的：
    // 抽取要的是判断得准，不是省那点输出 token（实测开思考后条目更凝练、
    // 话题命名也更统一，代价是 4 倍输出 token、3 倍时间）。
    // 只有 model.thinking=false 才显式关掉。
    transformRequestBody: (body) => {
      let b = body;
      if (m.thinking === false) b = { ...b, thinking: { type: "disabled" } };
      // 只有"要 JSON 但没给 schema"的调用才手动开 json_object：
      // 给了 schema 的话 SDK 自己会发 json_schema，两套混着发会被服务端拒。
      if (json && m.jsonMode) b = { ...b, response_format: { type: "json_object" } };
      return b;
    },
  }).chatModel(m.model);
}

/** AI SDK 的 usage 形状 → 我们记账用的三个数。 */
function usageOf(u = {}) {
  const raw = u.raw ?? {};
  return {
    prompt: u.inputTokens ?? raw.prompt_tokens ?? 0,
    completion: u.outputTokens ?? raw.completion_tokens ?? 0,
    cached: u.inputTokenDetails?.cacheReadTokens ?? raw.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

/** AI SDK 的错误 → 我们的 {status, retryable, retryAfterMs}，重试策略只认这几个。 */
function shapeError(e) {
  const status = e?.statusCode ?? e?.status;
  // 注意不是 `?? `：SDK 对不可重试的状态会显式给 isRetryable=false，
  // 用 ?? 会把这个 false 当成"没意见"，429 就永远不重试了（实测踩过）。
  const retryable = e?.isRetryable === true || [408, 409, 429, 500, 502, 503, 504].includes(status);
  const err = new Error(e?.responseBody ? `${e.message}｜${String(e.responseBody).slice(0, 300)}` : (e?.message ?? String(e)));
  err.status = status;
  err.retryable = retryable;
  err.retryAfterMs = e?.retryAfterMs;
  // schema 校验失败单独标出来：调用方要据此决定"退回文本再解析一次"。
  if (e?.name === "AI_NoObjectGeneratedError") {
    err.noObject = true;
    err.text = e.text ?? "";
  }
  // 空回包两个原因：max_tokens 被思考吃光，或者服务端偶发返回空 content
  // （DeepSeek 官方文档自己写着「有概率返回空的 content」）。两种都值得重试一次，
  // 所以标成 retryable——按不可重试处理会把一整批降级成规则抽取。
  if (e?.name === "AI_NoOutputGeneratedError") {
    err.retryable = true;
    err.message = `${err.message}（模型没吐正文：max_tokens 太小被思考吃光，或服务端偶发空回包）`;
  }
  return err;
}

/** system 在 AI SDK 里是独立参数，不能留在 messages 里（会被当成未知角色拒掉）。 */
function splitMessages(messages = []) {
  const sys = [];
  const rest = [];
  for (const msg of messages) {
    if (msg.role === "system") sys.push(String(msg.content ?? ""));
    else rest.push(msg);
  }
  return { system: sys.join("\n\n") || undefined, messages: rest };
}

export const USAGE_PATH = join(HOME_DIR, "usage.jsonl");

/** 把 config.model 补成完整的一份：预设打底，用户显式写的覆盖预设。 */
export function resolveModel(cfg) {
  const m = cfg?.model ?? {};
  const preset = PROVIDERS[m.provider] ?? null;
  // 不在预设里也能用，但必须自己写 baseUrl。我们认协议不认厂商——三家协议的形状
  // 只有三种，端点属于配置。（原来这里会去 models.dev 那份 233 家的目录里捞 baseUrl：
  // 5.6MB 的 JSON，解析进内存要 50MB，就为兜这一行，不值。）
  const unknown = !preset && !m.baseUrl;
  // config 里写了 key 就不看环境变量；没写才去预设里找变量名。
  const envKey = m.apiKey ? null : preset ? presetEnvKey(m.provider) : null;

  const provider = m.provider ?? "custom";
  const keyless = preset?.keyless || (!m.apiKey && Boolean(envKey));
  return {
    provider,
    wire: m.wire || preset?.wire || "openai",
    baseUrl: (m.baseUrl || preset?.baseUrl || "").replace(/\/+$/, ""),
    // 配置有问题时不在这里抛：status / mem model 还得能跑，让人看到是哪一行错了。
    // 真发请求时由 chat() 抛。
    problem: unknown
      ? `不认识的 provider「${m.provider}」，也没有配 baseUrl。内置这几家：${Object.keys(PROVIDERS).join(" / ")}；别家写 model.baseUrl（mem model use <名字> --base <url> --wire <协议>）`
      : "",
    model: m.name || preset?.model || "",
    apiKey: m.apiKey || envKey?.value || "",
    apiKeyFrom: envKey?.name ?? (m.apiKey ? "config" : ""),
    keyless,
    jsonMode: m.jsonMode ?? preset?.jsonMode ?? false,
    timeoutMs: m.timeoutMs ?? 45_000,
    retries: m.retries ?? 3,
    anthropicVersion: m.anthropicVersion,
    temperature: m.temperature,
    /**
     * 默认开思考。场上只认这一个名字：请求体那边读的是 `thinking === false`。
     * 之前这里产出的是 `noThinking`（还是默认 true），两边字段名对不上——
     * 配置里写 noThinking 完全无效，而写 thinking 倒是有效，属于"开关看着有、实际空转"。
     * 老配置里的 noThinking 仍然认（取反），别让人升级后行为突变。
     */
    thinking: m.thinking ?? (m.noThinking === true ? false : true),
  };
}

/** 有 key，或者本地部署（ollama/lmstudio 不要 key）。 */
export function hasModel(cfg) {
  const m = resolveModel(cfg);
  return Boolean(m.baseUrl && m.model && (m.apiKey || m.keyless));
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
  const out = { calls: 0, prompt: 0, completion: 0, cached: 0, cacheWrite: 0, failed: 0 };
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
    out.cached += r.cached ?? 0;
    out.cacheWrite += r.cacheWrite ?? 0;
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
async function withRetry(m, send) {
  const tries = Math.max(0, m.retries) + 1;
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return { ...(await send()), attempts: attempt };
    } catch (e) {
      last = e;
      if (!e.retryable || attempt === tries) break;
      await sleep(e.retryAfterMs ?? Math.min(30_000, 800 * 2 ** (attempt - 1)));
    }
  }
  throw last;
}

/**
 * 一次调用（内部）。两种形态共用一个壳：
 *
 *   chat()       只要文本，JSON 靠 prompt 约束（判重、话题收敛这类小分类）
 *   chatObject() 要对象，schema 交给 Output.object（抽取，字段由服务端强制）
 *
 * JSON 模式被拒时去掉该能力重发一次，不算失败：那是服务端不支持，不是配置错，
 * 也不该让整段会话降级成规则抽取。
 */
async function call(cfg, { messages, json = false, schema = null, maxTokens, tag = "" } = {}) {
  const m = resolveModel(cfg);
  // problem 优先：不认识的 provider 也要说清楚是「哪一家不认识」，不能笼统报「没配模型」。
  if (m.problem) throw new Error(m.problem);
  if (!hasModel(cfg)) throw new Error("没有配置模型：mem model use <provider> --key ...");

  const { generateText, Output } = await import("ai");
  // 带 schema 的调用也要算"想要 JSON"：一旦端点拒绝 json_schema，降级时得把
  // json_object 补上。否则后续每批既没 schema 也没 json_object，格式完全交给
  // 提示词——那正是我们换 SDK 想摆脱的东西。
  const wantJson = Boolean((json || schema) && m.jsonMode);
  const key = `${m.baseUrl}|${m.model}`;
  const wantSchema = Boolean(schema) && !noSchema.has(key);
  const t0 = Date.now();

  const send = async ({ json: useJson = wantJson, withSchema = wantSchema } = {}) => {
    const model = await modelFor(m, { json: useJson && !withSchema });
    const { system, messages: rest } = splitMessages(messages);
    try {
      const res = await generateText({
        model,
        // 重试必须关在 SDK 里面：它默认自己重试两次，且不认我们的 Retry-After 策略，
        // 结果就是"日志上 attempts=1，实际打了三次"（实测）。
        maxRetries: 0,
        ...(system ? { system } : {}),
        messages: rest,
        ...(m.temperature == null ? {} : { temperature: m.temperature }),
        ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
        ...(withSchema ? { output: Output.object({ schema }) } : {}),
      });
      return { text: res.text ?? "", object: res.output, usage: usageOf(res.usage) };
    } catch (e) {
      throw shapeError(e);
    }
  };

  let res;
  let fallback = false;
  try {
    res = await withRetry(m, () => send());
  } catch (e) {
    if (schema && e.noObject) {
      // schema 没过但模型确实回了内容：退回文本模式再要一次，让调用方自己解析。
      // 直接判失败会把一整批降级成规则抽取，代价远大于多花一次调用。
      fallback = true;
      event("llm.fallback", { kind: "schema-validate", model: m.model, wire: m.wire });
      try {
        res = await withRetry(m, () => send({ withSchema: false }));
      } catch (e2) {
        record({ at: new Date().toISOString(), model: m.model, wire: m.wire, tag, error: describe(e2) });
        throw new Error(`模型调用失败：${describe(e2)}`);
      }
    } else if (schema && e.status === 400 && JSON_MODE_REJECTED.test(e.message)) {
      // 这家不认 json_schema（DeepSeek 官方 API、GLM 都是）。记住，退回 json_object，
      // 让调用方自己解析文本——比整批降级成规则抽取好得多。
      noSchema.add(key);
      fallback = true;
      event("llm.fallback", { kind: "schema-unsupported", model: m.model, wire: m.wire });
      try {
        res = await withRetry(m, () => send({ withSchema: false, json: true }));
      } catch (e2) {
        record({ at: new Date().toISOString(), model: m.model, wire: m.wire, tag, error: describe(e2) });
        throw new Error(`模型调用失败：${describe(e2)}`);
      }
    } else if (wantJson && e.status === 400 && JSON_MODE_REJECTED.test(e.message)) {
      fallback = true;
      event("llm.fallback", { kind: "json-unsupported", model: m.model, wire: m.wire });
      try {
        res = await withRetry(m, () => send({ json: false }));
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
    object: res.object,
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

/** 只要文本。`json:true` 时让服务端开 json_object（字段仍由 prompt 约定）。 */
export async function chat(cfg, opts = {}) {
  return await call(cfg, opts);
}

/**
 * 要一个符合 schema 的对象。
 *
 * schema 是 zod，AI SDK 会把它翻成 JSON Schema 随请求发下去，服务端（火山实测支持）
 * 强制模型按字段返回；不合规时 SDK 抛 NoObjectGeneratedError，但 e.text 里通常有
 * 原始输出——抽取那边会拿它再解析一次，能救回一部分。
 */
export async function chatObject(cfg, opts = {}) {
  return await call(cfg, opts);
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
    // 留够余量：max_tokens 把「思考」也算进去。现在 thinking 默认是开的，
    // 128 会被推理吃光，正文变成空串，SDK 直接报 "No output generated"——
    // 看起来像配置错了，其实是额度太小。1024 够它想完再答一句。
    maxTokens: 1024,
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
export function saveModelChoice(provider, { apiKey, model, wire, base } = {}) {
  const preset = PROVIDERS[provider];
  // 预设之外也能用，但必须给端点：我们认协议不认厂商，端点写不出来就没得接。
  if (!preset && !base) {
    throw new Error(
      `不认识的 provider：${provider}。\n  内置：${Object.keys(PROVIDERS).join(", ")}\n  别家请带上端点：mem model use ${provider} --base https://… --wire openai|anthropic|gemini`
    );
  }
  // --base 用来接预设之外的端点（比如同一家的另一个 API 面：/api/v3 与 /api/plan/v3）。
  const baseUrl = String(base || preset?.baseUrl || "").replace(/\/+$/, "");
  const name = model || preset?.model || "";
  if (!name) throw new Error(`没有默认模型，加 --name 指定一个：mem model use ${provider} --name <模型>`);
  ensureDirs();
  let cfg = {};
  if (existsSync(CONFIG_PATH)) cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  cfg.model = {
    ...(cfg.model ?? {}),
    provider,
    wire: wire || preset?.wire || "openai",
    baseUrl,
    name,
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
