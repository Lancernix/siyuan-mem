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
 *   1) 从同话题的旧条目里按字面覆盖率挑前 10 条候选；
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
import { chat } from "../shared/llm.mjs";

const PROMPT = `你是记忆库的入库裁判。下面有「待写入的新条目」和每条新条目对应的「库里已有的相关条目」。

对每条新条目，判断它和候选里的某一条是不是**说的是同一件事**：
- 同一件事：删掉其中一条不丢信息，只是换了说法或详略不同。
- 不是同一件事：两条各讲一个事实、各是一个决策，各自能独立成立——
  哪怕都关于同一个方面，也不算。

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

/** 同话题、字面又不沾边的，不必送模型；0.15 是「换个说法」的下限，再低就是两回事。 */
const MIN_COVERAGE = 0.15;
/**
 * 候选给到 10 条而不是 6 条。这一条是实测出来的最大收益：
 * 6 条召回 87%，10 条 99%。条目越长（200 字口径）字面越准，多给几个位置就够了。
 */
const MAX_CANDIDATES = 10;

/** 同话题的旧条目按字面覆盖率排，取前 N。纯函数，方便测。 */
export function pickCandidates({ news, existing, top = MAX_CANDIDATES }) {
  const byEntity = new Map();
  for (const e of existing) {
    const key = String(e.entity ?? "").replace(/\s+/g, "").toLowerCase();
    const list = byEntity.get(key) ?? [];
    list.push(e);
    byEntity.set(key, list);
  }
  const plan = [];
  let picked = 0;
  news.forEach((n, i) => {
    const key = String(n.entity ?? "").replace(/\s+/g, "").toLowerCase();
    const cands = (byEntity.get(key) ?? [])
      .map((e) => ({ e, s: coverage(n.text, e.text) }))
      .filter((x) => x.s >= MIN_COVERAGE)
      .sort((a, b) => b.s - a.s)
      .slice(0, top);
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
