/**
 * OpenAI 兼容协议（/chat/completions）。绝大多数国产与本地推理服务都是这个形状：
 * DeepSeek、通义 compatible-mode、Kimi、智谱、OpenRouter、火山、ollama、LM Studio。
 *
 * 走官方 SDK，但 maxRetries 关掉：重试策略统一在 llm.mjs 里，三家一样，
 * 日志里"试了几次"才有得看。
 */
export const wire = "openai";
export const caps = { json: true, temperature: 0.2 };

export async function send(m, { messages, json, maxTokens, temperature, timeoutMs }) {
  // 懒加载：SDK 顶层 import 在 node 下要 880ms，不该拖累 status/scan 这些不碰模型的命令。
  const { default: OpenAI } = await import("openai");
  const api = new OpenAI({
    apiKey: m.apiKey || "not-needed",
    baseURL: m.baseUrl,
    maxRetries: 0,
    timeout: timeoutMs ?? m.timeoutMs,
  });

  try {
    const res = await api.chat.completions.create({
      model: m.model,
      temperature: temperature ?? caps.temperature,
      messages,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(json ? { response_format: { type: "json_object" } } : {}),
    });
    return {
      text: res.choices?.[0]?.message?.content ?? "",
      usage: {
        prompt: res.usage?.prompt_tokens ?? 0,
        completion: res.usage?.completion_tokens ?? 0,
        // 缓存命中的输入单独算钱（便宜一个数量级），不记下来就没法估真实成本。
        cached: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  } catch (e) {
    throw shape(e);
  }
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
