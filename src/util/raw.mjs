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
 * 指针形如 `assets/mem-raw/laptop/workbuddy/xxx.p1-20261029230812-abcd.jsonl#120-180`：
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

/* ---------------- 原文锚点收窄 ---------------- */

/**
 * 从一条结论里抽出「能跟原文对上」的词。
 *
 * 分两类，因为它们的证明力完全不同：
 *   - 硬锚：文件名、参数名、端口、报错串、版本号这类 ASCII 串。模型可以改写句子，
 *     但基本不会凭空造出 `maxCharsPerCall` 或 `20261110041950`。命中了就是强证据。
 *   - 软锚：中文二字片段。结论是改写过的，原文里不会有整句；只能靠这些碎片判断
 *     「这段话大体是从哪几行来的」。只能当排序信号，不能当通过线。
 *
 * 之所以不能照搬 live-compact 的「硬行逐字校验」：那边的卡片是逐字摘录，逐字比
 * 是自洽的；我们这里存的是模型生成的结论，逐字比必然全灭。能机械验证的只有锚点。
 */
export function anchorsOf(text) {
  const clean = String(text ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/assets\/\S+/g, " ") // 指针本身不算证据，同一批条目都带着同一串路径
    .replace(/\s*原文\s*$/, "");
  const hard = [
    ...new Set(
      (clean.match(/[A-Za-z0-9_./\\-]{3,}/g) ?? [])
        .map((s) => s.toLowerCase().replace(/^[-./]+|[-./]+$/g, ""))
        .filter((s) => s.length >= 3 && /[a-z0-9]/.test(s))
    ),
  ];
  const han = clean.replace(/[^\u4e00-\u9fa5]/g, "");
  const soft = new Set();
  for (let i = 0; i + 1 < han.length; i++) soft.add(han.slice(i, i + 2));
  return { hard: [...hard], soft: [...soft] };
}

/**
 * 把「整批共用的粗指针」收窄到真正出处的那几轮。
 *
 * @param {string} text   条目正文（模型生成的结论）
 * @param {Array}  turns  会话原始 turns（**本地就有**，不用下载附件），下标与 e.from/e.to 同一坐标系
 * @param {number} from   批范围起（局部下标，含）
 * @param {number} to     批范围止（局部下标，含）
 * @returns {{from:number,to:number,narrowed:boolean,reason:string,rows:number}}
 *
 * 保守是这儿的第一原则：**收窄错了比宽更糟**。宽了顶多多读几轮，窄了会把真正的
 * 出处排除在外，而且看不出来。所以三条硬约束任一不满足就原样返回：
 *   1. 所有「有区分度的硬锚」命中的行必须都在窗口内（跨轮归纳就自然不收窄）；
 *   2. 窗口要保住原范围里 80% 以上的软锚证据；
 *   3. 真的缩了 20% 以上，且原范围至少 4 行。
 */
export function narrowAnchor(text, turns, from, to) {
  const keep = (reason) => ({ from, to, narrowed: false, reason, rows: to - from + 1 });
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) return keep("bad-range");
  if (to - from + 1 < 4) return keep("already-tight");

  const { hard, soft } = anchorsOf(text);
  if (!hard.length && !soft.length) return keep("no-anchor");

  const rows = [];
  for (let k = from; k <= to; k++) {
    const t = String(turns?.[k]?.text ?? turns?.[k]?.content ?? "");
    rows.push({ k, text: t, low: t.toLowerCase() });
  }

  // 自适应去噪：在这一批每一行都出现的 token 没有定位力（api / json / node 之类）。
  // 硬编码停用词表换个项目就失效，用「文档频率」更稳。
  const df = new Map();
  for (const h of hard) df.set(h, rows.filter((r) => r.low.includes(h)).length);
  const informative = hard.filter((h) => df.get(h) > 0 && df.get(h) < rows.length);

  for (const r of rows) {
    r.hardHits = informative.filter((h) => r.low.includes(h)).length;
    r.softHits = soft.reduce((n, g) => n + (r.text.includes(g) ? 1 : 0), 0);
    r.score = r.hardHits * 3 + (soft.length ? r.softHits / soft.length : 0);
  }

  const best = rows.reduce((a, b) => (b.score > a.score ? b : a), rows[0]);
  if (!best || best.score <= 0) return keep("no-signal");

  // 以峰值行为种子，向左右扩成一个**连续窗口**，直到装下 80% 的总得分。
  //
  // 不取「所有硬锚命中行的包络」：同一个词在同话题会话里会反复出现（`nginx`、
  // `node:22-alpine` 之类），几十行里零散命中十几行，包络一撑就回到整批，等于没缩
  // （实测 160 条里只缩了 7 条）。按得分密度扩，零散命中自然留在窗口外，代价由
  // 下面「硬锚种类一个都不能少」兜住。
  const totalScore = rows.reduce((n, r) => n + r.score, 0);
  const at = (k) => rows[k - from];
  let a = best.k;
  let b = best.k;
  let acc = best.score;
  while (totalScore > 0 && acc / totalScore < 0.8 && (a > from || b < to)) {
    const l = a > from ? at(a - 1).score : -1;
    const r = b < to ? at(b + 1).score : -1;
    if (l >= r && l >= 0) {
      a--;
      acc += l;
    } else if (r >= 0) {
      b++;
      acc += r;
    } else break;
  }
  // 再各扩一行，点开指针能看到一问一答的上下文，不至于只剩半句话。
  a = Math.max(from, a - 1);
  b = Math.min(to, b + 1);

  // 约束 1：每种硬锚在窗口里至少还能找到一次。不要求「命中行全在窗口内」（那被
  // 常见词撑爆了），但种类少了就说明有关键证据被切掉，必须原样返回。
  const winText = rows.filter((r) => r.k >= a && r.k <= b).map((r) => r.low).join("\n");
  if (informative.some((h) => rows.some((r) => r.low.includes(h)) && !winText.includes(h))) {
    return keep("hard-outside");
  }
  // 约束 2：结论里 80% 的中文片段在窗口里还得找得到（防止把跨轮归纳的结论硬塞
  // 进两行里）。按**种类**算，不按出现次数——「记忆」「判重」这种词在同话题会话里
  // 几十行都有，用次数当分母会把分母撑爆，真正能收窄的条目全被判成 scattered-soft。
  const fullText = rows.map((r) => r.text).join("\n");
  const softTotal = soft.filter((g) => fullText.includes(g)).length;
  const softKept = soft.filter((g) => winText.includes(g)).length;
  if (softTotal > 0 && softKept / softTotal < 0.8) return keep("scattered-soft");
  // 约束 3：没缩多少就别折腾。
  if (b - a + 1 > (to - from + 1) * 0.8) return keep("no-gain");

  return { from: a, to: b, narrowed: true, reason: "anchored", rows: b - a + 1 };
}
