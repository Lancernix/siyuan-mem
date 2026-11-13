/**
 * 召回：给一句话，返回最相关的若干条记忆（正文、话题、摘要、日期、原文指针）。
 *
 * 用 SQL LIKE 而不是向量或 FTS：语料是中文短条目，子串匹配本来就够用；要过滤的
 * status / entity 都在 ial 属性里，走 FTS 反而多一跳；几千条的量级扫一遍是毫秒级。
 *
 * 排序看三件事：词命中次数、话题是否命中、日期新旧。
 * 判重那套（bigram + 模型）在这儿没用——那判的是「是不是同一件事」。
 */
import { loadConfig } from "../util/config.mjs";
import { SiYuan, resolveNotebookId } from "../util/siyuan.mjs";
import { event } from "../util/log.mjs";
import { normalizeSource } from "../util/source.mjs";
import { stripRawLink } from "../util/raw.mjs";
import { loadEntities, topicNames, findCandidates } from "./entities.mjs";

const ATTR = {
  hash: "custom-mem-hash",
  status: "custom-mem-status",
  entity: "custom-mem-entity",
  brief: "custom-mem-brief",
  date: "custom-mem-date",
  type: "custom-mem-type",
  confidence: "custom-mem-confidence",
  raw: "custom-mem-raw",
  session: "custom-mem-session",
  source: "custom-mem-source",
  project: "custom-mem-project",
};

const attr = (ial, k) => new RegExp(k + '="([^"]*)"').exec(ial ?? "")?.[1] ?? "";
const plain = (s, raw = "") => stripRawLink(s, raw);

/**
 * 拼进 LIKE 前转义：单引号，以及 `%` `_` `\` 三个通配符。不转义的话
 * `mem search %` 会变成全表匹配，而且看不出是查询串的锅。配套 ESCAPE 写在 SQL 里。
 */
export function likeEsc(s) {
  return String(s).replace(/[\\%_]/g, (c) => "\\" + c).replace(/'/g, "''");
}


/**
 * 把一句话拆成检索词。两阶段，顺序不能反：
 *
 *  1) ASCII 标识符整体保留（`NO.2` / `etc/nginx.conf` / `node:22-alpine`）——
 *     它们是模型编不出来的硬锚，切成 `NO` + `5` 就废了；
 *  2) 剩下的连续汉字切 2-gram。不分词的话整句是一个词，SQL 要求整句连续出现，
 *     稍长一点的问法必然 0 命中。
 *
 * 返回全部词（含虚词）。哪些能当证据，交给 strongTerms 判。
 */
export function termsOf(q) {
  const s = String(q ?? "");
  const out = [];
  const push = (t) => {
    if (t && !out.includes(t)) out.push(t);
  };
  const rest = s.replace(/[A-Za-z0-9_][A-Za-z0-9_./:\-]*/g, (m) => {
    const t = m.replace(/^[-./:]+|[-./:]+$/g, "");
    if (t.length >= 2 && !/^(the|and|for|with|that|this)$/i.test(t)) push(t);
    return " ";
  });
  for (const p of rest.split(/[\s，。、；：？！,.;:?!()（）\[\]【】"'“”‘’/|]+/).map((x) => x.trim())) {
    if (!p) continue;
    if (/^[\u4e00-\u9fa5]+$/.test(p) && p.length >= 3) {
      for (let i = 0; i + 2 <= p.length; i++) push(p.slice(i, i + 2));
    } else if (!/^\d$/.test(p) && !/^[a-z]$/i.test(p)) {
      push(p);
    }
  }
  // 16 是 2-gram 之后的上限：整句十几个字会切成十几个词，帽子太小会把后半句截掉。
  // SQL 是 OR 宽筛，多几个词只多几个 LIKE。
  return out.slice(0, 16);
}

/**
 * 虚字。判定规则是**全部字都虚**才算虚词组合。
 *
 * 不能按「沾一个虚字就算」：那会把「性能 / 时间 / 会议 / 上限」整批误杀，
 * 强词集一空，门槛就失效了（`会议时间` 能命中任何提到「时间」的条目）。
 * 虚词组合的本质是两个字都不承载信息，而「会议」里有一个实字就够当证据。
 */
const WEAK_HAN = new Set(
  "的我你他她它们这那其之是了在有着就都也还很不太没要把被给从向对与和或而但如若因为所以什怎哪多些个上下来去时会能可又再已曾经最更只才什么样呢吗啊吧让使并等几第每各另某该此".split("")
);

const HAN_ONLY = /^[\u4e00-\u9fa5]+$/;

/**
 * 提问框架词：描述「怎么问」，不承载「找什么」。
 *
 * 「一次 / 需要 / 大概 / 多少」里都有实字，靠虚字规则挡不住，但它们在正文里俯拾皆是，
 * 参与「必须命中」的判定就会把不相干的条目捞进来。只列高频的：漏一个只是多点噪声，
 * 多列一个实词会真丢召回。
 */
const WEAK_GRAMS = new Set(
  ("一次 一下 一些 一点 一个 一直 一般 一样 一起 一共 " +
    "需要 可以 可能 应该 必须 不要 不用 不能 不会 不是 不过 不同 不行 " +
    "多少 多久 多大 多长 几个 几天 几次 哪些 哪个 哪里 " +
    "大概 大约 也许 或者 还是 而是 而且 但是 因为 所以 如果 虽然 然后 " +
    "这个 那个 这些 那些 这样 那样 什么 怎么 怎样 如何 为什么 " +
    "现在 已经 正在 曾经 刚才 之后 之前 以后 以前 时候 当时 " +
    "还有 没有 只是 就是 也是 都是 会有 要有 才能 就会 时候").split(/\s+/).filter(Boolean)
);

/** 强词 = ASCII 标识符，或不是「全部字都虚」的中文片段。 */
export function strongTerms(terms) {
  return terms.filter((t) => {
    if (/^[a-z0-9_./:\-]+$/i.test(t)) return t.length >= 3;
    if (!HAN_ONLY.test(t)) return false;
    if (WEAK_GRAMS.has(t)) return false;            // 提问框架词：不区分主题
    return ![...t].every((ch) => WEAK_HAN.has(ch)); // 全虚才弱
  });
}

/**
 * 查询计划。minShould 是「至少命中几个强词」：关键词问法只有两个词，要求全中；
 * 整句切成十来个 2-gram 只要求两个，从「必然 0 命中」放宽到「沾边就进候选」。
 * 这一步只修查询理解，不动排序权重。
 */
export function queryPlan(q) {
  const terms = termsOf(q);
  const strong = strongTerms(terms);
  // 查询里点名的标识符是硬约束：用户写 `NO.9` 就是为了找它，只靠两个强词共现会被
  // NO.5 的条目用「品牌 + 价格」蒙过去。但「标识符」按形态判，不按「是不是英文」——
  // skill / vite 这种普通词也能硬卡的话，讲容器却没写 docker 的条目会被全挡掉。
  const anchors = terms.filter(isAnchorTerm);
  // 日期是范围限定，不是主题词。算进门槛的话，任何一条 2026 年记下的条目都能靠
  // 「2026」过闸，查「2026 年的部署计划」会捞回一堆只在当年记过、跟部署无关的东西。
  const dates = strong.filter(isDateTerm);
  const words = strong.filter((t) => !isDateTerm(t));
  // 有标识符时门槛降到 1（标识符本身已是硬约束），否则要 2 个词共现挡虚词灌水。
  const minShould = words.length ? (anchors.length ? 1 : Math.min(2, Math.max(1, words.length))) : 1;
  // 一个实词都没有（「怎么样」这类）：不许退回虚词 + 门槛 1，那等于关掉闸门。
  const meaningful = strong.length > 0 || anchors.length > 0;
  return { terms, strong, anchors, dates, words, minShould, meaningful };
}

/**
 * 日期形态的词：年 / 年月 / 完整日期（`2026`、`2026-11`、`2026-11-06`）。
 *
 * 整段认，因为这类词唯一可能落的地方是 date 属性，正文里通常不写；漏认的话
 * 它会被当成普通锚——是锚却不查 date，候选池直接空。
 * `NO.2026` 这类型号整词不匹配，不会被误当日期。
 */
export function isDateTerm(t) {
  return /^(19|20)\d{2}([-/]\d{1,2}([-/]\d{1,2})?)?$/.test(String(t ?? ""));
}

/** 日期统一成 `2026-11-06` 再比：库里存的是短横线，用户可能写 `2026/11/06`。 */
const dateNorm = (t) => String(t).replace(/[/.]/g, "-");

/**
 * 日期 → 数字段。日期比较的唯一入口：内存比较、SQL 拼串、正文兜底都走这里，
 * 免得一处补零一处不补。
 */
export function dateSegments(v) {
  const parts = dateNorm(v).split("-").filter(Boolean).map(Number);
  return parts.length && parts.every((n) => Number.isFinite(n)) ? parts : [];
}

/**
 * 条目日期是否落在查询范围内：`2026` 管全年、`2026-11` 管整月、`2026-11-06` 管当天。
 *
 * 按段比数值，不能拿字符串 startsWith：库里补零存 `2026-01-15`，而
 * `"2026-11-06".startsWith("2026-1")` 是 true——查 1 月会返回 11、12 月。
 */
export function dateMatches(date, term) {
  const d = dateSegments(date);
  const t = dateSegments(term);
  if (!d.length || !t.length) return false;
  return t.every((n, i) => i < d.length && d[i] === n);
}

/**
 * 日期词 → SQL LIKE 写法。库里的 date 补零存（`2026-11-06`），所以 `2026-1` 得按
 * `2026-01` 去找。同时保留不补零的写法，兜住模型没补零的日期；多捞的候选由
 * dateMatches 收 —— 宁可宽，不可漏。
 */
export function dateLikePatterns(term) {
  const t = dateSegments(term);
  if (!t.length) return [];
  const pad = (n) => String(n).padStart(2, "0");
  const padded = [t[0], t[1] == null ? null : pad(t[1]), t[2] == null ? null : pad(t[2])]
    .filter((v) => v !== null)
    .join("-");
  const raw = t.join("-");
  return padded === raw ? [padded] : [padded, raw];
}

/**
 * 日期是不是真的写在正文里（少数条目会重复写一遍）。先把正文里的日期串抓出来
 * 再逐段比，不能直接 includes：`2026-11-11` 包含 `2026-1`，查 1 月会误命中 11 月。
 */
export function dateInText(hay, term) {
  const tokens = dateNorm(hay).match(/(?<!\d)(?:19|20)\d{2}(?:-\d{1,2}){0,2}/g) ?? [];
  return tokens.some((t) => dateMatches(t, term));
}

/**
 * 这个词像不像「模型编不出来」的标识符。判据是形态：带内部标点、大小写混排、
 * 或全大写。纯小写普通词（skill / vite）当锚会把召回卡死。
 */
export function isAnchorTerm(t) {
  const x = String(t ?? "");
  if (!/^[A-Za-z0-9_./:\-]+$/.test(x)) return false;
  if (x.length < 3) return false;
  if (/[._/:\-]/.test(x.slice(1))) return true;      // 内部有标点（首字符的 - 不算）
  if (/[A-Z]/.test(x) && /[a-z]/.test(x)) return true; // 大小写混排
  if (/^[A-Z0-9]+$/.test(x)) return true;            // 全大写 / 大写+数字
  return false;
}

/**
 * 「标识符必须在」这道闸。
 *
 * 日期锚不参加：`NO.9 2026 价格` 里 `2026` 会单独满足 `.some()`，型号约束就静默失效，
 * NO.5 的条目照样能进来。日期由 dateOk 单独管。锚全被剔掉（纯日期查询）时放行。
 */
export function entryMatchesAnchors({ text, brief, entity }, anchors) {
  const real = (anchors ?? []).filter((a) => !isDateTerm(a));
  if (!real.length) return true;
  return anchorsHit(`${text} ${brief} ${entity}`, real);
}

/** 查询里有标识符时，必须至少命中一个；没有标识符就不设这条约束。 */
export function anchorsHit(hay, anchors) {
  if (!anchors?.length) return true;
  const low = String(hay ?? "").toLowerCase();
  return anchors.some((a) => low.includes(String(a).toLowerCase()));
}

/**
 * 数一条候选命中了几个不同的强词。只看正文、摘要、话题，不看 ial 里的原文路径。
 * 这是挡住虚词灌水的那道闸，别内联回去。
 */
export function strongHits(hay, gate) {
  const low = String(hay ?? "").toLowerCase();
  return gate.reduce((n, t) => n + (low.includes(String(t).toLowerCase()) ? 1 : 0), 0);
}

/**
 * 排序权重，唯一真源：scripts/eval-rank.mjs 直接 import 它做 A/B，别在两处各写一套。
 *
 * brief 高于正文单次命中：摘要是模型压过的一句结论，命中它比正文里多重复几次
 * 更能说明「这条就在讲这件事」。
 */
export const RANK_WEIGHTS = Object.freeze({
  textPerHit: 2,  // 正文里这个词每出现一次
  textCap: 5,     // 同一个词最多算 5 次：挡住「反复念叨」刷分
  entity: 6,      // 话题名命中
  brief: 5,       // 摘要命中
  daily: 0.08,    // 每天 -0.08
  cap: 8,         // 时间惩罚最多 -8，约 100 天打满
});

/**
 * 相关度，不含时间惩罚。单独拆出来当召回下限：SQL 是在整个 ial 上 LIKE 的，
 * 词落在原文路径里也能成为候选，但相关度 0 的一律不算命中。
 */
export function relevanceOf(row, terms, entity) {
  const text = row.text ?? "";
  let rel = 0;
  for (const t of terms) {
    const lower = t.toLowerCase();
    const inText = text.toLowerCase().split(lower).length - 1;
    rel += Math.min(inText, RANK_WEIGHTS.textCap) * RANK_WEIGHTS.textPerHit;
    if (String(entity).toLowerCase().includes(lower)) rel += RANK_WEIGHTS.entity;
    if (String(row.brief).toLowerCase().includes(lower)) rel += RANK_WEIGHTS.brief;
  }
  return rel;
}

export function scoreOf(row, terms, entity) {
  let score = relevanceOf(row, terms, entity);
  // 时间惩罚：一天 -0.08，最多 -8（约 100 天打满）。
  //
  // 封顶 8 是刻意的：14 会把超过半年的条目全压到负分，连定稿的设计决策都翻不了身。
  // 8 分约等于四次词频，刚好让「旧但啰嗦」输给「新而简短」，又不至于让旧知识沉底。
  // 真矛盾的条目该标 superseded，不靠排序解决。
  const days = row.date ? Math.max(0, (Date.now() - Date.parse(row.date + "T00:00:00")) / 86400000) : 60;
  score -= Math.min(days * RANK_WEIGHTS.daily, RANK_WEIGHTS.cap);
  return score;
}

/**
 * 进程内只做一次的格式自检。
 *
 * 切原文路径靠一个约定：思源把 `[原文](assets/…)` 渲染成纯文本 ` 原文 assets/…`。
 * 它哪天改了渲染方式，切分就静默失效、召回悄悄变差。看到「有路径但切不掉」的样本
 * 就留一条事件，不修数据。
 */
let formatChecked = false;
function checkBodyFormat(rows) {
  if (formatChecked || !rows?.length) return;
  const sample = rows.find((r) => String(r.content ?? "").includes("assets/mem-raw/"));
  // 这次候选里没样本不代表以后也没有。先置位的话，第一次查询（常常是空结果）
  // 就把自检永久消耗掉了，格式漂移再也不会被发现。
  if (!sample) return;
  formatChecked = true;
  if (!String(sample.content).includes(" 原文 assets/")) {
    event("search.format_drift", {
      tail: String(sample.content).slice(-140),
    });
  }
}

/**
 * 检索，返回按相关度排好的条目。
 *
 * @param {{q:string, limit?:number, topic?:string, type?:string, status?:string, days?:number}} opts
 */
export async function searchEntries(opts = {}) {
  const { terms, strong, anchors, dates, minShould, meaningful } = queryPlan(opts.q);
  const limit = Math.min(Math.max(Number(opts.limit) || 8, 1), 50);
  // 「没问出词」也要留事件：不记的话状态页那一栏永远是 0，看起来没人问废话，
  // 实际只是没人记。
  const earlyExit = (reason, shown) => {
    if (!opts.silent)
      event("memory.miss", {
        q: String(opts.q ?? "").slice(0, 60),
        terms: shown,
        source: normalizeSource(opts.source),
        reason,
      });
    // 早退没跑打分，scoreTerms 给空数组：下游要能无条件读它。
    return { terms: shown, scoreTerms: [], hits: [], reason };
  };
  // 早退放在碰后端之前：没东西可查时，思源死活不影响答案，先连一遍只会在后端
  // 故障时把「你问了句废话」伪装成「检索失败」。
  // 全是标点/空白时不能往下走：SQL 里没有 LIKE 条件，结果会变成「最新 N 条」。
  if (!terms.length) return earlyExit("no-terms", []);
  // 整句全是虚词：没有任何可定位的证据，返回什么都算瞎猜。terms 留着，
  // 调用方要靠它说清「这几个词不承载信息」。
  if (!meaningful) return earlyExit("no-meaningful-terms", terms);

  const cfg = loadConfig();
  const sy = new SiYuan({ baseUrl: cfg.siyuan.baseUrl, token: cfg.siyuan.token, timeoutMs: 8000 });
  const notebook = await resolveNotebookId(sy, cfg);
  // SQL 层做 OR 粗筛用的词。走到这里至少有一组可用：强词，或者标识符。
  const gate = strong.length ? strong : anchors;
  // 参与正文匹配的词：日期摘出去，它只对 date 生效。
  const wordGate = dates.length ? gate.filter((t) => !isDateTerm(t)) : gate;

  const conds = [`box='${notebook}'`, "type='p'", `ial LIKE '%${ATTR.hash}="%'`];
  // status 传空串表示「过时的也要」。必须白名单：它会拼进 SQL，而 /api/search
  // 把外部请求的 status 原样透传进来，`x' OR 1=1 --` 能绕过 box 收口去读全库。
  const status = opts.status === "" ? "" : opts.status || "current";
  if (status && status !== "current" && status !== "superseded") {
    throw new Error(`status 只能是 current / superseded / 空，收到「${String(status).slice(0, 30)}」`);
  }
  if (status) conds.push(`ial LIKE '%${ATTR.status}="${status}"%'`);
  // 话题过滤必须走实体表解析：条目上的 entity 是写入当时的名字，人记住的常是
  // 别名或合并前的旧名，拿字面量直接匹配会把它们判成「这个话题没内容」。
  let topicNote = null;
  if (opts.topic) {
    let resolved = { found: false, canonical: "", names: [] };
    let tableUnavailable = false;
    try {
      const table = loadEntities({ strict: true });
      if (table === null) tableUnavailable = true;
      else resolved = topicNames(table, opts.topic);
    } catch {
      // topicNames 也能因为表里字段形状不对而抛，同样算「表不可用」。
      tableUnavailable = true;
    }
    const names = resolved.found ? resolved.names : [opts.topic];
    const ors = names.map((n) => `ial LIKE '%${ATTR.entity}="${likeEsc(n)}"%' ESCAPE '\\'`);
    conds.push(`(${ors.join(" OR ")})`);
    // known 三态：false = 表正常但没这个话题；undefined = 表读不出来、只做了
    // 字面匹配。后者不能说成「没有这个话题」。
    if (!resolved.found)
      topicNote = {
        asked: String(opts.topic),
        canonical: "",
        matched: [],
        known: tableUnavailable ? undefined : false,
      };
    else
      topicNote = {
        asked: String(opts.topic),
        canonical: resolved.canonical,
        matched: resolved.canonical === String(opts.topic) ? [] : [resolved.canonical],
        known: true,
      };
  }
  if (opts.project) conds.push(`ial LIKE '%${ATTR.project}="${likeEsc(opts.project)}"%' ESCAPE '\\'`);
  if (opts.type) conds.push(`ial LIKE '%${ATTR.type}="${likeEsc(opts.type)}"%' ESCAPE '\\'`);
  // days 不在 SQL 里比：ial 里是字符串，拿回内存里筛更直接。
  const since = opts.days
    ? new Date(Date.now() - Number(opts.days) * 86400000).toISOString().slice(0, 10)
    : "";
  // SQL 只做 OR 粗筛：命中任何一个强词就进候选。精确性交给内存里的两道闸
  // （rel > 0、strongHit >= minShould）。宁可宽不可漏 —— 宽了多捞候选，
  // 漏了是真丢召回。
  //
  // ial 是一串 `key="value"`，LIKE 的 `%` 会跨过收尾引号，所以词落在 raw 路径里
  // 也会命中；这个 SQLite 不认 GLOB 字符类取反，卡不住，只能靠内存收。
  //
  // 正文尾巴要切：条目是「结论 原文 assets/…」，不切的话查 jsonl 会捞回全库。
  const bodyExpr =
    "(CASE WHEN instr(content, ' 原文 assets/') > 0 " +
    "THEN substr(content, 1, instr(content, ' 原文 assets/') - 1) ELSE content END)";
  const ors = gate.map((t) => {
    const esc = likeEsc(t);
    const fields = [ATTR.entity, ATTR.brief, ATTR.project, ATTR.type].map(
      (k) => `ial LIKE '%${k}="%${esc}%' ESCAPE '\\'`
    );
    // 日期只在 date 属性里，正文通常不写，所以单独给它加一个字段。只给日期词加，
    // 不给所有词加：否则查「11」会命中所有 11 月记的条目。
    if (isDateTerm(t)) {
      const pats = dateLikePatterns(t).map(
        (x) => `ial LIKE '%${ATTR.date}="%${likeEsc(x)}%' ESCAPE '\\'`
      );
      fields.push(`(${pats.join(" OR ")})`);
    }
    return `(${bodyExpr} LIKE '%${esc}%' ESCAPE '\\' OR ${fields.join(" OR ")})`;
  });
  conds.push(`(${ors.join(" OR ")})`);

  // 这是取候选的上限，不是结果数。给小了会静默漏召回：排序和过滤都在内存里做，
  // 被 SQL 砍掉的再也回不来。
  let rows;
  try {
    rows = await sy.sql(
      `SELECT id, content, ial FROM blocks WHERE ${conds.join(" AND ")}
         ORDER BY updated DESC LIMIT 5000`
    );
  } catch (e) {
    // 后端坏了不是「没记过」：返回 failed 让调用方说「检索失败」，
    // 渲染成「没找到」比报错更糟，因为它看起来像答案。
    if (!opts.silent)
      event("memory.miss", {
        q: String(opts.q ?? "").slice(0, 60),
        terms: gate,
        source: normalizeSource(opts.source),
        reason: "backend-error",
        error: String(e?.message ?? e).slice(0, 120),
      });
    return {
      terms: gate,
      scoreTerms: wordGate,
      hits: [],
      failed: true,
      reason: "backend-error",
      detail: String(e?.message ?? e).slice(0, 200),
    };
  }
  checkBodyFormat(rows);
  if (!Array.isArray(rows)) {
    // 和主路径同一口径：silent 不记事件，来源要带上。
    if (!opts.silent)
      event("memory.miss", {
        q: String(opts.q ?? "").slice(0, 60),
        terms: gate,
        source: normalizeSource(opts.source),
        reason: "sql-not-array",
      });
    return { terms: gate, scoreTerms: wordGate, hits: [], failed: true, reason: "sql-not-array" };
  }
  // 撞到上限说明可能有召回被截断，留一条痕，否则「查不到」永远查不出原因。
  if (rows.length >= 5000) event("search.truncated", { q: String(opts.q ?? "").slice(0, 60), terms, rows: rows.length });

  const hits = rows
    .map((r) => {
      const entity = attr(r.ial, ATTR.entity);
      const brief = attr(r.ial, ATTR.brief);
      const date = attr(r.ial, ATTR.date);
      const raw = attr(r.ial, ATTR.raw);
      // 先切原文路径再算分：不切的话，同一场会话的条目会因为共用同一串路径
      // 而互相「像」，排序变成「按会话聚堆」。
      const text = plain(r.content, raw);
      const hay = `${text} ${brief} ${entity}`;
      // 日期是过滤器：日期不对的条目直接不要，也不能靠它凑门槛。
      const dateOk = !dates.length || dates.some((d) => dateMatches(date, d) || dateInText(hay, d));
      const strongHit = wordGate.length ? strongHits(hay, wordGate) : dateOk ? 1 : 0;
      // 锚校验和强词命中都不看 date：让「2026」给所有当年条目加分是错的。
      const anchorOk = entryMatchesAnchors({ text, brief, entity }, anchors);
      const rel = relevanceOf({ text, brief }, wordGate, entity);
      return {
        id: r.id,
        entity,
        brief,
        date,
        type: attr(r.ial, ATTR.type),
        confidence: attr(r.ial, ATTR.confidence),
        text,
        raw,
        session: attr(r.ial, ATTR.session),
        source: attr(r.ial, ATTR.source),
        project: attr(r.ial, ATTR.project),
        // 打分只用强词：虚词 2-gram 到处都有，会把真正的排序信号淹掉。
        score: scoreOf({ text, brief, date }, wordGate, entity),
        rel,
        // 纯日期查询正文里没有词，rel 天然是 0，改由 dateOk 说话。
        relOk: wordGate.length ? rel > 0 : dateOk,
        strongHit,
        anchorOk,
        dateOk,
      };
    })
    // 三道闸：相关度 > 0、强词够数、点名的标识符确实在。最后一条挡的是
    // 「问 NO.9 却拿 NO.5 来答」——那种结果比空手更糟，它看起来是答案。
    .filter((h) => h.relOk && h.strongHit >= minShould && h.anchorOk && h.dateOk)
    .filter((h) => !since || (h.date && h.date >= since))
    .sort((a, b) => b.score - a.score || String(b.date ?? "").localeCompare(String(a.date ?? "")))
    .slice(0, limit);

  // 记一次命中，按话题去重。这是「这条记忆还活着」的唯一真实信号。
  // silent 给评测用：几百条查询全记成 hit 的话，这个信号就被评测自己灌满了。
  try {
    const topics = opts.silent ? [] : [...new Set(hits.map((h) => h.entity).filter(Boolean))];
    // 条件是 hits.length 不是 topics.length：没打 entity 的条目命中也要计数，
    // 否则「召回被用过几次」会偏低。
    if (hits.length && !opts.silent)
      event("memory.hit", {
        q: String(opts.q ?? "").slice(0, 60),
        topics,
        n: hits.length,
        // 来源分开记：CLI 是人在调试，MCP 是 agent 在用，api 是别的机器。
        // 混在一起就答不了「这套东西到底有没有被用起来」。
        source: normalizeSource(opts.source),
      });
  } catch {
    /* 日志失败不影响检索 */
  }

  // 零结果最值得记：召回不准时，「查过什么、什么都没查到」是唯一线索。
  // 评测不能记，否则题库跑一遍就灌进几十条假空手，把真实空手率搞脏。
  let hint = "";
  if (!hits.length && !opts.silent) {
    event("memory.miss", {
      q: String(opts.q ?? "").slice(0, 60),
      terms,
      source: normalizeSource(opts.source),
      topic: opts.topic ?? "",
      project: opts.project ?? "",
      rows: rows.length,
      // 四态分明：null = 没传话题；true/false = 表正常；"unavailable" = 表读不出来。
      topicKnown: topicNote ? (topicNote.known === undefined ? "unavailable" : topicNote.known) : null,
      // 明确写出来：状态页按 reason 分桶，缺省值不能背「后端故障」的锅。
      reason: "no-match",
    });
    // 话题名没解析到 ≠ 这个话题没内容。不给提示的话，人只会觉得库是空的然后瞎猜名字。
    if (topicNote && topicNote.known === undefined) {
      // 表坏了/丢了：按字面查了，但别名和合并旧名都没展开，别说成「库里没有」。
      hint = `实体表读不出来，这次按字面匹配「${topicNote.asked}」；别名和已合并的旧名可能查不到。`;
      event("search.entities_unavailable", { topic: topicNote.asked });
    } else if (topicNote && !topicNote.known) {
      let near = [];
      try {
        near = findCandidates(topicNote.asked, loadEntities(), { limit: 3 }).map((c) => c.entity.name);
      } catch {
        /* 表读不出来就不提示 */
      }
      hint = near.length
        ? `没有「${topicNote.asked}」这个话题。最接近的是：${near.join(" / ")}`
        : `没有「${topicNote.asked}」这个话题（一个字都对不上）。`;
      event("search.topic_unknown", { topic: topicNote.asked, near });
    } else if (topicNote?.canonical && topicNote.canonical !== topicNote.asked) {
      // 话题对上了、只是被合并改名过：把真名说出来，否则人会拿旧名一直试。
      hint = `「${topicNote.asked}」已归到「${topicNote.canonical}」，它下面没有命中这几条。`;
    }
  }

  // 展示用的「检索词」只给强词：全部词里有十几个虚词 2-gram，打出来又难读又占 token。
  return {
    terms: gate,
    // 真正参与打分的词集，和 terms 不是一回事：日期词只对 date 生效。
    // eval-rank 必须拿这份离线重排，否则含日期的查询会算出线上从没算过的分数。
    scoreTerms: wordGate,
    allTerms: terms,
    anchors,
    minShould,
    hits,
    notebook,
    hint,
    topic: topicNote ?? undefined,
  };
}
