/**
 * 把一段会话变成记忆条目。
 *
 * 边界：只留"用户说的话"和"模型最后说的话"。thinking、工具调用、我们自己注入的
 * 上下文全部丢掉——thinking 里一半是被否掉的方案，抽出来就是三条平行记忆。
 */

import { chat } from "./llm.mjs";

const STOP = new Set([
  "继续", "好的", "好", "嗯", "可以", "行", "谢谢", "ok", "OK", "是的", "不对",
  "然后呢", "还有吗", "明白了", "懂了",
]);

/** 会话里的注入块带这个前缀，第二轮不排除就会被当成用户说的话再抽一遍。 */
const INJECT_PREFIX = "plugin:";

export function normalizeTurns(turns) {
  const out = [];
  const push = (role, text, at) => {
    const last = out[out.length - 1];
    // 相邻同角色合并：日志里一条回复常被拆成多个事件（流式、分段发送），
    // 一条提问也可能连着两条。当成两轮处理，第二条会因为没有配对而被整段丢掉。
    if (last && last.role === role) {
      last.text = `${last.text}\n\n${text}`;
      last.to = at;
      return;
    }
    out.push({ role, text, from: at, to: at });
  };
  (turns ?? []).forEach((t, idx) => {
    const role = t?.role ?? t?.type;
    if (role !== "user" && role !== "assistant") return;
    if (t?.source?.kind && String(t.source.kind).startsWith(INJECT_PREFIX)) return;
    const text = String(t?.text ?? "").trim();
    if (!text) return;
    push(role, text, idx);
  });
  return out;
}

/**
 * 用户一句 + 模型一句算一个 exchange，落单的用户话也算。
 *
 * 每条带 from/to（原始 turns 的下标）：结论要能指回「这一批对话是哪几轮」，
 * 否则条目上的原文指针只能指整个会话，等于没有。
 */
export function toExchanges(turns, minTurnChars = 25) {
  const out = [];
  let pending = null;
  for (const t of turns) {
    if (t.role === "user") {
      if (pending) out.push(pending);
      pending = { q: t.text, a: "", from: t.from, to: t.to };
    } else if (pending) {
      pending.a = t.text;
      pending.to = t.to;
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

只输出 JSON 对象，不要解释，不要代码块标记：
{"entries":[{"text":"...","entity":"核心对象，2-8字名词","type":"decision|fact|preference|reference","confidence":1}]}

entity 是以后用来检索的那个词，比如"风盾500""投影仪桌面""思源MCP"。
confidence 1-5，5 表示这条是明确结论、以后一定会用到。`

function stripFence(s) {
  return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

/**
 * 解析模型输出。开了 JSON 模式时接口要求顶层是对象（不能是数组），所以两种都认：
 * {"entries":[…]}/[…]。解析失败返回空数组，不抛——一段抽不出来不该让整个会话失败。
 */
function parseEntries(raw) {
  const text = stripFence(String(raw ?? ""));
  let arr = null;
  try {
    const obj = JSON.parse(text);
    arr = Array.isArray(obj) ? obj : Array.isArray(obj?.entries) ? obj.entries : null;
  } catch {
    // 模型偶尔会夹带解释，退回按括号抠。
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        arr = JSON.parse(text.slice(start, end + 1));
      } catch {
        arr = null;
      }
    }
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

/** 一次调用塞多少字符。中文约 1 字 0.62 token，16000 字约一万 token，余量足够。 */
const DEFAULT_MAX_CHARS = 16000;
/** 单次请求的硬上限，纯兜底：分批逻辑保证永远碰不到。 */
const HARD_MAX_CHARS = 180000;

function render(exchanges) {
  return exchanges
    .map((e, i) => {
      const note = e.note ? `${e.note}\n` : "";
      return `#${i + 1}\n${note}用户：${e.q}\n助手：${e.a || "（无回复）"}`;
    })
    .join("\n\n");
}

/** 按段落切，单段仍超长时硬切。拼起来必须等于原文。 */
function paragraphs(text, budget) {
  const out = [];
  let buf = "";
  for (const line of String(text).split("\n")) {
    if (buf.length + line.length + 1 > budget && buf) {
      out.push(buf);
      buf = "";
    }
    if (line.length > budget) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      for (let i = 0; i < line.length; i += budget) out.push(line.slice(i, i + budget));
      continue;
    }
    buf = buf ? `${buf}\n${line}` : line;
  }
  if (buf) out.push(buf);
  return out.length ? out : [""];
}

/**
 * 一条问答本身就超过一次调用的预算时，按内容切成几段，分别送。
 *
 * 切不是丢：所有段拼起来就是原文。会走到这里的多半是整段粘贴——日志、报错、长文档，
 * 这时提问和回答的配对已经没意义了，逐段看反而更容易挑出结论。
 */
function splitExchange(e, budget) {
  const segs = [];
  const qParts = paragraphs(e.q, budget);
  for (const seg of qParts) segs.push({ q: seg, a: "", note: "（这一轮的长提问，分段）" });
  if (e.a) {
    for (const seg of paragraphs(e.a, budget)) {
      segs.push({ q: "（同一轮的长回复，接上段）", a: seg, note: "（按段读）" });
    }
  }
  return segs;
}

/** 按字符预算分批，一条都不落。 */
export function planBatches(exchanges, budget = DEFAULT_MAX_CHARS) {
  const out = [];
  let cur = [];
  let size = 0;
  const flush = () => {
    if (cur.length) out.push(cur);
    cur = [];
    size = 0;
  };
  for (const e of exchanges) {
    const one = render([e]).length;
    if (one > budget) {
      flush();
      for (const seg of splitExchange(e, budget)) {
        cur.push(seg);
        size += render([seg]).length;
        if (size >= budget) flush();
      }
      flush();
      continue;
    }
    if (size + one > budget) flush();
    cur.push(e);
    size += one;
  }
  flush();
  return out;
}

async function callModel(cfg, batch, entityShot = []) {
  const dialog = render(batch);
  if (dialog.length > HARD_MAX_CHARS) {
    throw new Error(`一批 ${dialog.length} 字，超过单次上限，分批有 bug`);
  }
  // 已有实体清单放 system 里：它是规则的一部分，不是对话内容。
  // 不放会怎样：同一款裤子在五个会话里长出五个名字，检索时查一个漏四个。
  const system = entityShot.length
    ? `${SYSTEM_PROMPT}\n\n已有实体（能对上就复用同名；不是同一个具体对象就别硬套，用新名字）：\n${entityShot.join("、")}`
    : SYSTEM_PROMPT;

  const r = await chat(cfg, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: dialog },
    ],
    json: true,
    tag: "extract",
  });
  return { entries: parseEntries(r.text), usage: r.usage };
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
      from: e.from,
      to: e.to,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 同一句话被两批都抽到时留置信度高的那条，但轮次范围取并集：
 * 两批都提到了它，说明这段对话里两次都在说同一件事，指针覆盖两处才是对的。
 */
function mergeEntries(all, limit) {
  const seen = new Map();
  const span = (a, b) => ({
    from: a?.from == null ? b?.from : b?.from == null ? a.from : Math.min(a.from, b.from),
    to: a?.to == null ? b?.to : b?.to == null ? a.to : Math.max(a.to, b.to),
  });
  for (const e of all) {
    const key = e.text.replace(/\s+/g, "").slice(0, 40);
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, e);
      continue;
    }
    const winner = (e.confidence ?? 0) > (prev.confidence ?? 0) ? e : prev;
    seen.set(key, { ...winner, ...span(prev, e) });
  }
  const merged = [...seen.values()].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return { entries: merged.slice(0, limit), dropped: Math.max(0, merged.length - limit) };
}

/**
 * @param {object} cfg
 * @param {{q:string,a:string,from?:number,to?:number,note?:string}[]} exchanges
 * @param {{fallbackEntity?:string, useModel?:boolean, entityShot?:string[]}} opts
 */
export async function extractEntries(cfg, exchanges, opts = {}) {
  if (!exchanges.length) return { entries: [], mode: "empty", batches: 0, dropped: 0, usage: { prompt: 0, completion: 0 } };

  const budget = cfg.extract?.maxCharsPerCall ?? DEFAULT_MAX_CHARS;
  const perBatch = cfg.extract?.maxEntriesPerBatch ?? 6;
  // 会话上限只是防噪音，不是省钱手段。撞到了要报出来，不能默默扔掉。
  const perSession = cfg.extract?.maxEntriesPerSession ?? 60;
  const useModel = opts.useModel !== false && Boolean(cfg.model?.apiKey);
  const plan = planBatches(exchanges, budget);

  if (!useModel) {
    // 规则模式能力有限，每批只取 1 条，但每批都过一遍，不跳过任何一段对话。
    const all = [];
    for (const batch of plan) all.push(...heuristicEntries(batch, opts.fallbackEntity ?? "", 1));
    const { entries, dropped } = mergeEntries(all, perSession);
    return { entries, mode: "heuristic", batches: plan.length, dropped, usage: { prompt: 0, completion: 0 } };
  }

  const all = [];
  const usage = { prompt: 0, completion: 0 };
  let failures = 0;
  let lastError = "";
  for (const batch of plan) {
    // 这一批覆盖哪几轮。条目继承它，指针才落得到具体段落上——
    // 否则一条结论只能指整个会话（几十万字），等于没有原文。
    const from = batch[0]?.from;
    const to = batch[batch.length - 1]?.to;
    try {
      const r = await callModel(cfg, batch, opts.entityShot ?? []);
      usage.prompt += r.usage.prompt;
      usage.completion += r.usage.completion;
      all.push(...r.entries.slice(0, perBatch).map((e) => ({ ...e, from, to })));
    } catch (e) {
      failures++;
      lastError = e.message;
      all.push(...heuristicEntries(batch, opts.fallbackEntity ?? "", 1));
    }
  }
  const { entries, dropped } = mergeEntries(all, perSession);
  const mode = failures === 0 ? "model" : failures === plan.length ? "heuristic-after-error" : "partial";
  return {
    entries,
    mode,
    batches: plan.length,
    dropped,
    usage,
    error: failures ? `${failures}/${plan.length} 批失败：${lastError}` : undefined,
  };
}
