/**
 * 原文归档。
 *
 * 存什么：规范化之后的轮次（只有用户和助手的原话），不是原始日志。
 * 原始日志 227MB，规范化后 7.5MB，差 30 倍，差别全在 thinking、工具调用、
 * 我们注入的上下文——那些本来就不进记忆。
 *
 * 存哪：思源附件（data/assets/），不是笔记正文。附件不进 blocks_fts，
 * 所以不会把 bm25 的 IDF 拉偏（正文里的对话会把「风盾」的区分度稀释掉）；
 * 代价是附件会被「清理未引用资源」扫到，所以每个 part 都必须在 02-原文 里
 * 有一个引用块保活。
 *
 * 为什么是 JSONL：行就是地址。第 i 轮在第 i+1 行，读取时按每行的 `i` 字段走，
 * 不依赖行号（行号会随 meta 行、分片头变化，轮次号不会）。顺序读、内存恒定、
 * 坏一行不连累别的、grep 直接能命中。
 *
 * 指针形如 `assets/mem-raw/Mac/workbuddy/xxx.p1-20261029230812-abcd.jsonl#120-180`：
 * 物理路径 + 轮次范围。物理路径指向一个写进去就不再变的文件，所以重写日志、
 * 重新切分都不会让指针错位——这也是不用「块 id + 逻辑轮次」的原因。
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ensureDirs, RAW_INDEX_PATH } from "./config.mjs";

const FORMAT_VERSION = 1;

export function loadRawIndex() {
  try {
    return JSON.parse(readFileSync(RAW_INDEX_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveRawIndex(o) {
  ensureDirs();
  writeFileSync(RAW_INDEX_PATH, JSON.stringify(o, null, 2) + "\n");
}

const indexKey = (machine, harness, session) => `${machine || "local"}|${harness || "?"}|${session || "?"}`;

/** 机器名、harness 名要进路径，先洗一遍：带点、空格、斜杠会把目录结构弄乱。 */
function safe(s, fallback = "unknown") {
  const v = String(s ?? "")
    .trim()
    .replace(/[^\w.@-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 40);
  return v || fallback;
}

export function fmtChars(n) {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`;
}

/** 把标签里的 `|` `]` 之类洗掉，免得把 markdown 链接语法弄断。 */
function safeLabel(s) {
  return String(s ?? "").replace(/[[\]|]/g, " ").trim();
}

/**
 * 一个 part 的字节内容。首行 meta，后面一行一轮。
 * 头里放 from/to/turns/chars/hash：读之前就能知道这份文件覆盖哪一段、多大。
 */
export function buildPart(meta, turns) {
  if (!turns.length) throw new Error("buildPart 收到空 turns");
  const from = Number(meta.from) || 1;
  const to = from + turns.length - 1;
  const chars = turns.reduce((n, t) => n + String(t.text ?? "").length, 0);

  const rows = turns.map((t, k) => ({ i: from + k, role: t.role, text: String(t.text ?? "") }));
  const hash = createHash("sha1")
    .update(rows.map((r) => `${r.i}\u0000${r.role}\u0000${r.text}`).join("\u0001"))
    .digest("hex")
    .slice(0, 16);

  const header = {
    type: "session",
    v: FORMAT_VERSION,
    machine: meta.machine ?? "",
    harness: meta.harness ?? "",
    session: meta.session ?? "",
    cwd: meta.cwd ?? "",
    date: meta.date ?? "",
    from,
    to,
    turns: turns.length,
    chars,
    hash,
  };

  const body = [JSON.stringify(header), ...rows.map((r) => JSON.stringify(r))].join("\n") + "\n";
  return { buf: Buffer.from(body, "utf8"), from, to, chars, hash, turns: turns.length };
}

/** 按字节上限切块，只在轮次边界切，绝不切一行。切完拼起来等于原文。 */
export function sliceByBytes(meta, turns, maxBytes) {
  const out = [];
  let cur = [];
  let bytes = Buffer.byteLength(JSON.stringify({ ...meta, type: "session" })) + 2;
  for (const t of turns) {
    const line = Buffer.byteLength(JSON.stringify({ i: 0, role: t.role, text: String(t.text ?? "") })) + 1;
    if (cur.length && bytes + line > maxBytes) {
      out.push(cur);
      cur = [];
      bytes = Buffer.byteLength(JSON.stringify({ ...meta, type: "session" })) + 2;
    }
    cur.push(t);
    bytes += line;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * 02-原文 里已经归档过哪些区间。返回 [{id, path, from, to}]，按 from 升序。
 *
 * 按 box（笔记本）查而不是按 parent_id：文档被手动挪过、或者同一个会话的块
 * 因为历史原因挂在别的文档下时，按 parent_id 会漏。属性已经把范围收窄了。
 */
export async function listParts(sy, rawDocId, session) {
  if (!session) return [];
  const rows = await sy.sql(
    `SELECT id, ial FROM blocks
      WHERE box = (SELECT box FROM blocks WHERE id='${rawDocId}')
        AND ial LIKE '%custom-mem-kind="raw-part"%'
        AND ial LIKE '%custom-mem-session="${session.replace(/"/g, '\\"')}"%'
      ORDER BY created ASC`
  );
  const out = [];
  for (const r of rows ?? []) {
    const sid = /custom-mem-session="([^"]*)"/.exec(r.ial ?? "")?.[1] ?? "";
    if (sid !== session) continue;
    const range = /custom-mem-range="(\d+)-(\d+)"/.exec(r.ial ?? "");
    if (!range) continue;
    out.push({
      id: r.id,
      path: /custom-mem-path="([^"]*)"/.exec(r.ial ?? "")?.[1] ?? "",
      from: Number(range[1]),
      to: Number(range[2]),
    });
  }
  return out.sort((a, b) => a.from - b.from);
}

/**
 * 已有的 part。先看本地索引，没有再问思源。
 *
 * 顺序不能反：块的 SQL 索引是异步的，刚 append 完立刻查是空的，
 * 于是幂等判断失效、同一段原文被传两遍。本地索引在归档成功后立刻写，可靠。
 */
export async function knownParts(sy, rawDocId, { machine, harness, session }) {
  const idx = loadRawIndex();
  const key = indexKey(machine, harness, session);
  const local = idx[key];
  if (Array.isArray(local) && local.length) return local;

  const fromDb = await listParts(sy, rawDocId, session);
  if (fromDb.length) {
    idx[key] = fromDb.map((p) => ({ blockId: p.id, path: p.path, from: p.from, to: p.to }));
    saveRawIndex(idx);
  }
  return idx[key] ?? [];
}

/**
 * 归档一个会话的增量。
 *
 * payload 是队列里那一份：{ session_id, harness, machine, cwd, date, turns, turnFrom }。
 * turnFrom 是这批 turns 在完整会话里的起始轮次（增量推送时必须带，否则全局轮次号会重排）。
 *
 * 幂等：同 session 的已有 part 如果完整覆盖了这次的区间，直接跳过，不重复上传。
 * 附件不能追加，所以"再来一次"只能产生新文件——靠这个判断挡住重复。
 */
export async function archive({ sy, cfg, ids, payload, dry = false, log = () => {} }) {
  const turns = payload.turns ?? [];
  if (!turns.length || !ids?.raw) return [];

  const rawCfg = cfg.raw ?? {};
  if (rawCfg.enabled === false) return [];

  const session = payload.session_id ?? "";
  const from = Math.max(1, Number(payload.turnFrom) || 1);
  const to = from + turns.length - 1;

  const existing = await knownParts(sy, ids.raw, {
    machine: payload.machine,
    harness: payload.harness,
    session,
  });
  const covered = existing.find((p) => p.from <= from && p.to >= to);
  if (covered) return [{ skip: true, ptr: null, from, to, existing: covered }];

  const maxBytes = rawCfg.forcePartBytes ?? 8 * 1024 * 1024;
  const chunks = sliceByBytes({ machine: payload.machine, harness: payload.harness }, turns, maxBytes);
  const dir = `/assets/${safe(rawCfg.dir ?? "mem-raw")}/${safe(payload.machine, "local")}/${safe(payload.harness, "harness")}/`;
  const partIndex = existing.length + 1;
  const out = [];

  let offset = from;
  for (let k = 0; k < chunks.length; k++) {
    const chunk = chunks[k];
    const meta = {
      machine: payload.machine ?? "",
      harness: payload.harness ?? "",
      session,
      cwd: payload.cwd ?? "",
      date: payload.date ?? "",
      from: offset,
    };
    const part = buildPart(meta, chunk);

    if (dry) {
      out.push({ dry: true, from: part.from, to: part.to, bytes: part.buf.length, chars: part.chars });
      offset = part.to + 1;
      continue;
    }

    const name = `${safe(session || `log-${Date.now()}`, "session").slice(0, 28)}.p${partIndex + k}.jsonl`;
    const path = await sy.uploadAsset(dir, name, part.buf, "application/x-ndjson");
    const ptr = `${path}#${part.from}-${part.to}`;

    const label = [
      safeLabel(payload.machine || "local"),
      safeLabel(payload.harness || "?"),
      payload.date || "",
      `第 ${part.from}–${part.to} 轮`,
      fmtChars(part.chars),
    ]
      .filter(Boolean)
      .join(" · ");
    const blockId = await sy.appendBlock(ids.raw, `[${label}](${path})`, "markdown");

    try {
      await sy.setBlockAttrs(blockId, {
        "custom-mem-kind": "raw-part",
        "custom-mem-session": session,
        "custom-mem-harness": payload.harness ?? "",
        "custom-mem-machine": payload.machine ?? "",
        "custom-mem-range": `${part.from}-${part.to}`,
        "custom-mem-path": path,
        "custom-mem-bytes": String(part.buf.length),
        "custom-mem-hash": part.hash,
      });
    } catch (e) {
      // 属性没写成，这个块就只是条链接，清理未引用资源时挡不住；删掉让下次重来。
      await sy.deleteBlock(blockId).catch(() => {});
      throw e;
    }

    // 本地索引立刻写：SQL 索引是异步的，下一轮幂等判断要马上用到。
    const idx = loadRawIndex();
    const key = indexKey(payload.machine, payload.harness, session);
    idx[key] = [...(idx[key] ?? existing), { blockId, path, from: part.from, to: part.to }];
    saveRawIndex(idx);
    existing.push({ blockId, path, from: part.from, to: part.to });

    out.push({ ptr, blockId, path, from: part.from, to: part.to, bytes: part.buf.length, chars: part.chars });
    offset = part.to + 1;
    log(`    原文 ${path.split("/").pop()}  第 ${part.from}–${part.to} 轮  ${fmtChars(part.chars)}`);
  }
  return out;
}

/** 解析指针。容忍 `#12-34` 前后有空格，也容忍缺区间（当整份读）。 */
export function parsePtr(ptr) {
  const m = /^(.+?)(?:#(\d+)-(\d+))?$/.exec(String(ptr ?? "").trim());
  if (!m) return null;
  return { path: m[1], from: m[2] ? Number(m[2]) : null, to: m[3] ? Number(m[3]) : null };
}

/**
 * 按指针取回一段原文。返回 `{ turns, missing, truncated, total }`。
 *
 * 顺序读、读到 to 就停：7MB 全量扫描 22ms，不值得为 seek 维护一份行偏移索引。
 * 按 `i` 字段比，不按行号比，这样 meta 行、将来可能加的片段头都不影响定位。
 */
export async function readRange(sy, ptr, { maxChars = 8000 } = {}) {
  const p = parsePtr(ptr);
  if (!p) return { turns: [], missing: false, error: "指针格式不对" };

  const text = await sy.getAsset(p.path);
  if (text == null) return { turns: [], missing: true, total: 0 };

  const out = [];
  let chars = 0;
  let total = 0;
  let truncated = false;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // 坏一行不连累别的
    }
    if (row.type === "session") continue;
    const i = Number(row.i);
    if (!Number.isFinite(i)) continue;
    if (p.from != null && i < p.from) continue;
    if (p.to != null && i > p.to) break;
    total++;
    if (chars >= maxChars) {
      truncated = true;
      break;
    }
    out.push({ i, role: row.role, text: row.text });
    chars += String(row.text ?? "").length;
  }
  return { turns: out, missing: false, truncated, total, chars };
}
