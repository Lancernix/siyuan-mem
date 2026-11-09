/**
 * 入库前的判重：这条要写的记忆，库里是不是已经有了？
 *
 * 为什么不在写完之后再扫：事后扫是「两两归组」，模型看到一堆同话题的句子就爱按
 * 「方面」归并，实测会把「Start 的全栈只是 BFF 层」和「Start 是 Vite 驱动的全栈框架」
 * 当成重复——它们各自能独立成立，删哪条都丢信息。
 *
 * 换成「一条新条目 × 一小撮候选」的判断，问题变窄了，模型只需要回答
 * 「这段话库里是不是已经说过」。
 *
 * 三步：
 *   1) 从旧条目里按字面覆盖率挑前 10 条候选（同话题 + 话题名漂移了的）；
 *   2) 一次调用，让模型对每条新条目给出 covered / replace / keep；
 *   3) covered 不写，replace 写新的并把旧的标 superseded，keep 正常写。
 *
 * 为什么只有字面、没有向量：试过了，不划算。同一份语料、同一个模型裁判、候选预算
 * 对齐之后（entries 200 字口径）：字面 6 条召回 87%，字面 10 条 99%，向量 10 条
 * 只有 27%——同话题条目的余弦中位数才 0.49，真重复和不相干的两对混在一个区间里，
 * 而且 10 条的名额被「同一个话题里都在讲这件事」的邻居挤满。多给 4 个候选位置的
 * 收益，比换一整套嵌入接口大得多。重排序模型也试过：同话题配对里重复与不重复的
 * 分数分布几乎完全重叠（0.999 vs 0.981），判不了。
 *
 * 宁可多写一条重复，也不要少记一条——所以解析失败、模型含糊、候选为空，
 * 一律当 keep 处理。
 */
import { chat } from "../util/llm.mjs";

const PROMPT = `你是记忆库的入库裁判。下面有「待写入的新条目」和每条新条目对应的「库里已有的相关条目」。

对每条新条目，判断它和候选里的某一条是不是**说的是同一件事**：
- 同一件事：删掉其中一条不丢信息，只是换了说法或详略不同。
- 不是同一件事：两条各讲一个事实、各是一个决策，各自能独立成立——
  哪怕都关于同一个方面，也不算。
- 候选**不一定和它同话题**：同一个对象被起了两个名字、或者话题名后来改了，
  也会出现在候选里。这种恰恰要看仔细：它可能正是「旧结论已经被推翻」的那一条。

是同一条时，再判断留哪条：
- covered：库里那条已经把信息说完了 → 新条目不写。
- replace：新条目更全或更新（多了条件、理由、更新的结论）→ 写新的，旧的标过时。

只输出 JSON，不要解释：
{"decisions":[{"new":1,"match":12,"action":"covered"},{"new":2,"match":7,"action":"replace"}]}
不重复的新条目不要出现在结果里。match 是候选的编号。
拿不准就当不重复——多写一条，比错删一条便宜。`;

/** 去掉空白和标点后取字二元组。中文没有词边界，只能按字形切。 */
function bigrams(s) {
  const t = String(s ?? "").replace(/[\s\p{P}]/gu, "");
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 实体名归一：判重只认名字，不认 id——同一个对象在两个会话里被起了两个名字，
 *  正是要抓的那种漏。 */
function entityKey(name) {
  return String(name ?? "").replace(/\s+/g, "").toLowerCase();
}

/** 短的那条有多少二元组被长的覆盖住。1 表示完全被包含。 */
function coverOf(A, B) {
  if (!A.size || !B.size) return 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let hit = 0;
  for (const g of small) if (big.has(g)) hit++;
  return hit / small.size;
}

/** 同话题、字面又不沾边的，不必送模型；0.15 是「换个说法」的下限，再低就是两回事。 */
const MIN_COVERAGE = 0.15;
/** 跨话题时的高覆盖兜底：整段都是中文、没有稀有词可用时，只能靠字面。 */
const CROSS_MIN_COVERAGE = 0.28;
/** 稀有词：全库出现不超过这么多次，才算「有辨识度」。 */
const RARE_DF_MAX = 3;
/** 覆盖率打平时优先同话题：先验上它更可能是重复。 */
const SAME_ENTITY_BONUS = 0.06;
/** 每个共享稀有词加一点分，最多算三个。 */
const RARE_HIT_BONUS = 0.04;
/**
 * 候选给到 10 条而不是 6 条。这一条是实测出来的最大收益：
 * 6 条召回 87%，10 条 99%。条目越长（200 字口径）字面越准，多给几个位置就够了。
 */
const MAX_CANDIDATES = 10;

/** 取有辨识度的英文/标识符词：bwrap、GH_CONFIG_DIR、某个仓库名。中文不切词。 */
function tokensOf(text) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)) out.add(m[0].toLowerCase());
  return out;
}

/**
 * 挑候选。纯函数，方便测。
 *
 * 同话题和跨话题都看。只装同话题的那一版有个看不见的漏：同一件事被抽成两个
 * 话题名时（「本地调试环境」vs「nanobot」），两边永远比不到一起，于是互相否定的
 * 两条结论都留在 current。实测就是 bwrap 那对：5 月说「是沙箱、无 sudo」，
 * 6 月说「已移除沙箱、可用 sudo」，检索时一起返回。
 *
 * 但跨话题只看字面覆盖率分不开：那一对覆盖率只有 0.213，而全库完全不相干的条目
 * （podcastfy、算法复盘卡）也能到 0.18 —— 中文共享的二字组太多，0.2 附近分不出
 * 「同一件事」和「都在讲技术」。所以跨话题改看**稀有词命中**：讨论同一个东西时，
 * 那些有辨识度的词（bwrap、GH_CONFIG_DIR、某个仓库名）会一起出现；只在全库出现
 * ≤3 次的词才算稀有，命中一个就送模型。
 *
 * 判不判得准交给模型，这里只负责别把它挡在门外。多送一条候选的代价是几十个
 * token，漏掉一条的代价是库里永久并存两个互相否定的结论。
 */
export function pickCandidates({ news, existing, top = MAX_CANDIDATES }) {
  // 二元组和词表对每条旧条目只算一次：库里有几千条时，逐条重算是这段的性能热点。
  const pre = existing.map((e) => ({ e, key: entityKey(e.entity), bg: bigrams(e.text), tk: tokensOf(e.text) }));
  const df = new Map();
  for (const p of pre) for (const t of p.tk) df.set(t, (df.get(t) ?? 0) + 1);

  const plan = [];
  let picked = 0;
  news.forEach((n, i) => {
    const key = entityKey(n.entity);
    const nbg = bigrams(n.text);
    const rare = [...tokensOf(n.text)].filter((t) => (df.get(t) ?? 0) <= RARE_DF_MAX);
    const scored = [];
    for (const p of pre) {
      const same = p.key === key;
      let share = 0;
      for (const t of rare) if (p.tk.has(t)) share++;
      const cov = coverOf(nbg, p.bg);
      if (!same && !share && cov < CROSS_MIN_COVERAGE) continue;
      if (same && !share && cov < MIN_COVERAGE) continue;
      scored.push({ e: p.e, s: cov + (same ? SAME_ENTITY_BONUS : 0) + Math.min(share, 3) * RARE_HIT_BONUS });
    }
    scored.sort((a, b) => b.s - a.s);
    const cands = scored.slice(0, top);
    picked += cands.length;
    if (cands.length) plan.push({ i, n, cands });
  });
  return { plan, picked };
}

/**
 * @param {object} cfg
 * @param {{entity:string,text:string,brief:string}[]} news 这一场要写的条目（已归一过实体名）
 * @param {{id:string,entity:string,text:string,brief:string}[]} existing 库里同话题的旧条目
 * @returns {Promise<Map<number, {action:string, id:string}>>} 下标 → 决定
 */
export async function judgeDuplicates({ cfg, news, existing }) {
  const out = new Map();
  if (!news.length || !existing.length) return out;

  const { plan } = pickCandidates({ news, existing });
  if (!plan.length) return out;

  const lines = [];
  for (const p of plan) {
    lines.push(`【新 ${p.i + 1}】${p.n.brief || p.n.text.slice(0, 30)}`);
    lines.push(`  正文：${p.n.text.replace(/\s+/g, " ").slice(0, 260)}`);
    for (const c of p.cands) {
      lines.push(`  候选 ${c.e.id}：${c.e.brief || c.e.text.slice(0, 30)}｜${c.e.text.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }

  try {
    const r = await chat(cfg, {
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: lines.join("\n") },
      ],
      json: true,
      tag: "dedupe",
    });
    if (process.env.MEM_DEBUG) console.log("[dedupe 原文]", r.text);
    const parsed = JSON.parse(String(r.text ?? "").replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim());
    const decisions = Array.isArray(parsed?.decisions) ? parsed.decisions : [];
    const ids = new Set(existing.map((e) => e.id));
    for (const d of decisions) {
      const i = Number(d?.new) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= news.length || out.has(i)) continue;
      let match = String(d?.match ?? "").trim();
      const mine = (plan.find((p) => p.i === i)?.cands ?? []).map((c) => c.e.id);
      // 只认这条新条目的候选里出现过的 id：模型编一个 id 出来不能当数。
      if (!ids.has(match)) {
        // 模型偶尔把 id 截断（20261030101042-nn0ncq3 → 20261030101042）。
        // 前缀能唯一对上就认，对不上就当它没说——这一条会照写，不会丢内容。
        const near = mine.filter((id) => id.startsWith(match) || match.startsWith(id));
        if (near.length !== 1) continue;
        match = near[0];
      }
      if (!mine.includes(match)) continue;
      const action = d?.action === "covered" || d?.action === "replace" ? d.action : "keep";
      if (action !== "keep") out.set(i, { action, id: match });
    }
    return out;
  } catch {
    // 判重失败就当没有重复：重复一条是脏，丢一条是错。
    return out;
  }
}
