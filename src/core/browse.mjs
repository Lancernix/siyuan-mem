/**
 * 导航层：列话题、按话题翻条目。和 search.mjs 互补。
 *
 *   - search.mjs 是「知道要找什么」：一句话 → 最相关的几条，带三道闸；
 *   - browse.mjs 是「先看看有什么」：没有 query，也不该套那三道闸。
 *
 * 单独做这一层是因为 agent 拿不到命名空间就只能猜关键词：`memory_search` 一直有
 * topic 参数、还走别名解析，但模型不知道库里有哪些话题、该传哪个名字。
 *
 * 约定（借自 mcp-adapter 的元工具）：目录式查询要控量并明说还有多少；参数是 hint
 * 不是硬过滤，解析不到给候选而不是静默空手；结果自带匹配依据和下一步建议；
 * 故障与「没有」分开。
 */
import { loadConfig } from "../util/config.mjs";
import { SiYuan, resolveNotebookId } from "../util/siyuan.mjs";
import { event } from "../util/log.mjs";
import { normalizeSource } from "../util/source.mjs";
import { stripRawLink } from "../util/raw.mjs";
import { ATTR, attrOf } from "./store.mjs";
import { loadEntities, topicNames, findCandidates, norm } from "./entities.mjs";
import { likeEsc } from "./search.mjs";

/** 目录接口的硬上限。超过这个数就别往上下文里塞了，让调用方缩小范围。 */
export const TOPIC_LIMIT = { default: 20, max: 50 };
export const ENTRY_LIMIT = { default: 8, max: 20 };
/**
 * SQL 取候选的上限。列话题只取 ial，比 searchEntries 轻，给得宽一些。
 * 撞到要留痕并告知调用方：这时目录只是「最近 N 条」的统计，老话题会静默消失。
 */
const ROW_CAP = 20000;
/** 单个话题名/别名在**展示文本**里最长占多少字符。 */
const NAME_CHARS = 40;
/** 每个话题最多列几个别名。 */
const ALIAS_MAX = 3;
/**
 * 空 entity 在目录里的显示名。这是保留字，listEntries 认得它并按 `entity=""` 查：
 * 目录承诺「名字能直接填回去」，而它在实体表里不存在，当普通名字显示必然查不到。
 */
export const UNCATEGORIZED = "（未归类）";

/**
 * 只用于回显用户输入。绝不作用于参与解析、分组或 SQL 的标识符：截断过的名字填回
 * memory_entries 会查不到，而目录承诺过能直接回填。
 *
 * 所以话题名、别名、候选名一律原样返回，控量只靠 limit 和别名条数。
 */
const clip = (s, n = NAME_CHARS) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** 空白折叠：只影响展示对齐，不做长度截断。 */
const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function limitOf(v, spec) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), spec.max) : spec.default;
}

function statusOf(v) {
  // 和 searchEntries 同一套白名单：这个字段会拼进 SQL，非法值必须在这里拒掉。
  const s = v === "" ? "" : v || "current";
  if (s && s !== "current" && s !== "superseded") {
    throw new Error(`status 只能是 current / superseded / 空，收到「${String(s).slice(0, 30)}」`);
  }
  return s;
}

const sinceOf = (days) =>
  Number(days) > 0 ? new Date(Date.now() - Number(days) * 86400000).toISOString().slice(0, 10) : "";

function baseConds(notebook, status) {
  const conds = [`box='${notebook}'`, "type='p'", `ial LIKE '%${ATTR.hash}="%'`];
  if (status) conds.push(`ial LIKE '%${ATTR.status}="${status}"%'`);
  return conds;
}

/** 后端坏了不是「没有」。三个导航出口共用这份失败语义。 */
function backendFailure(e) {
  return {
    failed: true,
    reason: "backend-error",
    detail: String(e?.message ?? e).slice(0, 200),
  };
}

function notArrayFailure() {
  return { failed: true, reason: "sql-not-array" };
}

/** 导航调用单独记一种事件，不混进 memory.hit/miss——那个数是召回率的分母。 */
function logBrowse(kind, fields, opts) {
  if (opts.silent) return;
  try {
    event("memory.browse", {
      kind,
      source: normalizeSource(opts.source),
      ...fields,
    });
  } catch {
    /* 日志失败不影响导航 */
  }
}

async function openStore() {
  const cfg = loadConfig();
  const sy = new SiYuan({ baseUrl: cfg.siyuan.baseUrl, token: cfg.siyuan.token, timeoutMs: 8000 });
  return { sy, notebook: await resolveNotebookId(sy, cfg) };
}

/**
 * 列话题。按条目数排序，带别名、条目数、最近更新日期。
 *
 * 名字归并走实体表：条目上的 entity 是写入当时的名字，人记住的常是旧名或别名，
 * topicNames 会把它们归到同一个规范名，目录里不会出现两个看着都像的话题。
 *
 * @returns {{topics:Array,total:number,shown:number,truncated:boolean,
 *            degraded:boolean,hint:string,q:string,failed?:boolean,reason?:string}}
 */
export async function listTopics(opts = {}) {
  const q = String(opts.q ?? "").trim();
  const limit = limitOf(opts.limit, TOPIC_LIMIT);
  let status;
  try {
    status = statusOf(opts.status);
  } catch (e) {
    return { topics: [], total: 0, shown: 0, truncated: false, degraded: false, hint: "", q, ...backendFailure(e) };
  }

  let sy, notebook, rows;
  try {
    ({ sy, notebook } = await openStore());
    // 只要 ial：实体、日期、状态都在属性里，正文一个字都不用拉回来。
    rows = await sy.sql(
      `SELECT ial FROM blocks WHERE ${baseConds(notebook, status).join(" AND ")}
         ORDER BY updated DESC LIMIT ${ROW_CAP}`
    );
  } catch (e) {
    return { topics: [], total: 0, shown: 0, truncated: false, degraded: false, hint: "", q, ...backendFailure(e) };
  }
  if (!Array.isArray(rows)) {
    return { topics: [], total: 0, shown: 0, truncated: false, degraded: false, hint: "", q, ...notArrayFailure() };
  }
  // 撞上限 = 目录不完整：老话题可能整个消失，条目数也只算了最近这批。
  // 留事件供回溯，并在结果里明说，别让人拿这份目录当全量统计。
  const rowTruncated = rows.length >= ROW_CAP;
  if (rowTruncated) {
    try {
      event("browse.truncated", { kind: "topics", rows: rows.length, cap: ROW_CAP, source: normalizeSource(opts.source) });
    } catch {
      /* 日志失败不影响导航 */
    }
  }

  // 实体表读不出来 ≠ 库里没有话题。降级成「按条目上的原样名字列」，并把这件事
  // 明说，别让调用方以为目录就是权威的规范名清单。
  let table = null;
  let degraded = false;
  try {
    table = loadEntities({ strict: true });
    if (table === null) degraded = true;
  } catch {
    degraded = true;
  }

  const groups = new Map();
  for (const r of rows) {
    // **全名**：解析、分组、SQL 都用原样，一字不截。空 entity 用保留字，
    // 让目录里这一格也能被填回 listEntries（见 resolveUncategorized）。
    const name = tidy(attrOf(r.ial, ATTR.entity)) || UNCATEGORIZED;
    const date = attrOf(r.ial, ATTR.date) || "";
    let canonical = name;
    let aliases = [];
    if (table && name !== UNCATEGORIZED) {
      const resolved = topicNames(table, name);
      if (resolved.found) {
        canonical = tidy(resolved.canonical);
        aliases = resolved.names.filter((n) => n !== resolved.canonical).map(tidy);
      }
    }
    let g = groups.get(canonical);
    if (!g) {
      g = { name: canonical, aliases: new Set(), count: 0, last: "" };
      groups.set(canonical, g);
    }
    for (const a of aliases) if (g.aliases.size < ALIAS_MAX) g.aliases.add(a);
    g.count++;
    if (date > g.last) g.last = date;
  }

  // q 是**过滤提示**，不是精确匹配：名字或别名里含这段就算。匹配不上时不返回
  // 空目录，而是把最活跃的几个作为兜底浏览，并说清楚「这不是你要的那个」。
  const nq = norm(q);
  const all = [...groups.values()]
    .map((g) => ({ name: g.name, aliases: [...g.aliases], count: g.count, last: g.last, match: "" }))
    .sort((a, b) => b.count - a.count || String(b.last).localeCompare(String(a.last)));
  const matched = !nq
    ? all
    : all
        .map((t) => ({
          ...t,
          // 匹配依据带回去：模型能看出「这个名字为什么出现在目录里」，
          // 而不是自己猜哪条更可信（mcp-adapter 的 matchReasons）。
          match: norm(t.name).includes(nq)
            ? "name"
            : t.aliases.some((a) => norm(a).includes(nq))
              ? "alias"
              : "",
        }))
        .filter((t) => t.match);
  const fallback = !!nq && matched.length === 0;
  const shown = (fallback ? all : matched)
    .slice(0, limit)
    .map((t) => (fallback ? { ...t, match: "fallback" } : t));
  const total = (fallback ? all : matched).length;

  // 「没有匹配」由 formatTopics 的头部说（模型第一眼该看见）；这里只给下一步，
  // 别在结果里重复同一句。降级说明和兜底可以同时发生，两条都要留。
  const notes = [];
  if (fallback) notes.push("可以用 memory_search 直接搜内容，或换个更短的词再列目录。");
  if (degraded) notes.push("实体表读不出来，下面列的是条目上原样写的话题名；别名和已合并的旧名没归并，别当权威目录。");
  if (rowTruncated)
    notes.push(`条目数超过 ${ROW_CAP}，这份目录只统计了最近更新的一批，老话题可能没出现、条目数也不全；别当全量统计用。`);
  const hint = notes.join("");

  logBrowse("topics", { q, limit, total, shown: shown.length, fallback, degraded, rowTruncated }, opts);
  return {
    topics: shown,
    total,
    shown: shown.length,
    // 两种「不完整」分开：前者是分页（还有话题没列），后者是数据被 SQL 砍了。
    truncated: total > shown.length || rowTruncated,
    rowTruncated,
    degraded,
    hint,
    q,
    fallback,
  };
}

/**
 * 按话题翻条目。**不走 query 门槛**：只要挂在这个话题下就返回，按日期倒序。
 *
 * 和 searchEntries 的区别就在这里：那边要求 rel>0、强词够数、标识符在；
 * 这里用户已经明确指定了话题，再套一道词匹配只会把该看到的条目藏起来。
 *
 * topic 解析不到时**不硬过滤**：给最接近的候选名 + 一个明确的 hint，让调用方
 * 换个名字重试。这比「按字面查完返回空」好——后者长得像「这个话题没内容」。
 */
export async function listEntries(opts = {}) {
  // 上限只挡「明显不正常」的输入，不参与名字归一：话题名可以很长（schema 没有
  // .max()），只要在 200 字内就原样用。超了直接拒，别把一整段话拼进 SQL。
  const topic = String(opts.topic ?? "").trim();
  if (topic.length > 200) {
    return { hits: [], total: 0, topic: topic.slice(0, 60), canonical: "", candidates: [], hint: "话题名太长（超过 200 字），这不像一个话题名。", unknown: true, reason: "topic-too-long" };
  }
  const limit = limitOf(opts.limit, ENTRY_LIMIT);
  const since = sinceOf(opts.days);
  let status;
  try {
    status = statusOf(opts.status);
  } catch (e) {
    return { hits: [], total: 0, topic, canonical: "", candidates: [], hint: "", ...backendFailure(e) };
  }
  if (!topic) {
    return {
      hits: [], total: 0, topic: "", canonical: "", candidates: [],
      hint: "缺 topic。先用 memory_topics 看有哪些话题，再把规范名传进来。",
      reason: "no-topic",
    };
  }

  let table = null;
  let degraded = false;
  try {
    table = loadEntities({ strict: true });
    if (table === null) degraded = true;
  } catch {
    degraded = true;
  }

  // 「（未归类）」是保留字不是话题，必须认它并按 entity 为空查——回一句「没这个话题」
  // 会把模型指回目录，闭环死循环。
  const uncategorized = topic === UNCATEGORIZED;
  let resolved = { found: false, canonical: "", names: [] };
  if (table && !uncategorized) {
    try {
      resolved = topicNames(table, topic);
    } catch {
      degraded = true;
    }
  }
  // 候选名也不能截断：截过的名字填回来照样查不到，提示「用规范名重试」等于没说。
  const candidates = table && !resolved.found && !uncategorized
    ? findCandidates(topic, table, { limit: 3 }).map((c) => tidy(c.entity.name))
    : [];
  const names = resolved.found ? resolved.names : [];
  const canonical = uncategorized ? UNCATEGORIZED : resolved.canonical || "";
  if (uncategorized) resolved = { found: true, canonical: UNCATEGORIZED, names: [] };

  if (!resolved.found) {
    // 表坏了也不能说「没有这个话题」：只按字面查，并明说别名/旧名没展开。
    const hint = degraded
      ? `实体表读不出来，这次只按字面匹配「${clip(topic, 30)}」；别名和已合并的旧名可能查不到。`
      : candidates.length
        ? `没有「${clip(topic, 30)}」这个话题。最接近的是：${candidates.join(" / ")}。用规范名重试，或先用 memory_topics 查。`
        : `没有「${clip(topic, 30)}」这个话题（一个字都对不上）。先用 memory_topics 看目录。`;
    logBrowse("entries", { topic, n: 0, unknown: true, degraded }, opts);
    // 表正常但名字没对上：不返回条目。这时候给一堆全局条目只会误导，
    // 给候选名让模型自己纠才是 mcp-adapter 那套「hint 不硬过滤」的正解。
    if (!degraded) return { hits: [], total: 0, topic, canonical, candidates, hint, unknown: true };
    names.push(topic);
  }

  let sy, notebook, rows;
  try {
    ({ sy, notebook } = await openStore());
    // 未归类 = entity 属性是空串，或者这个属性压根没写。目录里这一格的名字
    // 就是查询键，所以这里不能用「名字列表」去拼，得直接按空值筛。
    const topicCond = uncategorized
      ? `(ial LIKE '%${ATTR.entity}=""%' OR ial NOT LIKE '%${ATTR.entity}=%')`
      : `(${names.map((n) => `ial LIKE '%${ATTR.entity}="${likeEsc(n)}"%' ESCAPE '\\'`).join(" OR ")})`;
    const conds = [...baseConds(notebook, status), topicCond];
    rows = await sy.sql(
      `SELECT id, content, ial FROM blocks WHERE ${conds.join(" AND ")}
         ORDER BY updated DESC LIMIT ${ROW_CAP}`
    );
  } catch (e) {
    return { hits: [], total: 0, topic, canonical, candidates, hint: "", ...backendFailure(e) };
  }
  if (!Array.isArray(rows)) {
    return { hits: [], total: 0, topic, canonical, candidates, hint: "", ...notArrayFailure() };
  }

  const hits = rows
    .map((r) => {
      const raw = attrOf(r.ial, ATTR.raw);
      return {
        id: r.id,
        entity: attrOf(r.ial, ATTR.entity),
        brief: attrOf(r.ial, ATTR.brief),
        date: attrOf(r.ial, ATTR.date),
        type: attrOf(r.ial, ATTR.type),
        confidence: attrOf(r.ial, ATTR.confidence),
        text: stripRawLink(r.content, raw),
        raw,
        session: attrOf(r.ial, ATTR.session),
        source: attrOf(r.ial, ATTR.source),
        project: attrOf(r.ial, ATTR.project),
        status: attrOf(r.ial, ATTR.status),
      };
    })
    .filter((h) => !since || (h.date && h.date >= since))
    // 按日期从新到旧，同日按 id 稳定排序（updated 没被 SELECT 出来）。
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")) || String(b.id).localeCompare(String(a.id)));

  const total = hits.length;
  const shown = hits.slice(0, limit);
  const hint = degraded
    ? `实体表读不出来，只按字面匹配「${clip(topic, 30)}」；别名和已合并的旧名可能没算进来。`
    : canonical && canonical !== topic
      ? `「${clip(topic, 30)}」已归到规范名「${clip(canonical, 30)}」，连它的别名和旧名一起查了。`
      : "";

  logBrowse("entries", { topic, canonical, n: shown.length, total, unknown: false, degraded }, opts);
  return {
    hits: shown,
    total,
    shown: shown.length,
    truncated: total > shown.length || rows.length >= ROW_CAP,
    topic,
    canonical,
    candidates,
    hint,
    unknown: false,
    degraded,
  };
}
