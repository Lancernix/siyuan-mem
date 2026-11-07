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
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { ensureDirs, RAW_INDEX_PATH } from "./config.mjs";

const FORMAT_VERSION = 1;

export function loadRawIndex() {
  let text;
  try {
    text = readFileSync(RAW_INDEX_PATH, "utf8");
  } catch {
    // 文件不存在＝全新安装，不是损坏。空索引是对的。
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    // 坏文件不能当空的：当空的等于"所有 part 都没传过"，下一轮会把整库原文重传一遍，
    // 产生一批重复附件。重复附件又没有正文引用，随后就被"清理未引用资源"扫走——
    // 一次 JSON 解析失败，最后表现为丢原文。改名留证，人和程序都还能看到它坏过。
    const bad = `${RAW_INDEX_PATH}.broken-${Date.now()}`;
    try {
      renameSync(RAW_INDEX_PATH, bad);
    } catch {
      /* 改名都失败就认了，至少不覆盖 */
    }
    return {};
  }
}

export function saveRawIndex(o) {
  ensureDirs();
  // 先写 tmp 再 rename：写到一半断电/被 kill，留下的是一个能解析的旧文件，
  // 而不是半截 JSON。repair.mjs 的账本早就这么写了，这里之前还是直写。
  const tmp = `${RAW_INDEX_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(o, null, 2) + "\n");
  renameSync(tmp, RAW_INDEX_PATH);
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
 * 这场会话已经归档过哪些区间。只读本地索引。
 *
 * 以前还有一条"回思源查 raw-part 块"的兜底，但那批块早就不写了（链接现在挂在
 * 01-条目的分组标题上），所以那条路永远返回空——留着比没有更坏，因为它暗示
 * "索引丢了也能从思源恢复"，而实际上不能。
 *
 * 现在的代价是：raw-index.json 一旦丢了，下次增量会重新上传一遍（附件不覆盖，
 * 只会多出重复文件），不会丢内容，但会脏。要真能自愈，得能按文件名把
 * 轮次范围反推出来，那是另一件事，先记着。
 *
 * 也不查 SQL：块索引是异步的，刚 append 完立刻查是空的，幂等判断会失效。
 */
export function knownParts({ machine, harness, session }) {
  const idx = loadRawIndex();
  return idx[indexKey(machine, harness, session)] ?? [];
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
  if (!turns.length) return [];

  const rawCfg = cfg.raw ?? {};
  if (rawCfg.enabled === false) return [];

  const session = payload.session_id ?? "";
  const from = Math.max(1, Number(payload.turnFrom) || 1);
  const to = from + turns.length - 1;

  const existing = knownParts({
    machine: payload.machine,
    harness: payload.harness,
    session,
  });
  const covered = existing.find((p) => p.from <= from && p.to >= to);
  // path 必须带上：调用方靠它给会话分组项挂 `[原文](assets/…)`，那是附件唯一的
  // 保活引用。漏了这个字段，重跑一遍已归档的会话，链接就全没了——条目属性里
  // 指针还在，但正文里没人引用，下次「清理未引用资源」就把附件扫走。
  if (covered) return [{ skip: true, ptr: null, from, to, path: covered.path, existing: covered }];

  const maxBytes = rawCfg.forcePartBytes ?? 8 * 1024 * 1024;
  const chunks = sliceByBytes({ machine: payload.machine, harness: payload.harness }, turns, maxBytes);
  const dir = `/assets/${safe(rawCfg.dir ?? "mem-raw")}/${safe(payload.machine, "local")}/${safe(payload.harness, "harness")}/`;
  const out = [];

  // 先把每段该覆盖哪几轮算出来。切分只跟 turns 和字节预算有关，跟"已经传过什么"无关，
  // 所以重试时会切出一模一样的段——必须跳过已经传过的，否则第 2 段失败之后整批重传，
  // 索引里会出现 9 段内容重叠的附件，指针都说不清该指哪份。
  const ranges = [];
  for (let o = from, k = 0; k < chunks.length; k++) {
    ranges.push([o, o + chunks[k].length - 1]);
    o += chunks[k].length;
  }

  let uploaded = 0;
  for (let k = 0; k < chunks.length; k++) {
    const chunk = chunks[k];
    const [a, b] = ranges[k];
    const done = existing.find((p) => p.from <= a && p.to >= b);

    const meta = {
      machine: payload.machine ?? "",
      harness: payload.harness ?? "",
      session,
      cwd: payload.cwd ?? "",
      date: payload.date ?? "",
      from: a,
    };
    const part = buildPart(meta, chunk);
    if (part.from !== a || part.to !== b) throw new Error(`分段范围算错了：${part.from}-${part.to} vs ${a}-${b}`);

    if (done) {
      // 这一段上轮已经传成功了。不重传，但要出现在返回值里——调用方靠 parts 算指针。
      out.push({ ptr: `${done.path}#${done.from}-${done.to}`, path: done.path, from: done.from, to: done.to, reused: true });
      log(`    原文已存在 ${String(done.path).split("/").pop()}  第 ${done.from}–${done.to} 轮`);
      continue;
    }
    if (dry) {
      out.push({ dry: true, from: part.from, to: part.to, bytes: part.buf.length, chars: part.chars });
      continue;
    }

    uploaded++;
    const name = `${safe(session || `log-${Date.now()}`, "session").slice(0, 28)}.p${existing.length + uploaded}.jsonl`;
    const path = await sy.uploadAsset(dir, name, part.buf, "application/x-ndjson");
    const ptr = `${path}#${part.from}-${part.to}`;

    // 不再建「02-原文」的引用块：实测块正文里出现附件路径就算「被引用」，
    // 所以引用由条目的会话分组项承担（见 store.#anchorFor）。少一个文档、少一次写。
    const idx = loadRawIndex();
    const key = indexKey(payload.machine, payload.harness, session);
    idx[key] = [...(idx[key] ?? existing), { path, from: part.from, to: part.to }];
    saveRawIndex(idx);
    existing.push({ path, from: part.from, to: part.to });

    out.push({ ptr, path, from: part.from, to: part.to, bytes: part.buf.length, chars: part.chars });
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

/**
 * 去掉正文末尾那截原文附件地址。
 *
 * 条目正文挂着 `[原文](assets/mem-raw/…)`，思源的 `content` 列会把链接的 href
 * 一起吐出来，于是每条都拖着一串 70-100 字的路径。三个后果：
 *
 *   1. 召回结果里路径出现两遍（正文一遍、指针一遍），吃掉显示预算；
 *   2. 相似度把它当正文算——同一场会话的条目共用这串路径，几十个二元组足以
 *      把两条不相干的东西顶到 0.6 以上（find-dups 正是被这个坑过一轮）；
 *   3. 给模型看的正文里夹着一段没有意义的路径。
 *
 * 用属性里的 raw 精确切，不靠正则去猜路径长什么样。
 */
export function stripRawLink(s, raw = "") {
  let t = String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
  if (raw) {
    const i = t.lastIndexOf(raw);
    if (i >= 0) t = t.slice(0, i).replace(/\s*原文\s*$/, "").trim();
  }
  // 属性缺失时的兜底：条目链接的锚文本固定是「原文」。
  return t.replace(/\s*原文\s+assets\/\S+\s*$/, "").trim();
}
