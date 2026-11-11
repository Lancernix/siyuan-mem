/**
 * 召回：从记忆库里查东西。
 *
 * 在这之前整套系统只有写没有读——所有"回忆"都是人手写 SQL 去翻。
 * 这一层补的就是读：给一句话，返回最相关的若干条记忆，带话题、摘要、日期和原文指针。
 *
 * 为什么先用 SQL LIKE 而不是向量、也不走思源的 FTS 接口：
 *
 *   1. 语料是中文短条目，LIKE 的子串匹配对中文本来就是对的（FTS 还要分词）；
 *   2. 我们真正要过滤的是块属性（status/hash/entity），这些只在 ial 里，
 *      先 FTS 再回表反而多一跳；
 *   3. 库现在七百条，LIKE 扫一遍是毫秒级。等上万条再谈索引，那时也该先量一下。
 *
 * 排序不靠"像不像"，靠三件事：词命中次数、话题是否命中、日期新旧。
 * 判重那套（bigram + 模型）在这里没用——那是判"是不是同一件事"，
 * 这里是判"哪几条跟这句话有关"，两回事。
 */
import { loadConfig } from "../util/config.mjs";
import { SiYuan, resolveNotebookId } from "../util/siyuan.mjs";
import { event } from "../util/log.mjs";
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
 * 拼进 LIKE 之前要转义。两件事：单引号（SQL 字符串）和 `%` `_` `\`（LIKE 通配符）。
 *
 * 原来只转单引号，于是 `mem search %` 会变成 `LIKE '%%%'`——匹配全部条目，
 * 召回里塞满不相干的东西，而且看不出是查询串的问题。`_` 同理会匹配任意单字。
 * 配套的 `ESCAPE '\'` 写在 SQL 里。
 */
export function likeEsc(s) {
  return String(s).replace(/[\\%_]/g, (c) => "\\" + c).replace(/'/g, "''");
}


/**
 * 把一句话拆成检索词。两阶段，顺序不能反：
 *
 *  1) 先把 **ASCII 标识符整体抠出来**（`NO.2` / `node:22-alpine` / `192.168.1.10`
 *     / `etc/nginx.conf`）。原来 `.` `:` `/` `-` 都在分隔符里，`NO.5` 会碎成
 *     `["NO","5"]`；而 util/raw.mjs 的 anchorsOf 特意把这串当「模型编不出来的
 *     硬锚」整体保留。同一批 token，收窄那边当宝、检索这边切碎，说不过去。
 *  2) 剩下的**连续汉字串 ≥3 字切 2-gram**。原来中文不分词，整句 14 个字就是
 *     **一个词**，SQL 又要求整句作为子串出现，于是「羽毛球训练级用球的号段
 *     怎么排」必然 0 命中。2-gram 不需要分词器，中文子串匹配本来就够用。
 *
 * 返回的是「所有词」，其中虚词 2-gram（我的 / 是多 / 什么）到处都是，不能参与
 * 「必须命中」的门槛——见 strongTerms()。单个汉字仍有意义（车/书/钱），保留。
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
  // 16 是 2-gram 之后的上限：整句十几个字会切成十几个词，原来 6 个的帽子会
  // 把后半句截掉。SQL 是 OR 宽筛，多几个词只多几个 LIKE，代价可忽略。
  return out.slice(0, 16);
}

/**
 * 虚字。用来判定「这串汉字是不是虚词组合」。
 *
 * 判定规则是**全部字都虚才算虚**，不是「沾一个就算」。原来用单字连坐，
 * 把「性能 / 功能 / 智能 / 时间 / 会议 / 能力 / 上限 / 下游」整批误杀成虚词
 * （只因为它们含「能 / 时 / 会 / 上 / 下」）——强词集一空，闸门就退回全部
 * 虚词 2-gram 且门槛降到 1，等于把闸门整个绕开。这是 2026-11-11 第十二轮
 * CR 实证出来的漏洞：`会议时间` 能命中任何提到「时间」的条目。
 *
 * 虚词组合的本质就是「两个字都不承载信息」：我的 / 是多 / 什么 / 怎么 / 这个。
 * 而「会议」「时间」「性能」有一个字是实的，就够当证据了。
 */
const WEAK_HAN = new Set(
  "的我你他她它们这那其之是了在有着就都也还很不太没要把被给从向对与和或而但如若因为所以什怎哪多些个上下来去时会能可又再已曾经最更只才什么样呢吗啊吧让使并等几第每各另某该此".split("")
);

const HAN_ONLY = /^[\u4e00-\u9fa5]+$/;

/**
 * 提问框架词：它们描述「怎么问」，不承载「找什么」。
 *
 * 靠「全部字都虚」挡不住它们——`一次`、`需要`、`大概`、`多少` 里都有实字，
 * 但它们在任何一条记忆的正文里都俯拾皆是。2026-11-11 实测两条负例就是这样漏的：
 *
 *   咖啡机多久需要除一次垢 → 命中「需要 + 一次」→ 返回读书笔记、投影仪、SolidJS
 *   钢琴调音一次大概多少钱 → 命中「一次 + 多少」→ 返回抽取批大小的那条
 *
 * 三行命中里没有一条跟咖啡或钢琴有关。这不是虚词表没覆盖全的问题，是这类词
 * 压根不该参与「必须命中」的判定：它们不区分主题。
 *
 * 只列高频的，不追求穷尽——漏一个只是多一分噪声，多列一个实词会真丢召回。
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
 * 查询计划。minShould 是「至少命中几个不同的强词」：
 * 关键词问法（2 个强词）要求全中，等价于原来的 AND；整句问法切成 8–10 个
 * 2-gram 后只要求 2 个，从「全 AND 必然 0 命中」放宽到「沾边就进候选」。
 * 排序一律还是 scoreOf，见下面的说明——这一步只修查询理解，不动权重。
 */
export function queryPlan(q) {
  const terms = termsOf(q);
  const strong = strongTerms(terms);
  // 查询里点名的 ASCII 标识符是**硬约束**：模型编不出 `NO.9`，用户写它就是为了找它。
  // 只靠「命中 2 个强词」不够——「亚狮龙 NO.9 价格」会被 NO.5 的条目用「亚狮龙 + 价格」
  // 凑够两个词蒙过去，看起来像命中，其实答的是另一个型号。
  //
  // 但「标识符」不能按「是英文」来算：`skill` / `vite` / `docker` 是普通词，硬卡它们
  // 会把「讲容器但没写 docker」的相关条目全挡掉。只认模型编不出来的形态——
  // 带内部标点（NO.9 / node:22-alpine / burn_tokens / step-image-edit）、
  // 大小写混排（PostgreSQL / MiniWMS）、或全大写（WMS / SSH / LLM）。
  const anchors = terms.filter(isAnchorTerm);
  // 日期（年 / 年月 / 完整日期）是**范围限定**，不是主题词：正文里不一定写日期
  // （条目靠 date 属性记着），而且把它算进门槛，任何一条 2026 年记下的条目都能靠
  // 「2026」过闸——查「2026 年的部署计划」会捞回一堆只在当年记过、跟部署无关的东西。
  // 所以门槛只数非日期的词，日期单独当过滤器（见 searchEntries 里的 dateOk）。
  const dates = strong.filter(isDateTerm);
  const words = strong.filter((t) => !isDateTerm(t));
  // 门槛按「有没有标识符」分档：
  //   有标识符 → 只要 1 个词，因为标识符本身已经是硬约束（anchorsHit 会验它必须在）；
  //   没标识符 → 2 个词，靠词共现挡虚词灌水。
  //
  // 原来一律 min(2, strong.length)，两个词的短查询（"Vite 8 升级"）就等于 AND：
  // 「升级」在正文里写成「成套升」，一个词对不上就整条空手。有锚时不该这么卡。
  const minShould = words.length ? (anchors.length ? 1 : Math.min(2, Math.max(1, words.length))) : 1;
  // 一个实词都没有（「怎么样」「我的的」这类）：不许退回虚词 + 门槛 1，
  // 那等于把闸门整个关掉，任何提到这些虚词的条目都能进来。交给调用方判低置信。
  const meaningful = strong.length > 0 || anchors.length > 0;
  return { terms, strong, anchors, dates, words, minShould, meaningful };
}

/**
 * 日期形态的检索词：年 / 年月 / 完整日期（`2026`、`2026-11`、`2026-11-06`）。
 *
 * 为什么要整段认：这些词唯一可能落的地方是 `date` 属性，正文里通常不重复写。
 * 上一版只认四位年份，于是 `2026-11-06` 被当成普通锚——是锚但不查 date，
 * 候选池直接空（2026-11-11 第十四轮复审实测 0 条）。
 *
 * 只认 19xx / 20xx 开头且整词匹配：`NO.2026` 是型号（termsOf 会整体保留成
 * `NO.2026`，不匹配），`2026-11-06T10:00` 这类时间戳也不匹配——宁可当普通词，
 * 也别把型号误当日期去查 date。
 */
export function isDateTerm(t) {
  return /^(19|20)\d{2}([-/]\d{1,2}([-/]\d{1,2})?)?$/.test(String(t ?? ""));
}

/** 日期统一成 `2026-11-06` 再比：库里存的是短横线，用户可能写 `2026/11/06`。 */
const dateNorm = (t) => String(t).replace(/[/.]/g, "-");

/**
 * 条目日期是否落在查询日期范围内：`2026` 管全年、`2026-11` 管整月、`2026-11-06` 管当天。
 *
 * **不能拿字符串 startsWith 比**：库里补零存 `2026-01-15`，`"2026-01-15".startsWith("2026-1")`
 * 是 false，而 `"2026-11-06".startsWith("2026-1")` 是 true——查 1 月会返回 11、12 月，
 * 真正 1 月的反而漏掉（第十五轮复审 P3）。按段比数值，`01` 和 `1` 就是同一个月。
 */
/**
 * 日期 → 数字段。**日期比较的唯一入口**：内存比较、SQL 拼串、正文兜底都从这里走，
 * 免得一处补零一处不补（连续三轮同一形状的 bug 就是这么来的）。
 */
export function dateSegments(v) {
  const parts = dateNorm(v).split("-").filter(Boolean).map(Number);
  return parts.length && parts.every((n) => Number.isFinite(n)) ? parts : [];
}

export function dateMatches(date, term) {
  const d = dateSegments(date);
  const t = dateSegments(term);
  if (!d.length || !t.length) return false;
  return t.every((n, i) => i < d.length && d[i] === n);
}

/**
 * 日期词 → SQL LIKE 用的写法。库里的 `date` 是 `toISOString().slice(0,10)`，月日补零，
 * 所以 `2026-1` 必须变 `2026-01` 才匹配得上；不补零会「测试绿、线上空手」。
 *
 * 同时给出不补零的写法：条目日期要是模型给的、没补零，补零那份就漏了。
 * 多出来的候选由内存里的 `dateMatches` 收，符合「宁可宽，不可漏」。
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
 * 日期是不是真的写在正文里（少数条目会重复写一遍）。
 *
 * 不能直接 `includes`：正文里的 `2026-11-11` 包含子串 `2026-1`，查「2026 年 1 月」
 * 会命中一堆 11 月的条目——和 date 属性那边同一个前缀坑。要求匹配两侧都不是数字。
 */
export function dateInText(hay, term) {
  // 先把正文里的日期串抓出来，再逐段按数值比：`2026-01-05` 和 `2026-1` 是同一个月，
  // 而 `2026-11-11` 只是**包含** `2026-1` 这个子串，不该算命中。
  const tokens = dateNorm(hay).match(/(?<!\d)(?:19|20)\d{2}(?:-\d{1,2}){0,2}/g) ?? [];
  return tokens.some((t) => dateMatches(t, term));
}

/**
 * 这个词像不像「模型编不出来」的标识符。
 *
 * 判据是形态，不是「是不是英文」：纯小写普通词（skill / vite / jsonl）随便就能写出来，
 * 而当锚会把召回卡死；带点、下划线、连字符、大小写混排、全大写的，才是真标识符。
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
 * 一条候选是否满足「标识符必须在」这道闸。
 *
 * **日期锚不参加这道闸。** 它曾经参加，后果是 `亚狮龙 NO.9 2026 价格` 里那个
 * `2026` 单独就满足了 `.some()`——「NO.9 必须在」静默失效，NO.5 的条目照样能进来。
 * 日期已经由 `dateOk` 单独管（它比的是 date 属性，还带月份/日级的范围），
 * 在这里再算一次只会稀释真正起区分作用的标识符（第十五轮复审 P2）。
 *
 * 锚全被剔掉（纯日期查询）时返回 true：没有标识符就不设约束，日期由 dateOk 负责。
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
 * 数一条候选命中了几个不同的强词。口径和 relevanceOf 一致：只看正文、摘要、
 * 话题，不看 ial 里那串原文路径。
 *
 * 抽成纯函数是为了能测：2026-11-11 用真实库探过，只放宽 AND、不加这道门槛，
 * 三道负例（护照号码 / 年假 / 血脂）全被「我的」「是多」「公司」这类虚词
 * 2-gram 误召回。这个函数就是那道闸，别把它内联回去。
 */
export function strongHits(hay, gate) {
  const low = String(hay ?? "").toLowerCase();
  return gate.reduce((n, t) => n + (low.includes(String(t).toLowerCase()) ? 1 : 0), 0);
}

/**
 * 相关度：只算「词真的出现在正文/话题/摘要里」这部分，不含时间惩罚。
 *
 * 单独拆出来是为了给召回设下限：SQL 是在整个 ial 上做 LIKE 的，一条记忆哪怕只是
 * 原文路径里带个 `Mac`，也能成为候选。分数里那个时间惩罚会让它的总分变成负数，
 * 但负分照样排在结果里——于是「查一个词，返回一堆完全不相干的旧条目」。
 * 相关度为 0 的一律不算命中。
 */
export function relevanceOf(row, terms, entity) {
  const text = row.text ?? "";
  let rel = 0;
  for (const t of terms) {
    const lower = t.toLowerCase();
    const inText = text.toLowerCase().split(lower).length - 1;
    rel += Math.min(inText, 5) * 2;
    if (String(entity).toLowerCase().includes(lower)) rel += 6;
    if (String(row.brief).toLowerCase().includes(lower)) rel += 3;
  }
  return rel;
}

export function scoreOf(row, terms, entity) {
  let score = relevanceOf(row, terms, entity);
  // 时间惩罚：一天 -0.08，最多 -8。
  //
  // 原来是 -0.05/最多 -5，太轻了：一个词多出现一次就 +2（上限 +10），实体命中 +6，
  // 于是「旧但写得细」稳稳压过「新而简短」。实测查 bwrap 时 2026-05 那条排在
  // 2026-06 前面，而 6 月那条明确写着「已移除 bwrap 沙箱」——过时结论排在前面，
  // 是这种库最坏的一种错误。
  //
  // 为什么封顶是 8 而不是 14：14 会把任何超过半年的条目压到负分，连一份定稿的
  // 设计决策都翻不了身。8 分约等于 4 次词频，正好是「同一个词说了四五遍」和
  // 「只说一遍」的差距——够翻掉啰嗦的旧条目，又不至于让旧知识整体沉底。
  // 约 100 天打满。矛盾条目真正的归宿是被标 superseded，不该靠排序去解决。
  const days = row.date ? Math.max(0, (Date.now() - Date.parse(row.date + "T00:00:00")) / 86400000) : 60;
  score -= Math.min(days * 0.08, 8);
  return score;
}

/**
 * 只在进程内做一次的格式自检。
 *
 * bodyExpr 靠一个约定：思源把正文里的 `[原文](assets/…)` 渲染成纯文本 ` 原文 assets/…`。
 * 这是实测出来的格式，思源哪天改了渲染方式，切分就静默失效——召回悄悄变差，不报错。
 * 所以一旦看到「有路径但切不掉」的样本，留一条事件。不修数据，只让人知道。
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
 * 检索。返回按相关度排好的条目。
 *
 * @param {{q:string, limit?:number, topic?:string, type?:string, status?:string, days?:number}} opts
 */
export async function searchEntries(opts = {}) {
  const { terms, strong, anchors, dates, minShould, meaningful } = queryPlan(opts.q);
  const limit = Math.min(Math.max(Number(opts.limit) || 8, 1), 50);
  // 「没问出词」也要留一条事件。不然 selfcheck 的三分类永远见到 0：指标上看起来
  // 「没人问过废话」，实际上只是没人记（2026-11-11 第十四轮复审实测 0 条）。
  const earlyExit = (reason, shown) => {
    if (!opts.silent)
      event("memory.miss", {
        q: String(opts.q ?? "").slice(0, 60),
        terms: shown,
        source: opts.source ?? "unknown",
        reason,
      });
    return { terms: shown, hits: [], reason };
  };
  // 早退放在碰后端**之前**：没有可检索的东西时，思源是不是活着都不影响答案，
  // 先连一遍只会在后端故障时把「你问了句废话」伪装成「检索失败」。
  // 全是标点/空白时没有检索词。这时候不能往下走：SQL 里没有任何 LIKE 条件，
  // 结果会变成"按更新时间排序的最新 N 条"，看着有结果，其实一条都不相关。
  if (!terms.length) return earlyExit("no-terms", []);
  // 整句全是虚词（「怎么样」「我的」这类）：没有任何可定位的证据。
  // 这时候返回任何东西都是瞎猜——「查不到」和「问了句废话」是两件事，说清楚。
  // terms 留着：调用方要把「你问的这几个词都不承载信息」说给人看，清空就只剩
  // 一句「（检空）」，等于什么也没解释。
  if (!meaningful) return earlyExit("no-meaningful-terms", terms);

  const cfg = loadConfig();
  const sy = new SiYuan({ baseUrl: cfg.siyuan.baseUrl, token: cfg.siyuan.token, timeoutMs: 8000 });
  const notebook = await resolveNotebookId(sy, cfg);
  // SQL 层用哪组词做 OR 粗筛。走到这里一定至少有一组可用：要么有强词，
  // 要么有标识符（有锚时 gate 用锚，锚本身就是区分度）。
  const gate = strong.length ? strong : anchors;
  // 参与正文匹配的词。日期被摘出去：它只对 date 生效，见下面的 dateOk。
  const wordGate = dates.length ? gate.filter((t) => !isDateTerm(t)) : gate;

  const conds = [`box='${notebook}'`, "type='p'", `ial LIKE '%${ATTR.hash}="%'`];
  // status 传空串表示"过时的也要"（`mem search --all`）。
  // **必须白名单**：这个字段原来直接拼进 SQL，而 /api/search 会把外部请求的
  // status 原样透传进来。`status = "x' OR 1=1 -- "` 就能注释掉后面所有条件，
  // 绕过 box / type / hash 收口去读全库。转义不够——非法值本来就该拒绝。
  const status = opts.status === "" ? "" : opts.status || "current";
  if (status && status !== "current" && status !== "superseded") {
    throw new Error(`status 只能是 current / superseded / 空，收到「${String(status).slice(0, 30)}」`);
  }
  if (status) conds.push(`ial LIKE '%${ATTR.status}="${status}"%'`);
  // 话题过滤要走实体表解析，不能拿用户写的字面量直接匹配。
  //
  // 条目上的 entity 是**写入当时**的名字；人记住的常是旧名或别名。原来这里用
  // `ial LIKE '%custom-mem-entity="<原样>"%'`，于是写「骑行穿搭」（别名）或
  // 「CAMP CROSS X 通勤车」（合并链的根）一律返回「没找到」——而空结果不报错，
  // 看起来就是「这个话题没有内容」。2026-11-09 dsh 拿真实话题测过，撞的就是这个。
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
    // known 是三态：false = 表正常但没这个话题；undefined = 表读不出来，
    // 这次只做了字面匹配。后者不能说「没有这个话题」，那是在报假消息。
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
  // 日期不在 SQL 里比：ial 里是字符串，SQL 比大小要额外解析；
  // 拿回来在内存里筛更直接（候选最多 300 条）。
  const since = opts.days
    ? new Date(Date.now() - Number(opts.days) * 86400000).toISOString().slice(0, 10)
    : "";
  // SQL 这层只做 **OR 粗筛**：命中任何一个强词就进候选。
  //
  // 原来是「每个词都要出现（AND）」，中文整句拆完十几个 2-gram 必然 0 命中——
  // 2026-11-10 的召回评测里整句问法 18/18 全灭，就是这个。放宽到 OR 之后，
  // 精确性交给下面内存里的两道闸：`rel > 0`（词真的落在正文/摘要/话题里）和
  // `strongHit >= minShould`（至少命中 K 个实词，挡住「我的」「是多」这类虚词灌水）。
  // 真实库实测：只有 OR 没有强词门槛时，三道负例全被误召回。
  //
  // 边界仍是老问题：ial 是 `custom-mem-entity="…" custom-mem-raw="…"` 一串，
  // LIKE 的 `%` 会跨过值的收尾引号，于是「查 Mac」也能匹配到 raw 路径。试过用
  // GLOB 的 `[^"]` 卡在值内部——这个 SQLite 构建不认字符类取反，直接返回 0 条。
  // **宁可宽，不可漏**：宽了最多多捞候选，漏了是真丢召回，精确性在内存里收。
  //
  // content 里的路径尾巴要切掉：条目正文是「结论 原文 assets/…」，不切的话查
  // `jsonl`、查机器名会把整库捞进来（实测 1507/1507）。
  const bodyExpr =
    "(CASE WHEN instr(content, ' 原文 assets/') > 0 " +
    "THEN substr(content, 1, instr(content, ' 原文 assets/') - 1) ELSE content END)";
  const ors = gate.map((t) => {
    const esc = likeEsc(t);
    const fields = [ATTR.entity, ATTR.brief, ATTR.project, ATTR.type].map(
      (k) => `ial LIKE '%${k}="%${esc}%' ESCAPE '\\'`
    );
    // 日期是唯一一类「正文里通常不写」的词：2026 年 11 月 6 日记下的条目，正文
    // 不会重复写一遍日期，只在 date 属性里。只抄那四个字段的话，纯日期查询的候选
    // 池里根本没有那些条目——内存层的 dateOk 再对也没机会跑。
    // 只给日期词加 date，不给所有词加：否则查「11」会命中所有 11 月记的条目。
    if (isDateTerm(t)) {
      // 补零后再比：库里存 `2026-11-06`，用户写 `2026-1` 得按 `2026-01` 去找，
      // 否则 SQL 层就把候选漏光了，内存里那个正确的 dateMatches 根本没机会跑。
      const pats = dateLikePatterns(t).map(
        (x) => `ial LIKE '%${ATTR.date}="%${likeEsc(x)}%' ESCAPE '\\'`
      );
      fields.push(`(${pats.join(" OR ")})`);
    }
    return `(${bodyExpr} LIKE '%${esc}%' ESCAPE '\\' OR ${fields.join(" OR ")})`;
  });
  conds.push(`(${ors.join(" OR ")})`);

  // 这个 LIMIT 是**取候选**的上限，不是结果数。给得太小会静默漏召回：
  // 排序和日期过滤都在内存里做，先被 SQL 砍掉的那些再也回不来。
  let rows;
  try {
    rows = await sy.sql(
      `SELECT id, content, ial FROM blocks WHERE ${conds.join(" AND ")}
         ORDER BY updated DESC LIMIT 5000`
    );
  } catch (e) {
    // **后端坏了不是「没记过」**。返回 failed 让调用方能说「检索失败」——
    // 把故障渲染成一句「没找到」比报错更糟：它看起来像答案。
    if (!opts.silent)
      event("memory.miss", {
        q: String(opts.q ?? "").slice(0, 60),
        terms: gate,
        source: opts.source ?? "unknown",
        reason: "backend-error",
        error: String(e?.message ?? e).slice(0, 120),
      });
    return {
      terms: gate,
      hits: [],
      failed: true,
      reason: "backend-error",
      detail: String(e?.message ?? e).slice(0, 200),
    };
  }
  checkBodyFormat(rows);
  if (!Array.isArray(rows)) {
    // 口径要和主路径一致：评测（silent）不能灌假空手，来源要带上。
    if (!opts.silent)
      event("memory.miss", {
        q: String(opts.q ?? "").slice(0, 60),
        terms: gate,
        source: opts.source ?? "unknown",
        reason: "sql-not-array",
      });
    return { terms: gate, hits: [], failed: true, reason: "sql-not-array" };
  }
  // 取候选的上限被撞到就说明可能有召回被截断：排序和日期过滤都在内存里做，
  // 被 SQL 砍掉的那些再也回不来。撞了要留痕，否则"查不到"永远查不出原因。
  if (rows.length >= 5000) event("search.truncated", { q: String(opts.q ?? "").slice(0, 60), terms, rows: rows.length });

  const hits = rows
    .map((r) => {
      const entity = attr(r.ial, ATTR.entity);
      const brief = attr(r.ial, ATTR.brief);
      const date = attr(r.ial, ATTR.date);
      const raw = attr(r.ial, ATTR.raw);
      // 先切掉原文路径再算分：不切的话，同一场会话的条目会因为共用同一串
      // 路径而互相「像」，排序就变成了「同一场会话的条目聚在一起」。
      const text = plain(r.content, raw);
      const hay = `${text} ${brief} ${entity}`;
      // 日期的证据在 date 上，不在正文里。混合查询（「2026 年的部署计划」）里
      // 它是**过滤器**：日期不对的条目直接不要，不能靠它凑门槛。
      const dateOk = !dates.length || dates.some((d) => dateMatches(date, d) || dateInText(hay, d));
      const strongHit = wordGate.length ? strongHits(hay, wordGate) : dateOk ? 1 : 0;
      // 锚校验**不看** date：日期由上面的 dateOk 单独管，混进锚闸会稀释型号约束。
      // 强词命中同样用不含日期的 hay：让「2026」给所有当年的条目加分是错的。
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
        // 打分只用强词：权重公式一个字没动（这是 Qoder 说的「先别动排序」），
        // 但输入词集换成去虚词后的那些，否则「我的」「是多」这类到处都有的
        // 2-gram 会给每条都加分，把真正的排序信号淹掉。
        score: scoreOf({ text, brief, date }, wordGate, entity),
        rel,
        // 纯日期查询（"2026" / "2026-11-06"）：正文里不写日期，rel 天然是 0。
        // 这时证据只在 date 上，不能拿 rel>0 去卡，改由 dateOk 说话。
        relOk: wordGate.length ? rel > 0 : dateOk,
        strongHit,
        anchorOk,
        dateOk,
      };
    })
    // relatedness 0 = 只是候选，不是命中（词落在了原文路径之类的地方）。留着它
    // 只会让「查不到」看起来像「查到了但都不太对」。
    // 三道闸：相关度 > 0、强词够数、查询里点名的标识符确实在。最后一条挡住
    // 「问 NO.9 却拿 NO.5 来答」——那种结果比空手更糟，因为它看起来是答案。
    .filter((h) => h.relOk && h.strongHit >= minShould && h.anchorOk && h.dateOk)
    .filter((h) => !since || (h.date && h.date >= since))
    .sort((a, b) => b.score - a.score || String(b.date ?? "").localeCompare(String(a.date ?? "")))
    .slice(0, limit);

  // 记一次命中，按话题去重（同一轮里同一话题只算一次）。
  // 这是"这条记忆还活着"的唯一真实信号：它被想起来过。
  //
  // `opts.silent` 给评测用：跑一次评测集是几百条查询，全记成 memory.hit 的话，
  // 「这条记忆被人用过」这个信号就被评测自己灌满了——测完看起来像有人在用，其实没有。
  try {
    const topics = opts.silent ? [] : [...new Set(hits.map((h) => h.entity).filter(Boolean))];
    // 命中就记，条件是 hits.length，不是 topics.length。原来要求至少一个话题，
    // 于是没打 entity 的条目命中时完全不计数——「召回被用过几次」这个数会偏低，
    // 而它正是判断「要不要继续投入召回」的唯一依据。
    if (hits.length && !opts.silent)
      event("memory.hit", {
        q: String(opts.q ?? "").slice(0, 60),
        topics,
        n: hits.length,
        // 来源必须分开记：CLI 是人在调试，MCP 是 agent 真的在用，api 是别的机器。
        // 混在一起的话，「这套东西到底有没有被用起来」永远答不了——2026-11-11 那
        // 58 次命中里大半是我自己敲的，从日志上根本看不出来。
        source: opts.source ?? "unknown",
      });
  } catch {
    /* 日志失败不影响检索 */
  }

  // 零结果的查询最值得记：召回不准的时候，"它到底查过什么、什么都没查到"是唯一线索。
  //
  // 但评测不能记：`silent` 原来只压住了 hit，76 条题库跑一遍会灌进几十条假空手，
  // 把「真实空手率」这唯一一个能反映用户体验的指标搞脏。评测是造出来的，
  // 它属于离线评估，不该混进生产统计。
  let hint = "";
  if (!hits.length && !opts.silent) {
    event("memory.miss", {
      q: String(opts.q ?? "").slice(0, 60),
      terms,
      source: opts.source ?? "unknown",
      topic: opts.topic ?? "",
      project: opts.project ?? "",
      rows: rows.length,
      // 四态分明：null = 没传话题；true/false = 表正常；"unavailable" = 表读不出来。
      // 原来拿 undefined 同时表示「没传」和「表读不出」，日志里根本分不开。
      topicKnown: topicNote ? (topicNote.known === undefined ? "unavailable" : topicNote.known) : null,
      // 明确写出来：自检/状态页按 reason 分桶，缺省值不能再背「后端故障」的锅。
      reason: "no-match",
    });
    // 话题名根本没解析到 = 「你写的话题不在库里」，不是「这个话题没内容」。
    // 这两件事修法完全不同，不给提示的话，人只会觉得记忆库是空的然后瞎猜名字。
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
      // 话题对上了、只是被合并改名过：把真实名字说出来。否则人看到「没找到」，
      // 会以为这个话题是空的，然后继续拿旧名换着试。
      hint = `「${topicNote.asked}」已归到「${topicNote.canonical}」，它下面没有命中这几条。`;
    }
  }

  // 展示给别人看的「检索词」只给强词。全部词里有十几个虚词 2-gram，
  // 原样打出来既难读又占 token；完整词表留给 allTerms 做诊断。
  return {
    terms: gate,
    allTerms: terms,
    anchors,
    minShould,
    hits,
    notebook,
    hint,
    topic: topicNote ?? undefined,
  };
}
