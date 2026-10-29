/**
 * OpenAI 兼容协议（/chat/completions）。绝大多数国产与本地推理服务都是这个形状：
 * DeepSeek、通义 compatible-mode、Kimi、智谱、OpenRouter、火山、ollama、LM Studio。
 *
 * 走官方 SDK，但 maxRetries 关掉：重试策略统一在 llm.mjs 里，三家一样，
 * 日志里"试了几次"才有得看。
 */
export const wire = "openai";
export const caps = { json: true, temperature: 0.2, thinking: true };

/**
 * 哪些「地址 + 模型」不认 thinking 字段。
 *
 * 关思考是靠一个非标准参数实现的（`thinking: {type:"disabled"}`，火山/DeepSeek
 * 都认），不在 OpenAI 规范里，所以 OpenAI 官方和部分实现会回 400。回一次就记住，
 * 之后这家不再带，只浪费第一次调用。
 */
const noThinkingUnsupported = new Set();

export async function send(m, { messages, json, maxTokens, temperature, timeoutMs, noThinking }) {
  // 懒加载：SDK 顶层 import 在 node 下要 880ms，不该拖累 status/scan 这些不碰模型的命令。
  const { default: OpenAI } = await import("openai");
  const api = new OpenAI({
    apiKey: m.apiKey || "not-needed",
    baseURL: m.baseUrl,
    maxRetries: 0,
    timeout: timeoutMs ?? m.timeoutMs,
  });

  const key = `${m.baseUrl}|${m.model}`;
  const wantNoThinking = noThinking !== false && caps.thinking && !noThinkingUnsupported.has(key);

  const build = (withThinking) => ({
    model: m.model,
    temperature: temperature ?? caps.temperature,
    messages,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(json ? { response_format: { type: "json_object" } } : {}),
    // 抽取和判重都不需要「先想一遍」：给了明确规则、只要结构化输出，
    // 思考只会把它往「过程叙述」上带，还平白多付十倍输出 token。
    ...(withThinking ? { thinking: { type: "disabled" } } : {}),
  });

  try {
    return parse(await api.chat.completions.create(build(wantNoThinking)));
  } catch (e) {
    const err = shape(e);
    // 400 且提到 thinking/reasoning：这家不认这个字段，去掉重发一次。
    if (wantNoThinking && err.status === 400 && /thinking|reasoning|unknown field|extra/i.test(err.message)) {
      noThinkingUnsupported.add(key);
      try {
        return parse(await api.chat.completions.create(build(false)));
      } catch (e2) {
        throw shape(e2);
      }
    }
    throw err;
  }
}

function parse(res) {
  return {
    text: res.choices?.[0]?.message?.content ?? "",
    usage: {
      prompt: res.usage?.prompt_tokens ?? 0,
      completion: res.usage?.completion_tokens ?? 0,
      // 缓存命中的输入单独算钱（便宜一个数量级），不记下来就没法估真实成本。
      cached: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      // 思考 token 单独记：关掉思考之后这里应该是 0，不是 0 就说明没关成。
      reasoning: res.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

/** 把 SDK 的错误压成统一形状：status / retryable / retryAfterMs。 */
function shape(e) {
  const status = typeof e?.status === "number" ? e.status : 0;
  const out = new Error(e?.message ?? String(e));
  out.status = status;
  out.retryable = status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
  const after = e?.headers?.get?.("retry-after");
  if (after && Number.isFinite(Number(after))) out.retryAfterMs = Number(after) * 1000;
  return out;
}
