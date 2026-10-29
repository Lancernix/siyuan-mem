/**
 * 把一段会话变成记忆条目。
 *
 * 边界：只留"用户说的话"和"模型最后说的话"。thinking、工具调用、我们自己注入的
 * 上下文全部丢掉——thinking 里一半是被否掉的方案，抽出来就是三条平行记忆。
 */

const STOP = new Set([
  "继续", "好的", "好", "嗯", "可以", "行", "谢谢", "ok", "OK", "是的", "不对",
  "然后呢", "还有吗", "明白了", "懂了",
]);

/** 会话里的注入块带这个前缀，第二轮不排除就会被当成用户说的话再抽一遍。 */
const INJECT_PREFIX = "plugin:";

export function normalizeTurns(turns) {
  const out = [];
  for (const t of turns ?? []) {
    const role = t?.role ?? t?.type;
    if (role !== "user" && role !== "assistant") continue;
    if (t?.source?.kind && String(t.source.kind).startsWith(INJECT_PREFIX)) continue;
    const text = String(t?.text ?? "").trim();
    if (!text) continue;
    out.push({ role, text });
  }
  return out;
}

/** 用户一句 + 模型一句算一个 exchange，落单的用户话也算。 */
export function toExchanges(turns, minTurnChars = 25) {
  const out = [];
  let pending = null;
  for (const t of turns) {
    if (t.role === "user") {
      if (pending) out.push(pending);
      pending = { q: t.text, a: "" };
    } else if (pending) {
      pending.a = t.text;
      out.push(pending);
      pending = null;
    }
  }
  if (pending) out.push(pending);
  return out.filter((e) => {
    if (e.q.length < minTurnChars && e.a.length < minTurnChars) return false;
    if (STOP.has(e.q.trim())) return false;
    return true;
  });
}

/* ---------- 有模型 ---------- */

const SYSTEM_PROMPT = `你是记忆整理器。输入是一段人机对话，按时间顺序。

只做一件事：把其中"以后还用得上"的结论，抽成独立条目。规则：
- 一条一句话，不超过 40 字，陈述句。不要"用户询问""助手建议"这类元叙述。
- 只抽结论。不抽过程、不抽被否掉的方案、不抽临时的中间状态。
- 已选定的方案优先于候选方案。若有替代关系，只保留最终的那个。
- 关于用户的稳定偏好、环境事实、外部工具版本，可以抽。
- 没有值得记的，返回空数组。

只输出 JSON，不要解释，不要代码块标记：
[{"text":"...","entity":"核心对象，2-8字名词","type":"decision|fact|preference|reference","confidence":1}]

entity 是以后用来检索的那个词，比如"风盾500""投影仪桌面""思源MCP"。
confidence 1-5，5 表示这条是明确结论、以后一定会用到。`

function stripFence(s) {
  return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

function parseEntries(raw) {
  const text = stripFence(String(raw ?? ""));
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => ({
      text: String(x?.text ?? "").trim(),
      entity: String(x?.entity ?? "").trim(),
      type: ["decision", "fact", "preference", "reference"].includes(x?.type) ? x.type : "fact",
      confidence: Math.min(5, Math.max(1, Number(x?.confidence) || 3)),
    }))
    .filter((x) => x.text.length >= 8);
}

async function callModel(cfg, exchanges) {
  const dialog = exchanges
    .map((e, i) => `#${i + 1}\n用户：${e.q}\n助手：${e.a || "（无回复）"}`)
    .join("\n\n");

  const res = await fetch(`${cfg.model.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.model.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model.name,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: dialog.slice(0, 24000) },
      ],
    }),
    signal: AbortSignal.timeout(cfg.model.timeoutMs ?? 45000),
  });
  if (!res.ok) throw new Error(`模型接口 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return parseEntries(body?.choices?.[0]?.message?.content);
}

/* ---------- 没有模型时的降级 ---------- */

const DECISION_HINT = /(建议|推荐|结论|应该|不要|最好|选|确定|定了|就用|改成|方案是)/;

/** 取回答里最像结论的一句，去掉列表符号和前缀。 */
function pickSentence(answer) {
  const clean = answer
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ");
  const sentences = clean.split(/(?<=[。！？；!?;])/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return "";
  const hit = sentences.find((s) => DECISION_HINT.test(s) && s.length >= 12);
  const picked = hit ?? sentences[0];
  return picked.replace(/[。！？；]$/, "").slice(0, 60);
}

function guessEntity(question, fallback) {
  const quoted = question.match(/[《「“"]([^》」”"]{2,12})[》」”"]/);
  if (quoted) return quoted[1];
  const ascii = question.match(/\b([A-Za-z][A-Za-z0-9.+-]{1,15})\b/g);
  if (ascii?.length) return ascii.sort((a, b) => b.length - a.length)[0];
  return fallback;
}

function heuristicEntries(exchanges, fallbackEntity, limit) {
  const out = [];
  for (const e of exchanges) {
    const sentence = pickSentence(e.a || e.q);
    if (!sentence) continue;
    out.push({
      text: sentence,
      entity: guessEntity(e.q, fallbackEntity),
      type: DECISION_HINT.test(sentence) ? "decision" : "fact",
      confidence: 2,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * @param {object} cfg
 * @param {{q:string,a:string}[]} exchanges
 * @param {{fallbackEntity?:string, useModel?:boolean}} opts
 */
export async function extractEntries(cfg, exchanges, opts = {}) {
  const limit = cfg.extract?.maxEntriesPerSession ?? 6;
  const useModel = opts.useModel !== false && Boolean(cfg.model?.apiKey);
  if (!exchanges.length) return { entries: [], mode: "empty" };

  const batch = exchanges.slice(-(cfg.extract?.maxExchangesPerCall ?? 12));
  if (!useModel) {
    return { entries: heuristicEntries(batch, opts.fallbackEntity ?? "", limit), mode: "heuristic" };
  }
  try {
    const entries = await callModel(cfg, batch);
    return { entries: entries.slice(0, limit), mode: "model" };
  } catch (e) {
    const fallback = heuristicEntries(batch, opts.fallbackEntity ?? "", limit);
    return { entries: fallback, mode: "heuristic-after-error", error: e.message };
  }
}
