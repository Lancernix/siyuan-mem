/**
 * Google Gemini 协议（POST /v1beta/models/{model}:generateContent）。
 *
 * 差别比 Anthropic 还大：
 *   1. 模型名在路径里，不在 body 里；
 *   2. 角色只有 user/model，没有 assistant，也没有 system（system 单独一个字段）；
 *   3. 内容是 parts 数组，不是字符串；
 *   4. token 叫 usageMetadata.promptTokenCount / candidatesTokenCount。
 *
 * 有一点值得注意：Gemini 3 官方明确建议 temperature 保持 1.0，调低反而会退化。
 * 所以这里 caps.temperature 是 1.0，跟另外两家不一样。
 */
export const wire = "gemini";
export const caps = { json: true, temperature: 1.0 };

export async function send(m, { messages, json, maxTokens, temperature, timeoutMs }) {
  const system = messages
    .filter((x) => x.role === "system")
    .map((x) => x.content)
    .join("\n\n");
  const contents = messages
    .filter((x) => x.role !== "system")
    .map((x) => ({
      role: x.role === "assistant" ? "model" : "user",
      parts: [{ text: String(x.content) }],
    }));

  const body = {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: {
      temperature: temperature ?? caps.temperature,
      ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
      ...(json ? { responseMimeType: "application/json" } : {}),
    },
  };

  const url = `${m.baseUrl}/models/${encodeURIComponent(m.model)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": m.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs ?? m.timeoutMs),
  });

  const raw = await res.text();
  if (!res.ok) throw shape(res, raw);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini 回了非 JSON：${raw.slice(0, 200)}`);
  }
  const cand = data.candidates?.[0];
  if (!cand) {
    // 安全策略拦掉时既没有 candidates 也没有 error，只有 promptFeedback。
    const blocked = data.promptFeedback?.blockReason ?? "没有 candidates";
    throw new Error(`Gemini 没给结果：${blocked}`);
  }
  const text = (cand.content?.parts ?? []).map((p) => p.text ?? "").join("");
  return {
    text,
    usage: {
      prompt: data.usageMetadata?.promptTokenCount ?? 0,
      completion: data.usageMetadata?.candidatesTokenCount ?? 0,
      cached: data.usageMetadata?.cachedContentTokenCount ?? 0,
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
