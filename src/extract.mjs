/**
 * 把一段会话变成记忆条目。
 *
 * 边界：只留"用户说的话"和"模型最后说的话"。thinking、工具调用、我们自己注入的
 * 上下文全部丢掉——thinking 里一半是被否掉的方案，抽出来就是三条平行记忆。
 */

import { createHash } from "node:crypto";

import { chat, hasModel } from "./llm.mjs";
import { event } from "./log.mjs";

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

任务：把对话里"以后还用得上"的东西，整理成若干条记忆，每条挂在一个话题下。

## 话题（entity）——这是最容易做错的地方

话题是「一个东西、一个项目、一件事」，**不是它身上的某个细节**。

- 好：MiniWMS、风盾500、UTO速干衣、思源记忆系统、JBL Go4、精简WMS设计
- 坏：扁平端点、TS7解锁条件、idx_sku_code、operate_qty、命名规范、列表校验

判据只有一个：**这个词以后会不会在别的对话里再次出现？**
会（"MiniWMS 那个项目上次怎么说的"），它就是话题；
只是这段话里的一个技术细节、一个字段名、一次讨论的临时结论，它就不是。

**不要造子话题。** 同一个主体的不同方面，都挂在同一个话题下：
「MiniWMS 技术栈」「MiniWMS 路由设计」「MiniWMS SKU 模型」都是 MiniWMS，
不是三个话题。给话题加限定词（技术栈、设计、接口、模型、路由）几乎总是错的。

一条记忆必须挂在对话里真实存在的主体上。不要为了分类生造话题，
也不要每个技术名词都建一个话题——那样等于没有分类。
一场对话通常只涉及 **1-3 个**话题，超过 5 个基本可以断定在造子话题。

## 记忆（text）

一条记忆 = 这个话题下**一个点**的完整总结，**自带主语**，别人不看原文也能懂。

- 坏：SKU 与库位端点统一为扁平 REST 形态（谁说？哪个项目的？）
- 好：MiniWMS 的接口统一成扁平 REST，都用 :id 定位，不再用 /sku/list 这种动词式路径。
- 坏：索引判据：查询会真实发生且当前无索引可用
- 好：MiniWMS 加索引的判据是「查询真的会发生 + 现在没索引可用」，两条都成立才加。

上限 300 字，2-4 句，陈述句，不要"用户询问""助手建议"这类元叙述。
先给结论，再补条件、理由、做法。**把一个点讲完整**比写得短重要：
不要为了压字数砍掉条件，也不要为了分行把它摊成几条。

**宁可少而整，不要多而碎。** 同一个点的相关事实合成一条讲清楚：
「用 sing-box + VLESS Reality」「从香港机房出口」「国内机另做回国」分开是三条，
合起来才看得出它们是同一套方案的三个环节。类似地，
「技术栈锁 TS 6.0.3」「NestJS 升 12.1.1」「Vite 升 7」不要各占一条，
它们是一件事：版本校准，写一条，把几个关键版本号列全。

一场对话通常产出 2-6 条记忆，超过 8 条基本可以断定拆得太细了。

## brief（摘要）

每条再给一个 brief：**不超过 30 字**，是 text 的浓缩。

它的用途是「列表里扫一眼就知道这条在说什么」，所以：
- 不要复述 text 的开头几个字（那是截断，不是摘要）
- 不要写「关于XX的说明」这种空话
- 把结论本身压短，保留主语和结论，丢掉条件和细节

例：
  text   MiniWMS 的索引改动要三处同步：init.sql、实体 @Index、云端库 ALTER，再用 EXPLAIN 验证。
  brief  MiniWMS 改索引要三处同步 + EXPLAIN 验证

只输出 JSON 对象，不要解释，不要代码块标记：
{"entries":[{"brief":"...","text":"...","entity":"话题，2-12字","type":"decision|fact|preference|reference","confidence":1}]}

type：decision 明确了方案 / fact 客观事实 / preference 偏好与原则 / reference 资料出处。
confidence 1-5，5 表示这条是明确结论、以后一定会用到。`

function stripFence(s) {
  return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

/** 条目的字数上限。prompt 里写的是 300，但模型常年写到 400+，所以这里兜一道。 */
const MAX_TEXT_CHARS = 300;

/**
 * 超长条目在句末截断，不要硬切。
 *
 * 硬切会把最后一个词劈成两半，读的人立刻知道"这条是机器截的"，
 * 而取不到句号时退到分号、逗号，是在"少一句"和"半句话"之间选少的那个。
 */
export function clampText(text, max = MAX_TEXT_CHARS) {
  const s = String(text ?? "").trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const cut = Math.max(
    head.lastIndexOf("。"),
    head.lastIndexOf("；"),
    head.lastIndexOf("！"),
    head.lastIndexOf("？"),
  );
  if (cut >= max * 0.5) return head.slice(0, cut + 1);
  const comma = head.lastIndexOf("，");
  if (comma >= max * 0.6) return `${head.slice(0, comma)}。`;
  return `${head}。`;
}

/**
 * 解析模型输出。开了 JSON 模式时接口要求顶层是对象（不能是数组），所以两种都认：
 * {"entries":[…]}/[…]。解析失败返回空数组，不抛——一段抽不出来不该让整个会话失败。
 */
export function parseEntries(raw) {
  const text = stripFence(String(raw ?? ""));
  let arr = null;
  let ok = false;
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj)) { arr = obj; ok = true; }
    else if (Array.isArray(obj?.entries)) { arr = obj.entries; ok = true; }
  } catch {
    // 模型偶尔会夹带解释，退回按括号抠。
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        arr = JSON.parse(text.slice(start, end + 1));
        ok = Array.isArray(arr);
      } catch {
        arr = null;
      }
    }
  }
  // 区分「解析成功但确实没有值得记的」和「根本没解析出来」。
  // 这两种在旧代码里是同一个返回值 []，于是坏 JSON 被当成"这场对话没内容"，
  // 零条、不重试、正常归档——记忆就这么静默丢了。
  if (!ok) return { ok: false, entries: [] };
  const entries = arr
    .map((x) => ({
      text: clampText(String(x?.text ?? "").trim()),
      // brief 缺失时退回 text 的前 30 字——不理想，但比空着强。
      brief: String(x?.brief ?? "").trim() || String(x?.text ?? "").trim().slice(0, 30),
      entity: String(x?.entity ?? "").trim(),
      type: ["decision", "fact", "preference", "reference"].includes(x?.type) ? x.type : "fact",
      confidence: Math.min(5, Math.max(1, Number(x?.confidence) || 3)),
    }))
    .filter((x) => x.text.length >= 8);
  return { ok: true, entries };
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
  // from/to 必须跟着走：丢了它，这一轮切出来的每条结论都算不出原文指针
  // （实测切成 4 段，4 段的 from/to 全是 undefined，条目全指不回原话）。
  const segs = [];
  for (const seg of paragraphs(e.q, budget)) {
    segs.push({ q: seg, a: "", from: e.from, to: e.to, note: "（这一轮的长提问，分段）" });
  }
  if (e.a) {
    for (const seg of paragraphs(e.a, budget)) {
      segs.push({ q: "（同一轮的长回复，接上段）", a: seg, from: e.from, to: e.to, note: "（按段读）" });
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

async function callModel(cfg, batch, entityShot = [], part = null) {
  // 告诉它这是第几段：不说的话，模型会以为整场对话就这一段，
  // 于是一段里能写七八条，后面的段落又写七八条，同一件事被总结三遍。
  const dialog = part
    ? `${render(batch)}\n\n（本段是同一场会话的第 ${part.index}/${part.total} 段，只总结这一段里出现的结论）`
    : render(batch);
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
  const parsed = parseEntries(r.text);
  // 解析不出来就整批算失败：宁可退回规则抽取（并让会话留在队列里重试），
  // 也不能"零条 + 成功"地归档掉。
  if (!parsed.ok) {
    throw new Error(`模型返回无法解析为条目：${String(r.text ?? "").slice(0, 60)}`);
  }
  return { entries: parsed.entries, usage: r.usage };
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
 *
 * 更常见的重复是另一种：同一件事在会话里被讨论了几轮，每轮都抽出一条，
 * 措辞不同、说的是同一个结论（"版本锁 TS 6.0.3" 前后出现三次）。只按前缀
 * 去重抓不到，这里用字二元组的覆盖率先兜一道——重复的留信息量大的那条。
 */
const DUP_SCORE = 0.55;

/** 去掉空白和标点后取字二元组：中文没有空格，词边界只能靠字形切。 */
function bigrams(s) {
  const t = String(s ?? "").replace(/[\s\p{P}]/gu, "");
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 短的那条有多少二元组被长的覆盖住。1 表示完全被包含。 */
function coverage(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let hit = 0;
  for (const g of small) if (big.has(g)) hit++;
  return hit / small.size;
}

const entityKey = (e) => String(e?.entity ?? "").replace(/\s+/g, "").toLowerCase();

export function mergeEntries(all, limit) {
  const kept = [];
  const span = (a, b) => ({
    from: a?.from == null ? b?.from : b?.from == null ? a.from : Math.min(a.from, b.from),
    to: a?.to == null ? b?.to : b?.to == null ? a.to : Math.max(a.to, b.to),
  });
  // 长的那条信息更全，brief 也跟着它走；置信度取两边高的，指针取并集。
  const pick = (prev, e) => {
    const base = e.text.length > prev.text.length ? e : prev;
    return {
      ...base,
      confidence: Math.max(prev.confidence ?? 0, e.confidence ?? 0),
      ...span(prev, e),
    };
  };
  for (const e of all) {
    const norm = (t) => String(t).replace(/\s+/g, "");
    const idx = kept.findIndex(
      (k) =>
        entityKey(k) === entityKey(e) &&
        // 全文完全相同才算同一句。原来比「前 40 字」，两条开头一样、结论不同的
        // 条目会被合并成一条，而且留下的是长的那条——另一条就永久丢了。
        (norm(k.text) === norm(e.text) || coverage(k.text, e.text) >= DUP_SCORE),
    );
    if (idx < 0) kept.push(e);
    else kept[idx] = pick(kept[idx], e);
  }
  const merged = kept.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return { entries: merged.slice(0, limit), dropped: Math.max(0, merged.length - limit) };
}

/**
 * 这次抽取会不会真的走模型。
 *
 * 单独抽成函数是为了能测：原来这里判的是 `Boolean(cfg.model?.apiKey)`，只认写在
 * config 里的 key，于是 key 来自环境变量、或者 provider 本身 keyless 的时候会
 * 悄悄退回规则抽取——而启动时 assertModel 用的是 hasModel（认识这两种），
 * 两边不一致，表现是"服务说模型正常，写进去的全是半句话"。
 */
export function willUseModel(cfg, useModelOpt) {
  return useModelOpt !== false && hasModel(cfg);
}

export async function extractEntries(cfg, exchanges, opts = {}) {
  if (!exchanges.length) return { entries: [], mode: "empty", batches: 0, dropped: 0, usage: { prompt: 0, completion: 0 } };

  const budget = cfg.extract?.maxCharsPerCall ?? DEFAULT_MAX_CHARS;
  const perBatch = cfg.extract?.maxEntriesPerBatch ?? 8;
  const useModel = willUseModel(cfg, opts.useModel);
  const plan = planBatches(exchanges, budget);
  /**
   * 一个会话最多收多少条。
   *
   * 这里原来是「批数 ×4，夹在 8~36」。实测一场 1272 轮的会话（82 批）撞了 36 的天花板，
   * 收敛完还剩 185 条，直接扔掉 149 条——而超长会话往往正是最重要的项目会话
   * （mcp-adapter、siyuan-mem 都是这么长的）。压到三十几条等于把一场项目的后半段丢了。
   *
   * 所以默认不设上限，只留一道 200 的防跑飞闸门（真到 200 条，说明这场会话本身就该拆）。
   * 想压噪音就在配置里显式写一个数，那样它盖掉这里的默认。
   */
  const perSession = cfg.extract?.maxEntriesPerSession ?? 200;

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
  let overflow = 0;
  let lastError = "";
  // 本会话已经抽出的话题名。每批都只看得到自己那一万六十字，不给它这个，
  // 同一场对话里会顺序长出「MiniWMS」「MiniWMS 技术栈」「MiniWMS 路由设计」。
  const sessionEntities = [];
  for (const [idx, batch] of plan.entries()) {
    // 这一批覆盖哪几轮。条目继承它，指针才落得到具体段落上——
    // 否则一条结论只能指整个会话（几十万字），等于没有原文。
    const from = batch[0]?.from;
    const to = batch[batch.length - 1]?.to;
    try {
      const r = await callModel(cfg, batch, [...sessionEntities, ...(opts.entityShot ?? [])], {
        index: idx + 1,
        total: plan.length,
      });
      usage.prompt += r.usage.prompt;
      usage.completion += r.usage.completion;
      // 一批超上限要计数：之前是静默截掉，日志上看起来一切正常。
      if (r.entries.length > perBatch) overflow += r.entries.length - perBatch;
      const kept = r.entries.slice(0, perBatch);
      for (const e of kept) {
        const name = e.entity?.trim();
        if (name && !sessionEntities.includes(name)) sessionEntities.push(name);
      }
      all.push(...kept.map((e) => ({ ...e, from, to })));
    } catch (e) {
      failures++;
      lastError = e.message;
      all.push(...heuristicEntries(batch, opts.fallbackEntity ?? "", 1));
    }
  }
  // 先去重（字面），再收敛（语义），最后才截断——
  // 顺序反了就会先砍掉再合并，被砍的那条本来是另一条的下半句。
  const deduped = mergeEntries(all, Number.MAX_SAFE_INTEGER).entries;
  const conv = await convergeEntries(cfg, deduped, opts.session ?? "");
  usage.prompt += conv.usage.prompt;
  usage.completion += conv.usage.completion;
  const sorted = conv.entries.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const kept = sorted.slice(0, perSession);
  // 被上限砍掉的那些，只记个数等于扔掉。留下话题 + 摘要，事后还能人工捞回来。
  const droppedBriefs = sorted.slice(perSession).slice(0, 40).map((e) => `${e.entity}｜${e.brief ?? ""}`);
  const mode = failures === 0 ? "model" : failures === plan.length ? "heuristic-after-error" : "partial";
  return {
    entries: kept,
    mode,
    batches: plan.length,
    merged: conv.merged,
    dropped: Math.max(0, conv.entries.length - kept.length) + overflow,
    droppedBriefs,
    usage,
    error: failures ? `${failures}/${plan.length} 批失败：${lastError}` : undefined,
  };
}

/**
 * 同一件事在长会话里会被总结三遍：「加索引的判据是两条都成立」
 * 前中后各出现一次，措辞不同、字面去重抓不到。
 *
 * 这一段只把「话题 + 摘要 + 正文头 120 字」递给模型，让它指出哪几条是一回事。
 * 全文不进去：判重看结论就够，把三万字再读一遍既贵又容易看花。
 */
const CONVERGE_PROMPT = `下面是一场对话里抽出来的记忆条目，每条带编号、话题、摘要。

把「说的是同一件事」的编号归成一组：措辞不同、详略不同，但结论是同一个，就算同一件事。
同一件事在不同时间被讨论、后一条比前一条更完整，也算同一件事。

只输出 JSON：{"groups":[[1,5],[3,9,12]]}
没有重复就给 {"groups":[]}。每组至少两个编号，一个编号只能出现在一组里。
拿不准就别合并——并起来会丢信息的，不算重复；只是同一个话题下的两个不同结论，也不算。`;

async function convergeEntries(cfg, entries, session = "") {
  const empty = { entries, merged: 0, usage: { prompt: 0, completion: 0 } };
  if (entries.length < 4) return empty;
  const lines = entries.map(
    (e, i) => `[${i + 1}] ${e.entity}｜${e.brief}｜${e.text.replace(/\s+/g, " ").slice(0, 120)}`,
  );
  try {
    const r = await chat(cfg, {
      messages: [
        { role: "system", content: CONVERGE_PROMPT },
        { role: "user", content: lines.join("\n") },
      ],
      json: true,
      tag: "converge",
    });
    const parsed = JSON.parse(stripFence(r.text));
    const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
    // 模型给的下标不可信：越界、重复、单元素组都要挡掉，挡不住就当没合并。
    const used = new Set();
    const merged = [];
    let mergedCount = 0;
    for (const g of groups) {
      const idx = [...new Set((Array.isArray(g) ? g : []).filter((n) => Number.isInteger(n)))]
        .map((n) => n - 1)
        .filter((n) => n >= 0 && n < entries.length && !used.has(n));
      if (idx.length < 2) continue;
      idx.forEach((n) => used.add(n));
      // 组长的那条留下：同一件事说三遍，最完整的那一版才是要记的那版。
      const pick = idx.map((n) => entries[n]).reduce((a, b) => (b.text.length > a.text.length ? b : a));
      const span = idx.reduce(
        (acc, n) => ({
          from: acc.from == null ? entries[n].from : Math.min(acc.from, entries[n].from ?? acc.from),
          to: acc.to == null ? entries[n].to : Math.max(acc.to, entries[n].to ?? acc.to),
        }),
        { from: null, to: null },
      );
      const confidence = idx.reduce((m, n) => Math.max(m, entries[n].confidence ?? 0), 0);
      merged.push({ ...pick, ...span, confidence });
      mergedCount += idx.length - 1;
      // 并了哪几条要留证：只记"合并了 293 条"没法判断对错。留话题 + 摘要，
      // 事后一眼能看出是不是把两个不同结论捏成了一个。
      event("converge.group", {
        session,
        size: idx.length,
        kept: `${pick.entity}｜${pick.brief ?? ""}`.slice(0, 60),
        members: idx.map((n) => `${entries[n].entity}｜${entries[n].brief ?? ""}`.slice(0, 60)).slice(0, 6),
      });
    }
    if (!mergedCount) return { ...empty, usage: r.usage };
    const rest = entries.filter((_, i) => !used.has(i));
    return { entries: [...merged, ...rest], merged: mergedCount, usage: r.usage };
  } catch {
    // 收敛失败不影响主流程：条目原样留下，最多是重复几条，不会丢内容。
    return empty;
  }
}

/**
 * prompt 的指纹。换一个字的 prompt，抽出来的东西就是另一套——不记版本的话，
 * 两周后看到"条目突然从 22 条变 36 条"根本分不清是模型抽风还是自己改过提示词。
 */
export const PROMPT_VERSION = createHash("sha1").update(SYSTEM_PROMPT).digest("hex").slice(0, 8);
