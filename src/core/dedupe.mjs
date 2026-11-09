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
 *   1) 从旧条目里挑前 10 条候选：同话题按覆盖率 0.15、跨话题按稀有词命中或
 *      覆盖率 0.28，前几条一条都挑不出来时才用「同项目」兜底（见 pickCandidates）；
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
import { event } from "../util/log.mjs";

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
{"decisions":[{"new":1,"match":2,"action":"covered"},{"new":2,"match":1,"action":"replace"}]}
不重复的新条目不要出现在结果里。
new 是「新条目」的编号，match 是**这条新条目下面候选的编号**（都从 1 开始数），不是 id。
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
 * 同一个项目下的两条，字面门槛压到 0.10。
 *
 * 这是第三条通道，理由是最便宜的：同一个 cwd 推出来的项目名，属性里本来就写着，
 * 不用算也不用调模型。同一个项目里的两条，即使话题名不同、字面不像，也值得让
 * 模型看一眼——「本地调试环境」和「nanobot」都挂在 ubuntu 这个项目下，正是这样一个
 * 例子（bwrap 那对还能靠稀有词命中，换成纯中文的表述就只剩这条通道救得回来）。
 *
 * 0.10 是个很松的门槛，作用是别把项目里完全两回事的条目也塞进去；排序仍然按
 * 覆盖率，真正相关的排前面，10 个名额不会被挤爆。
 */
const SAME_PROJECT_MIN_COVERAGE = 0.1;
/**
 * 同项目这条通道**只在别的通道没凑够候选时才用**，补到这么多条为止。
 *
 * 一开始它是无条件开的，跑评测才发现代价不对：34 对真实数据上召回没变（18/18），
 * 平均候选从 6.5 条涨到 8.8 条、每条多花约 300 token——因为「同一个项目」这个先验
 * 太松，一个项目几百条，10 个名额很容易被同项目的近邻占满，把真正该看的挤下去。
 *
 * 所以改成兜底：先按前两条通道挑，挑不到 3 条才拿同项目来补。bwrap 那类「同一件事
 * 被起了两个话题名、又没有共享英文词」的情况，正因为别的通道一条都挑不出来才落进
 * 这里——兜底正好用在对的地方，活跃话题上的常规判重一点成本都不多付。
 */
const PROJECT_FALLBACK_AT = 3;
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
 * 第三条通道是**同项目**：同一个 cwd 下的两条即使话题名、字面都不像也送（理由
 * 见 SAME_PROJECT_MIN_COVERAGE）。
 *
 * 判不判得准交给模型，这里只负责别把它挡在门外。多送一条候选的代价是几十个
 * token，漏掉一条的代价是库里永久并存两个互相否定的结论。
 *
 * 每条候选带一个 why（命中了哪些通道），判重时不进提示词，只给评测脚本和排查用：
 * 想调门槛时，得先知道是哪条通道把真重复捞回来的、又是哪条把噪音放进去的。
 */
export function pickCandidates({ news, existing, top = MAX_CANDIDATES }) {
  // 二元组和词表对每条旧条目只算一次：库里有几千条时，逐条重算是这段的性能热点。
  const pre = existing.map((e) => ({
    e,
    key: entityKey(e.entity),
    proj: String(e.project ?? "").trim().toLowerCase(),
    bg: bigrams(e.text),
    tk: tokensOf(e.text),
  }));
  const df = new Map();
  for (const p of pre) for (const t of p.tk) df.set(t, (df.get(t) ?? 0) + 1);

  const plan = [];
  let picked = 0;
  news.forEach((n, i) => {
    const key = entityKey(n.entity);
    const proj = String(n.project ?? "").trim().toLowerCase();
    const nbg = bigrams(n.text);
    const rare = [...tokensOf(n.text)].filter((t) => (df.get(t) ?? 0) <= RARE_DF_MAX);
    const scored = [];
    for (const p of pre) {
      const same = p.key === key;
      const hitRare = [];
      for (const t of rare) if (p.tk.has(t)) hitRare.push(t);
      const cov = coverOf(nbg, p.bg);
      // 主通道只有两条：同话题（0.15）、跨话题（0.28）；有共享稀有词则直接进。
      // 「同项目」不在这里——它是兜底，见下面 PROJECT_FALLBACK_AT。
      const floor = same ? MIN_COVERAGE : CROSS_MIN_COVERAGE;
      if (!hitRare.length && cov < floor) continue;
      const why = [];
      if (same) why.push("同话题");
      if (hitRare.length) why.push(`稀有词:${hitRare.slice(0, 3).join(",")}`);
      why.push(`覆盖${cov.toFixed(2)}`);
      scored.push({
        e: p.e,
        s: cov + (same ? SAME_ENTITY_BONUS : 0) + Math.min(hitRare.length, 3) * RARE_HIT_BONUS,
        why,
      });
    }
    scored.sort((a, b) => b.s - a.s);
    let cands = scored.slice(0, top);
    // 兜底：上面三条给得太少（0～2 条），说明这条新条目在库里几乎没有近邻，
    // 这时候「同项目」是唯一还能提供线索的东西。
    if (cands.length < PROJECT_FALLBACK_AT && proj) {
      const have = new Set(cands.map((c) => c.e.id));
      const fill = pre
        .filter((p) => p.proj === proj && !have.has(p.e.id))
        .map((p) => {
          const cov = coverOf(nbg, p.bg);
          return { e: p.e, s: cov, why: ["同项目兜底", `覆盖${cov.toFixed(2)}`] };
        })
        .filter((c) => c.s >= SAME_PROJECT_MIN_COVERAGE)
        .sort((a, b) => b.s - a.s)
        .slice(0, Math.max(0, PROJECT_FALLBACK_AT - cands.length));
      cands = cands.concat(fill);
    }
    picked += cands.length;
    if (cands.length) plan.push({ i, n, cands });
  });
  return { plan, picked };
}

/**
 * @param {object} cfg
 * @param {{entity:string,text:string,brief:string}[]} news 这一场要写的条目（已归一过实体名）
 * @param {{id:string,entity:string,text:string,brief:string,project?:string}[]} existing 库里的旧条目（全库，不用预先按话题筛）
 * @returns {Promise<Map<number, {action:string, id:string}>>} 下标 → 决定
 */
/** 判重一次最多判几条新条目。 */
const MAX_NEWS_PER_CALL = 8;

/**
 * 模型给的 match 到底指哪一条候选。
 *
 * 三种写法都认：**候选编号**（1 开始，最稳）、完整 id、被截断的 id（前缀唯一才认）。
 *
 * 为什么编号优先：提示词一开始让模型回「候选编号」，而候选行上印的却是 20 位 id，
 * 示例里又给了个数——模型于是两种都回。回编号的那次，校验层只认 id，把它当成编造的
 * 值扔掉，结果是「静默判定为不重复」：不报错、不回滚，重复条目照写。实测 10 对里
 * 至少有 1 对是这么丢的，而它看起来像「模型判错了」。
 *
 * 截断 id 那条路要**唯一**才认：同一秒建的两条 id 前缀一模一样，猜错比不猜更糟。
 */
export function resolveMatch(match, ids) {
  const m = String(match ?? "").trim();
  if (!m) return "";
  if (ids.includes(m)) return m;
  if (/^\d+$/.test(m)) {
    const n = Number(m);
    if (n >= 1 && n <= ids.length) return ids[n - 1];
  }
  const near = ids.filter((id) => id.startsWith(m) || m.startsWith(id));
  return near.length === 1 ? near[0] : "";
}

/**
 * 一批候选送一次模型。编号在每一块内部重新从 1 开始。
 *
 * 失败**必须能自己往回退**：一次调用超时或者返回的 JSON 断了，原来直接把整块当
 * 「全都不重复」——8 条、16 条的决定一起丢掉，而且日志上什么都没留下。实测评测里
 * 有一整块（8 对全对的数据）就是这么丢的，看起来像「模型判不准」，其实是调用失败。
 *
 * 所以拆半重试，最多两层（8 → 4+4 → 2+2）；还失败的才放弃，并记一条事件。
 * 方向仍然是「宁可多写一条」——但这次留下痕迹。
 */
async function judgeChunk({ cfg, chunk, out, depth = 0 }) {
  const lines = [];
  for (const p of chunk) {
    lines.push(`【新 ${p.i + 1}】${p.n.brief || p.n.text.slice(0, 30)}`);
    lines.push(`  正文：${p.n.text.replace(/\s+/g, " ").slice(0, 260)}`);
    p.cands.forEach((c, k) => {
      lines.push(`  候选 ${k + 1}：${c.e.brief || c.e.text.slice(0, 30)}｜${c.e.text.replace(/\s+/g, " ").slice(0, 200)}`);
    });
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
    for (const d of decisions) {
      // 模型看到的是块内的局部编号，先落回全局下标。
      const n = Number(d?.new);
      if (!Number.isInteger(n) || n < 1 || n > chunk.length) continue;
      const p = chunk[n - 1];
      if (out.has(p.i)) continue;
      const ids = p.cands.map((c) => c.e.id);
      const match = resolveMatch(d?.match, ids);
      // 只认这条新条目自己候选里的东西：模型编一个 id 出来不能当数。
      if (!match) continue;
      const action = d?.action === "covered" || d?.action === "replace" ? d.action : "keep";
      if (action !== "keep") out.set(p.i, { action, id: match });
    }
    return out;
  } catch (e) {
    if (depth < 2 && chunk.length > 1) {
      const mid = Math.ceil(chunk.length / 2);
      await judgeChunk({ cfg, chunk: chunk.slice(0, mid), out, depth: depth + 1 });
      await judgeChunk({ cfg, chunk: chunk.slice(mid), out, depth: depth + 1 });
      return out;
    }
    // 判重失败就当没有重复：重复一条是脏，丢一条是错。但要在日志里留一条，
    // 不然「判重一直没生效」和「库里本来就没有重复」看起来一模一样。
    event("dedupe.failed", { size: chunk.length, error: String(e?.message ?? e).slice(0, 100) });
    return out;
  }
}

export async function judgeDuplicates({ cfg, news, existing, chunkSize = MAX_NEWS_PER_CALL }) {
  const out = new Map();
  if (!news.length || !existing.length) return out;

  const { plan } = pickCandidates({ news, existing });
  if (!plan.length) return out;

  // 分块。一次性把 34 条新条目塞进去试过：模型会退化成「几乎全判 covered」，
  // 分批才恢复正常。线上一个会话通常几条到十几条，8 条一块已经够用，
  // 也留了余量给「一轮里混进一个特别长的会话」。
  for (let s = 0; s < plan.length; s += chunkSize) {
    await judgeChunk({ cfg, chunk: plan.slice(s, s + chunkSize), out });
  }
  return out;
}
