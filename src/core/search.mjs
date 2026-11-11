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


/** 把一句话拆成检索词。中文不分词，按空格和标点切，去掉太短的。 */
export function termsOf(q) {
  return String(q ?? "")
    .split(/[\s，。、；：？！,.;:?!()（）\[\]【】"'“”‘’/|]+/)
    .map((t) => t.trim())
    // 英文虚词和单字母没意义，但**单个汉字是有意义的**（"车""书""钱"）。
    // 原来一律要求 ≥2 字，于是 `mem search 车` 拆出空数组，SQL 里没有任何检索条件，
    // 退化成"按更新时间返回最新几十条"——召回全错，还看不出来。
    .filter((t) => (/^[a-z]+$/i.test(t) ? t.length >= 2 : t.length >= 1))
    .filter((t) => !/^(the|and|for|with|that|this)$/i.test(t))
    .slice(0, 6);
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
  const cfg = loadConfig();
  const sy = new SiYuan({ baseUrl: cfg.siyuan.baseUrl, token: cfg.siyuan.token, timeoutMs: 8000 });
  const notebook = await resolveNotebookId(sy, cfg);
  const terms = termsOf(opts.q);
  const limit = Math.min(Math.max(Number(opts.limit) || 8, 1), 50);
  // 全是标点/空白时没有检索词。这时候不能往下走：SQL 里没有任何 LIKE 条件，
  // 结果会变成"按更新时间排序的最新 N 条"，看着有结果，其实一条都不相关。
  if (!terms.length) return { terms: [], hits: [], reason: "no-terms" };

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
  // 每个词都要出现（AND）。SQL 这层只做**粗筛**，精确性交给下面的 rel > 0。
  //
  // 先说清这件事的边界：ial 里是 `custom-mem-entity="…" custom-mem-raw="…"`
  // 这样一串，LIKE 的 `%` 会跨过值的收尾引号，于是「查 Mac」也能匹配到 raw 路径。
  // 试过用 GLOB 的 `[^"]` 把匹配卡在值内部——这个 SQLite 构建不认字符类取反，
  // 直接返回 0 条。**宁可宽，不可漏**：宽了最多多捞些候选，漏了是真丢召回。
  //
  // 但 content 里的路径尾巴要切掉，这个能修：条目正文是「结论 原文 assets/…」，
  // 不切的话查 `jsonl`、查机器名会把整库捞进来（实测 1507/1507）。
  const bodyExpr =
    "(CASE WHEN instr(content, ' 原文 assets/') > 0 " +
    "THEN substr(content, 1, instr(content, ' 原文 assets/') - 1) ELSE content END)";
  for (const t of terms) {
    const esc = likeEsc(t);
    const fields = [ATTR.entity, ATTR.brief, ATTR.project, ATTR.type].map(
      (k) => `ial LIKE '%${k}="%${esc}%' ESCAPE '\\'`
    );
    conds.push(`(${bodyExpr} LIKE '%${esc}%' ESCAPE '\\' OR ${fields.join(" OR ")})`);
  }

  // 这个 LIMIT 是**取候选**的上限，不是结果数。给得太小会静默漏召回：
  // 排序和日期过滤都在内存里做，先被 SQL 砍掉的那些再也回不来。
  const rows = await sy.sql(
    `SELECT id, content, ial FROM blocks WHERE ${conds.join(" AND ")}
       ORDER BY updated DESC LIMIT 5000`
  );
  checkBodyFormat(rows);
  if (!Array.isArray(rows)) {
    event("memory.miss", { q: String(opts.q ?? "").slice(0, 60), terms, reason: "sql-not-array" });
    return { terms, hits: [] };
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
        score: scoreOf({ text, brief, date }, terms, entity),
        rel: relevanceOf({ text, brief }, terms, entity),
      };
    })
    // 相关度为 0 = 只是候选，不是命中（词落在了原文路径之类的地方）。留着它
    // 只会让「查不到」看起来像「查到了但都不太对」。
    .filter((h) => h.rel > 0)
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
    if (topics.length) event("memory.hit", { q: String(opts.q ?? "").slice(0, 60), topics, n: hits.length });
  } catch {
    /* 日志失败不影响检索 */
  }

  // 零结果的查询最值得记：召回不准的时候，"它到底查过什么、什么都没查到"是唯一线索。
  let hint = "";
  if (!hits.length) {
    event("memory.miss", {
      q: String(opts.q ?? "").slice(0, 60),
      terms,
      topic: opts.topic ?? "",
      project: opts.project ?? "",
      rows: rows.length,
      // 四态分明：null = 没传话题；true/false = 表正常；"unavailable" = 表读不出来。
      // 原来拿 undefined 同时表示「没传」和「表读不出」，日志里根本分不开。
      topicKnown: topicNote ? (topicNote.known === undefined ? "unavailable" : topicNote.known) : null,
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

  return { terms, hits, notebook, hint, topic: topicNote ?? undefined };
}
