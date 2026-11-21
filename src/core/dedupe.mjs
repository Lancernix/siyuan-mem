/**
 * 入库前的判重：这条要写的记忆，库里是不是已经有了？
 *
 * 做成「一条新条目 × 一小撮候选」，而不是写完之后两两归组：模型看到一堆同话题的
 * 句子就爱按「方面」归并，把各自能独立成立的结论判成重复，删哪条都丢信息。
 *
 * 三步：挑候选（同话题按覆盖率、跨话题看稀有词、兜底用同项目）→ 一次调用让模型
 * 给出 covered / replace / keep → covered 不写，replace 写新的并把旧的标 superseded。
 *
 * 没用向量：同一份语料同一套判据下，字面 10 条召回 99%，向量 10 条只有 27%——
 * 同话题条目的余弦中位数才 0.49，真重复和不相干混在一个区间，名额还被邻居挤满。
 * 多给几个候选位置的收益，比换一整套嵌入接口大得多。
 *
 * 宁可多写一条重复，也不要少记一条：解析失败、模型含糊、候选为空，一律当 keep。
 */
import { chat } from "../util/llm.mjs";
import { event } from "../util/log.mjs";

const PROMPT = `你是记忆库的入库裁判。下面每条「新条目」后面跟着它的候选（库里已有的相关条目）。

对每条新条目，从候选里挑一条，判断它和这条是不是**说的是同一件事**：
- 同一件事：删掉其中一条不丢信息，只是换了说法或详略不同。
- 同一件事的另一种形态：讲同一个对象的同一件事，但结论相反或更新
  （例如「是沙箱」vs「已移除沙箱」）——这是新旧两个版本，按 replace 处理，别当成两条事实。
- 不是同一件事：两条各讲一个事实、各是一个决策，各自能独立成立——哪怕都关于同一个方面，也不算。
- 候选**不一定和它同话题**：同一个对象被起了两个名字、或者话题名后来改了，也会出现在候选里。
  这种恰恰要看仔细：它可能正是「旧结论已经被推翻」的那一条。

配得上「同一件事」的候选就选它；**候选里只是相关而不同的，就别硬挑一条**——
挑错对象比漏判更贵，它会把一条不相关的老条目标成过时。没有合适的就跳过这条新条目。

是同一条时，再判断留哪条：
- covered：库里那条已经把信息说完了 → 新条目不写。
- replace：新条目更全或更新（多了条件、理由、更新的结论）→ 写新的，旧的标过时。

只输出 JSON，不要解释：
{"decisions":[{"new":1,"match":2,"action":"covered"},{"new":2,"match":1,"action":"replace"}]}
不重复的新条目不要出现在结果里。new 是「新条目」的编号，match 是**这条新条目下面候选的编号**（都从 1 开始数），不是 id。
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
 * 同项目通道的字面门槛。项目名属性里本来就有，不用算也不用调模型，是最便宜的一条
 * 通道：话题名不同、字面也不像的两条，只要挂在同一个 cwd 下就值得让模型看一眼。
 * 门槛压得很松，只用来滤掉完全两回事的条目；排序仍按覆盖率，名额不会被挤爆。
 */
const SAME_PROJECT_MIN_COVERAGE = 0.1;
/**
 * 同项目通道只在别的通道没凑够候选时才用，补到这么多条为止。
 *
 * 无条件开的话，「同一个项目」这个先验太松，一个项目几百条，十个名额容易被同项目
 * 的近邻占满，把真正该看的挤下去。
 */
const PROJECT_FALLBACK_AT = 3;
/**
 * 候选给 10 条而不是 6 条：字面口径下 6 条召回 87%，10 条 99%。多给几个位置
 * 比换一套检索方式便宜得多。
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
 * 只装同话题会漏一种情况：同一件事被抽成两个话题名，两边永远比不到一起，互相否定
 * 的两条结论就都留在 current。所以跨话题也挑，但跨话题不能只看字面覆盖率——中文
 * 共享的二字组太多，0.2 附近分不出「同一件事」和「都在讲技术」。改看稀有词命中：
 * 讨论同一个东西时，有辨识度的词会一起出现，全库出现 ≤3 次的词才算稀有。
 *
 * 第三条通道是同项目（见 SAME_PROJECT_MIN_COVERAGE）。判得准不准交给模型，
 * 这里只负责别把它挡在门外。
 *
 * 每条候选带 why（命中了哪条通道），不进提示词，只给评测和排查用。
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
 * 模型给的 match 到底指哪一条候选。三种写法都认：候选编号（1 开始，最稳）、
 * 完整 id、被截断的 id。
 *
 * 编号必须优先：提示词里印的是编号，模型也很容易回编号，校验层只认 id 的话会把它
 * 当编造值扔掉，结果是「静默判定为不重复」，看起来像模型判错了。
 *
 * 截断 id 必须唯一才认：同一秒建的两条前缀一模一样，猜错比不猜更糟。
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
 * 失败必须能自己往回退：一次超时或 JSON 断了就把整块当「全都不重复」，等于把
 * 一整块决定一起丢掉，日志上还看不出是调用失败还是模型判不准。所以拆半重试，
 * 最多两层（8 → 4+4 → 2+2）；还失败才放弃并记事件。
 */
/**
 * 一块候选渲染成提示词正文。编号一律块内序号，1 开始：
 * 用全局下标的话，第二块印出【新 9】而解析端按 1..块长 校验，整块决定会被判越界丢掉。
 */

/**
 * 判重的运行期计数。
 *
 * 判重是一条会静默降级的路径：失败就当「没有重复」，于是「判重坏了」和「库里本来
 * 就没重复」在日志里长得一样。有这几个数，自检和 `mem status` 才能问出「这一小时
 * 到底判过没有」。
 */
const stats = { calls: 0, answered: 0, decisions: 0, covered: 0, replace: 0, failed: 0, crashed: 0, leafFailed: 0, lastError: "", lastAt: 0 };

export function dedupeStats() {
  return { ...stats };
}

export function resetDedupeStats() {
  Object.assign(stats, { calls: 0, answered: 0, decisions: 0, covered: 0, replace: 0, failed: 0, crashed: 0, leafFailed: 0, lastError: "", lastAt: 0 });
}

export function renderChunk(chunk) {
  const lines = [];
  chunk.forEach((p, k) => {
    lines.push(`【新 ${k + 1}】${p.n.brief || p.n.text.slice(0, 30)}`);
    lines.push(`  正文：${p.n.text.replace(/\s+/g, " ").slice(0, 260)}`);
    p.cands.forEach((c, j) => {
      lines.push(`  候选 ${j + 1}：${c.e.brief || c.e.text.slice(0, 30)}｜${c.e.text.replace(/\s+/g, " ").slice(0, 200)}`);
    });
  });
  return lines.join("\n");
}

/**
 * 把模型的 decisions 归一化成数组。
 *
 * 实测模型会给出四种形状：数组（正常）、字符串化的数组、以编号为键的对象、
 * 以及干脆漏掉外层、直接把单条裁决放在顶层。只认第一种的话，明明答了也会被
 * 当成「没答」，整批作废——这类失败看起来像模型挂了，其实是解析太窄。
 *
 * 空数组仍然按「没给」处理：哨兵要能看到「模型什么都没裁」，
 * 这跟「全都判 keep」在数据上无法区分，只能当失败。
 */
function decisionsOf(parsed) {
  let raw = parsed?.decisions ?? parsed?.decisions_list;
  if (raw == null) {
    // 顶层直接给一条裁决：{"new":1,"action":"keep"}
    if (parsed && typeof parsed === "object" && (parsed.new != null || parsed.action != null)) {
      return [parsed];
    }
    return [];
  }
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) return raw.filter((x) => x && typeof x === "object");
  if (raw && typeof raw === "object") {
    for (const key of ["items", "list", "decisions"]) {
      if (Array.isArray(raw[key])) return raw[key].filter((x) => x && typeof x === "object");
    }
    const vals = Object.values(raw).filter((x) => x && typeof x === "object");
    if (vals.length) return vals;
  }
  return [];
}

async function judgeChunk({ cfg, chunk, out, depth = 0, deadline = Number.POSITIVE_INFINITY }) {
  const lines = renderChunk(chunk).split("\n");

  /**
   * 记一次失败。两个口径要说清：
   *
   *   - 只记在 depth === 0：一次逻辑块算一次失败，拆半重试的子块不重复计，
   *     否则一个 8 条的块炸一次，status 上会显示成 8 次；
   *   - 程序错误单独记：ReferenceError / TypeError 是我们自己写错了，跟「模型没成」
   *     不是一回事。混在一起，判重坏了会被当成模型抖动藏起来。
   */
  const recordFail = (e, reason, extra = {}) => {
    const codeErr = e instanceof ReferenceError || e instanceof TypeError;
    if (depth === 0) {
      stats.lastError = String(e?.message ?? "").slice(0, 120) || reason;
      if (codeErr) stats.crashed++;
      else stats.failed++;
    } else {
      // 拆半重试的子块失败不会冒到父层（子块自己 return out 了），只报事件的话
      // status 上完全看不见。单独记一个数，不混进 failed/crashed 的口径。
      stats.leafFailed++;
    }
    event(codeErr ? "dedupe.crash" : "dedupe.failed", {
      size: chunk.length,
      reason,
      depth,
      error: e ? String(e?.message ?? e).slice(0, 100) : undefined,
      stack: codeErr ? String(e?.stack ?? "").split("\n").slice(1, 4).join(" | ").slice(0, 300) : undefined,
      ...extra,
    });
  };

  stats.calls++;
  stats.lastAt = Date.now();

  let r;
  try {
    r = await chat(cfg, {
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: lines.join("\n") },
      ],
      json: true,
      tag: "dedupe",
      deadline,
    });
  } catch (e) {
    // 调用本身就没成：超时、429、5xx、或者我们自己的代码抛了。
    //
    // 这一类**不拆半**。拆半的本意是「一次塞太多、模型挑不过来」——那是内容问题；
    // 端点在挂或者代码写错了，拆几份都是同一个结果，只会把调用数乘上叶子数。
    recordFail(e, "call");
    return out;
  }

  let parsed;
  try {
    if (process.env.MEM_DEBUG) console.log("[dedupe 原文]", r.text);
    parsed = JSON.parse(String(r.text ?? "").replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim());
  } catch (e) {
    // 解析不出来，才是「这批太大、模型开始胡说」的典型表现——拆半有意义。
    if (depth < 2 && chunk.length > 1) {
      const mid = Math.ceil(chunk.length / 2);
      await judgeChunk({ cfg, chunk: chunk.slice(0, mid), out, depth: depth + 1, deadline });
      await judgeChunk({ cfg, chunk: chunk.slice(mid), out, depth: depth + 1, deadline });
      return out;
    }
    recordFail(e, "not-json");
    return out;
  }

  const decisions = decisionsOf(parsed);
  // 拿不到可用裁决 = 链路失效。跟 JSON 解析失败同一套判断：塞太多时模型才会
  // 漏掉结构，拆半有意义；只有一条时拆无可拆，直接记失败。
  if (!decisions.length) {
    if (depth < 2 && chunk.length > 1) {
      const mid = Math.ceil(chunk.length / 2);
      await judgeChunk({ cfg, chunk: chunk.slice(0, mid), out, depth: depth + 1, deadline });
      await judgeChunk({ cfg, chunk: chunk.slice(mid), out, depth: depth + 1, deadline });
      return out;
    }
    recordFail(new Error("模型没有返回可解析的 decisions"), "no-decisions", {
      keys: Object.keys(parsed ?? {}).slice(0, 3).join(","),
    });
    return out;
  }
  if (depth === 0) stats.answered++;

  // 对上候选的条数（含 keep）。判 keep 是完全正常的结果，不能算「对不上」。
  let matched = 0;
  try {
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
    matched++;
    const action = d?.action === "covered" || d?.action === "replace" ? d.action : "keep";
    if (action !== "keep") {
      out.set(p.i, { action, id: match });
      stats.decisions++;
      if (action === "replace") stats.replace++;
      else stats.covered++;
    }
  }
  } catch (e) {
    // 裁决循环本身出错（模型给的字段形状离谱到 map 都炸）：已经落下的裁决保留，
    // 记一笔就走。让它冒出去会把整轮判重带挂，代价远大于少判几条。
    recordFail(e, "decide");
    return out;
  }
  if (decisions.length && matched === 0) {
    // 模型给了裁决、但一条都没落到候选上（编号越界、id 编的）。这同样是「判重没生效」，
    // 不能因为「模型回了东西」就算通过。
    if (depth === 0) {
      stats.failed++;
      stats.lastError = `裁决一条都对不上（模型给了 ${decisions.length} 条）`;
    }
    event("dedupe.failed", { size: chunk.length, reason: "unresolved", decisions: decisions.length });
  }
  return out;
}

export async function judgeDuplicates({ cfg, news, existing, chunkSize = MAX_NEWS_PER_CALL, deadline = Number.POSITIVE_INFINITY }) {
  const out = new Map();
  if (!news.length || !existing.length) return out;

  const { plan } = pickCandidates({ news, existing });
  if (!plan.length) return out;

  // 分块。一次塞太多新条目，模型会退化成「几乎全判 covered」；8 条一块够用，
  // 也留了余量给「一轮里混进一个特别长的会话」。
  for (let s = 0; s < plan.length; s += chunkSize) {
    await judgeChunk({ cfg, chunk: plan.slice(s, s + chunkSize), out, deadline });
  }
  return out;
}
