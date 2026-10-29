/**
 * Anthropic Messages 协议（/v1/messages）。
 *
 * 和 OpenAI 的三处差别，都在这里吃掉：
 *   1. system 不是消息，是顶层字段；
 *   2. max_tokens 必填；
 *   3. 鉴权是 x-api-key + anthropic-version，不是 Bearer。
 *
 * 没有 JSON 模式，所以 caps.json = false：靠提示词约束，解析端本来就兼容夹带的解释。
 * 不用官方 SDK：这一层只有 40 行，而没有 SDK 就不多一个每年会 breaking 的依赖。
 */
export const wire = "anthropic";
export const caps = { json: false, temperature: 0.2 };

export async function send(m, { messages, maxTokens, temperature, timeoutMs }) {
  const system = messages
    .filter((x) => x.role === "system")
    .map((x) => x.content)
    .join("\n\n");
  const rest = messages
    .filter((x) => x.role !== "system")
    // Anthropic 只认 user/assistant；正常对话里不会有别的角色，兜一下防止协议报错。
    .map((x) => ({ role: x.role === "assistant" ? "assistant" : "user", content: String(x.content) }));

  const body = {
    model: m.model,
    max_tokens: maxTokens ?? 4096,
    temperature: temperature ?? caps.temperature,
    messages: rest,
    ...(system ? { system } : {}),
  };

  const res = await fetch(`${m.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": m.apiKey,
      "anthropic-version": m.anthropicVersion ?? "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs ?? m.timeoutMs),
  });

  const raw = await res.text();
  if (!res.ok) throw shape(res, raw);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Anthropic 回了非 JSON：${raw.slice(0, 200)}`);
  }
  const text = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return {
    text,
    usage: {
      prompt: data.usage?.input_tokens ?? 0,
      completion: data.usage?.output_tokens ?? 0,
      cached: data.usage?.cache_read_input_tokens ?? 0,
      cacheWrite: data.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

function shape(res, raw) {
  const status = res.status;
  const out = new Error(`HTTP ${status}: ${extract(raw)}`);
  out.status = status;
  out.retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  const after = res.headers.get("retry-after");
  if (after && Number.isFinite(Number(after))) out.retryAfterMs = Number(after) * 1000;
  return out;
}

function extract(raw) {
  try {
    const j = JSON.parse(raw);
    return j?.error?.message ?? raw.slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}
