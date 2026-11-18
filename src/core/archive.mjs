/**
 * 归档：把用户明确说「没用 / 过时 / 只是试试」的条目收起来。
 *
 * 为什么不在抽取阶段过滤：抽取时手里只有文本，没有任何用户反馈。让模型在那一步
 * 判断「这是噪音」等于让它猜，猜错的代价是永久丢内容，而且事后完全查不出「为什么
 * 没记下来」。归档是事后动作，有明确的人工判断、可撤销、留痕——同一个问题，放在
 * 这里才对。
 *
 * 这一层只做「选出哪些条目」和「调 store 写属性」，不渲染文本：CLI 和 MCP 的输出
 * 形状不一样，混在一起最后一定是两边各改一半。
 *
 * 两个刹车：
 * - 整话题 / 整会话是范围操作，条数超过 CONFIRM_OVER 先回预览，确认了才写——
 *   用户说「这条没用」时，模型很容易顺手把整个话题清空。
 * - 单次硬上限 MAX，超了让人先缩小范围。整库级别的批量该走脚本，不该走一次
 *   工具调用。
 */
import { open } from "./jobs.mjs";
import { ATTR } from "./store.mjs";
import { loadEntities, topicNames } from "./entities.mjs";
import { event } from "../util/log.mjs";
import { normalizeSource } from "../util/source.mjs";

export const ARCHIVE_LIMIT = { max: 200, confirmOver: 10 };
/** 命中行的短引用：块 id 的末 7 位。和 MCP 输出、CLI 输出共用同一口径。 */
export const shortRef = (id) => String(id ?? "").slice(-7);

const lit = (s) => String(s ?? "").replace(/'/g, "''");

/** 短引用 + 正文，给 CLI / MCP 各自渲染时挑。 */
const briefOf = (row) => {
  const ial = row.ial ?? "";
  const brief = (ial.match(new RegExp(`${ATTR.brief}="([^"]*)"`)) ?? [])[1] ?? "";
  const entity = (ial.match(new RegExp(`${ATTR.entity}="([^"]*)"`)) ?? [])[1] ?? "";
  const date = (ial.match(new RegExp(`${ATTR.date}="([^"]*)"`)) ?? [])[1] ?? "";
  const content = String(row.content ?? "").replace(/\s+原文\s+assets\/\S+/g, "").trim();
  return {
    id: row.id,
    ref: shortRef(row.id),
    entity,
    date,
    brief: brief || content.slice(0, 40),
    text: content,
  };
};

/**
 * 话题 → 条目 id。走实体表解析别名和合并前的旧名，和检索用同一套名字，
 * 否则「把骑行穿搭归档」会归档 0 条（条目上存的是规范名）。
 */
async function idsOfTopic(sy, notebook, topic) {
  let names = [topic];
  try {
    const table = loadEntities();
    if (table) {
      const r = topicNames(table, topic);
      if (r.found) names = r.names;
    }
  } catch {
    // 实体表坏了不该让归档也坏：退成字面匹配，命中不了会说「0 条」。
  }
  const ors = names.map((n) => `ial LIKE '%${ATTR.entity}="${lit(n)}"%'`).join(" OR ");
  return selectIds(sy, notebook, `(${ors})`);
}

/** 会话 → 条目 id。session 是抽取时写进去的原始 id，这里只做精确匹配。 */
async function idsOfSession(sy, notebook, session) {
  return selectIds(sy, notebook, `ial LIKE '%${ATTR.session}="${lit(session)}"%'`);
}

/** 只看 current：已经归档的不必再归档，已经过时的还值得归档（它也是噪音）。 */
async function selectIds(sy, notebook, cond) {
  const rows = await sy.sql(
    `SELECT id, content, ial FROM blocks
      WHERE box='${notebook}' AND type='p' AND ial LIKE '%${ATTR.hash}="%'
        AND ial LIKE '%${ATTR.status}="current"%' AND ${cond}
      ORDER BY updated DESC LIMIT ${ARCHIVE_LIMIT.max + 1}`
  );
  return (rows ?? []).map((r) => ({ id: r.id, ref: shortRef(r.id), ...briefOf(r) }));
}

/** 按 id 取一行的展示字段（正文/话题/日期），归档和撤销都要用。 */
async function rowsOfIds(sy, ids) {
  if (!ids.length) return [];
  const list = ids.map((x) => `'${lit(x)}'`).join(",");
  const rows = await sy.sql(
    `SELECT id, content, ial FROM blocks WHERE id IN (${list}) AND ial LIKE '%${ATTR.hash}="%'`
  );
  return (rows ?? []).map((x) => briefOf(x));
}

/** 按 id 取（撤销用）。resolveIds 已经确认过存在。 */
async function pickByIds(store, ids) {
  const r = await store.resolveIds(ids);
  return { rows: r.ids.map((id) => ({ id, ref: shortRef(id) })), bad: r.bad, dup: r.dup };
}

/**
 * 唯一的入口：归档 / 撤销 / 列归档。
 *
 * @param {{ids?:string[], topic?:string, session?:string, reason?:string,
 *          confirm?:boolean, undo?:boolean, list?:boolean, limit?:number,
 *          source?:string}} opts
 * @returns {Promise<object>} 结构见下方 return；failed 为真表示后端出错，
 *          调用方必须报错，不能渲染成「没有」。
 */
export async function archiveEntries(opts = {}, deps = {}) {
  const ids = Array.isArray(opts.ids) ? opts.ids.map(String) : opts.ids ? [String(opts.ids)] : [];
  const topic = String(opts.topic ?? "").trim();
  const session = String(opts.session ?? "").trim();
  const reason = String(opts.reason ?? "").trim();
  const source = normalizeSource(opts.source, "cli");

  // open 可注入：归档的判断逻辑（选范围、刹车、撤销）比它调的那条 HTTP 更容易写错，
  // 而为了测它去起一个假思源不划算。
  const openFn = deps.open ?? open;
  let store, sy, notebook;
  try {
    ({ store, sy } = openFn());
    notebook = (await store.docIds()).notebook;
  } catch (e) {
    return { failed: true, reason: "backend-error", detail: e.message };
  }

  // 列归档：审计用。默认检索看不到归档条目，想知道「哪些被丢掉了」只能走这里。
  if (opts.list) {
    try {
      const rows = await store.listArchived(opts.limit ?? 20);
      return {
        ok: true,
        mode: "list",
        count: rows.length,
        items: rows.map((r) => ({
          id: r.id,
          ref: shortRef(r.id),
          entity: r.entity,
          date: r.date,
          brief: r.brief || String(r.text ?? "").slice(0, 40),
          reason: r.reason,
          archivedAt: r.archivedAt,
        })),
      };
    } catch (e) {
      return { failed: true, reason: "backend-error", detail: e.message };
    }
  }

  // 撤销：必须点名。范围型撤销会把别处归档的东西一起捞回来。
  if (opts.undo) {
    if (!ids.length) return { ok: false, mode: "undo", count: 0, items: [], note: "撤销要指定条目（短引用或块 id）。先 mem forget --list 看有哪些。" };
    const picked = await pickByIds(store, ids);
    if (!picked.rows.length) {
      return { ok: false, mode: "undo", count: 0, items: [], note: `这些引用没对上任何条目：${picked.bad.join(" / ") || ids.join(" / ")}` };
    }
    try {
      const shown = await rowsOfIds(sy, picked.rows.map((x) => x.id));
      const r = await store.restore(picked.rows.map((x) => x.id));
      event("memory.archive", { mode: "undo", n: r.changed.length, source });
      return {
        ok: true,
        mode: "undo",
        count: r.changed.length,
        items: shown.filter((x) => r.changed.includes(x.id)),
        skipped: r.skipped,
        note: r.skipped.length ? `${r.skipped.length} 条本来就没归档，跳过了。` : "",
      };
    } catch (e) {
      return { failed: true, reason: "backend-error", detail: e.message };
    }
  }

  // 选范围：id 优先，其次话题，其次会话。三个都没给就是调用方搞错了。
  let rows = [];
  let bad = [];
  let dup = [];
  let scope = "";
  try {
    if (ids.length) {
      scope = "ids";
      const r = await store.resolveIds(ids);
      bad = r.bad;
      dup = r.dup;
      // 取回展示字段：resolveIds 只回 id。
      rows = await rowsOfIds(sy, r.ids);
    } else if (topic) {
      scope = "topic";
      rows = await idsOfTopic(sy, notebook, topic);
    } else if (session) {
      scope = "session";
      rows = await idsOfSession(sy, notebook, session);
    } else {
      return {
        ok: false,
        mode: "archive",
        count: 0,
        items: [],
        note: "要给 ids（命中行末尾的短引用）、topic 或 session 之一；看已归档的用 list。",
      };
    }
  } catch (e) {
    return { failed: true, reason: "backend-error", detail: e.message };
  }

  // 引用没对上 / 有歧义要明说：静默跳过等于让调用方以为「都归档了」。
  const miss = [
    bad.length ? `没对上任何条目：${bad.join(" / ")}` : "",
    dup.length ? `有歧义（改用完整块 id）：${dup.join(" / ")}` : "",
  ]
    .filter(Boolean)
    .join("；");

  if (!rows.length) {
    const who = scope === "topic" ? `话题「${topic}」` : scope === "session" ? `会话「${session}」` : "这些引用";
    return {
      ok: false,
      mode: "archive",
      count: 0,
      items: [],
      bad,
      dup,
      note: `${who}下没有可归档的条目（current 状态）。${miss}`,
    };
  }

  if (rows.length > ARCHIVE_LIMIT.max) {
    return {
      ok: false,
      mode: "archive",
      count: rows.length,
      items: rows.slice(0, 10),
      note: `一次最多归档 ${ARCHIVE_LIMIT.max} 条，这次至少匹配 ${rows.length} 条（可能更多）。分几批来做，或者用 ids 精确点名。`,
    };
  }

  // 范围操作先给一眼：整话题归档是最容易误伤的动作，而用户的原话往往只是「这条没用」。
  if (rows.length > ARCHIVE_LIMIT.confirmOver && !opts.confirm && scope !== "ids") {
    return {
      ok: true,
      mode: "preview",
      scope,
      count: rows.length,
      needsConfirm: true,
      // 只列前 10 条：预览是让人扫一眼好下决心，全塞进上下文反而看不清。
      items: rows.slice(0, ARCHIVE_LIMIT.confirmOver),
      note:
        `${scope === "topic" ? `话题「${topic}」` : `会话「${session}」`}下 ${rows.length} 条，超过 ${ARCHIVE_LIMIT.confirmOver} 条，先没动。` +
        "确认要整批归档，再调一次并带上 confirm=true；只想归档其中几条，就用 ids 精确点名。",
    };
  }
  try {
    const r = await store.archive(rows.map((x) => x.id), { reason });
    event("memory.archive", {
      mode: "archive",
      scope,
      n: r.changed.length,
      skipped: r.skipped.length,
      topic: topic || "",
      session: session || "",
      source,
    });
    return {
      ok: true,
      mode: "archive",
      scope,
      reason,
      count: r.changed.length,
      items: rows.filter((x) => r.changed.includes(x.id)),
      skipped: r.skipped,
      bad,
      dup,
      note: [r.skipped.length ? `${r.skipped.length} 条本来就已经归档，跳过了。` : "", miss].filter(Boolean).join(""),
    };
  } catch (e) {
    return { failed: true, reason: "backend-error", detail: e.message };
  }
}
