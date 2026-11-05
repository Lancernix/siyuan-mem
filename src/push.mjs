/**
 * 边缘机器：把本机日志解析成 turns，只把新增的部分推给中心。
 *
 * 为什么解析在边缘做、而不是把日志文件整个传过去：
 *
 *   1. 日志可能正在被写，传文件等于传一个动了的目标；解析后只取完整轮次，安全；
 *   2. 体积差一个数量级（106 个会话 500MB，解析后 368 万字）；
 *   3. 解析器就跟着同一个二进制走，五家格式的知识只有一份。
 *
 * 这里不碰模型、不碰思源，所以边缘机器只需要一个可执行文件和一个地址。
 */
import { statSync } from "node:fs";
import { loadConfig, loadOffsets, saveOffsets, offsetsOf, machineId, slicePlan } from "./config.mjs";
import { listSessions } from "./harness.mjs";
import { readLog } from "./readers/index.mjs";

/**
 * 按字符数切块。一个会话可能有几千轮，单次请求太大会顶到服务端上限，
 * 切开还能让中心更早开始抽第一批。
 */
export function splitTurns(turns, maxChars = 800_000) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const t of turns) {
    const n = t.text.length;
    // 单条就超预算：它自己成一块，不对半切——切了就不是原话了。
    if (cur.length && chars + n > maxChars) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(t);
    chars += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function request(url, { method = "GET", token = "", body, timeoutMs = 120_000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const e = new Error(parsed?.error ?? `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return parsed;
}

/** 只验地址和 token，不发会话。 */
export async function pingPush({ to, token }) {
  const base = String(to).replace(/\/+$/, "");
  // ping 现在也要求 token（它原来会白告 auth 状态和队列长度）。不带的话
  // `mem push --test` 会在第一步就被自己的鉴权打回，看着像地址配错了。
  const info = await request(`${base}/api/ping`, { token });
  const probe = await request(`${base}/api/ingest?probe=1`, { method: "POST", token });
  return { ...info, ...probe };
}

/**
 * 推一轮。
 *
 * 顺序和中心那边一样讲究：读日志 → 推送 → 全部成功才记偏移。中途失败就停在
 * 旧的偏移上，下次整段重推；服务端按内容哈希判重，重推不会写两遍。
 */
export async function pushOnce({
  to,
  token = "",
  machine = machineId(),
  log = () => {},
  dry = false,
  sessions = listSessions(),
  quietSeconds = 180,
  maxChars = 800_000,
  limit = 8,
} = {}) {
  if (!to) throw new Error("没有中心地址：mem push --to http://中心:7788，或者写进 config 的 push.to");

  const all = loadOffsets();
  const offsets = offsetsOf(all, machine);
  const now = Date.now();
  const quietMs = quietSeconds * 1000;

  const sum = { scanned: sessions.length, sessions: 0, turns: 0, chars: 0, duplicates: 0, failed: 0, skipped: 0, left: 0 };
  const candidates = [];

  for (const s of sessions) {
    const prev = offsets[s.file];
    // 只比体积会漏掉"同尺寸重写"（日志被改写、同一段长度刚好一样）。
    // 老记录没有 mtimeMs：退回只比体积，别把"不知道"当成"变了"。
    if (prev && prev.bytes === s.size && (prev.mtimeMs == null || prev.mtimeMs === s.mtime)) continue;
    // 还在写的会话先别推：切出来全是半句话，而且下一轮还得再推一遍。
    if (now - s.mtime < quietMs && (!prev || s.size >= prev.bytes)) continue;
    candidates.push(s);
  }

  for (const s of candidates.slice(0, limit)) {
    let log_;
    try {
      log_ = readLog(s.file);
    } catch (e) {
      log(`  ! 读不动：${s.file.replace(process.env.HOME, "~")}（${e.message}）`);
      sum.failed++;
      continue;
    }
    if (!log_.turns.length) {
      offsets[s.file] = { bytes: s.size, mtimeMs: s.mtime, turns: 0, at: Date.now(), empty: true };
      sum.skipped++;
      continue;
    }
    if (log_.skipped === "subagent") {
      offsets[s.file] = { bytes: s.size, mtimeMs: s.mtime, turns: 0, at: Date.now(), skipped: "subagent" };
      sum.skipped++;
      continue;
    }

    const prev = offsets[s.file];
    const plan = slicePlan(prev, { size: s.size, mtime: s.mtime }, log_.turns.length);
    const turns = log_.turns.slice(plan.from);
    if (!turns.length) {
      offsets[s.file] = { bytes: s.size, mtimeMs: s.mtime, turns: log_.turns.length, at: Date.now() };
      sum.skipped++;
      continue;
    }

    const chunks = splitTurns(turns, maxChars);
    const where = s.file.replace(process.env.HOME, "~");
    if (dry) {
      log(`  ${log_.harness}  ${chunks.length} 包 / ${turns.length} 轮  ${where}`);
      sum.sessions++;
      sum.turns += turns.length;
      sum.chars += turns.reduce((n, t) => n + t.text.length, 0);
      continue;
    }

    let sent = 0;
    let dups = 0;
    try {
      let start = fresh ? (prev.turns ?? 0) : 0;
      for (const chunk of chunks) {
        const r = await request(`${String(to).replace(/\/+$/, "")}/api/ingest`, {
          method: "POST",
          token,
          body: {
            machine,
            harness: log_.harness,
            session_id: log_.sessionId || `log-${Date.now()}`,
            cwd: log_.cwd,
            date: new Date().toISOString().slice(0, 10),
            range: [start, start + chunk.length],
            turns: chunk,
          },
        });
        start += chunk.length;
        if (r.duplicate) dups++;
        else sent += r.accepted ?? chunk.length;
      }
    } catch (e) {
      sum.failed++;
      log(`  ! 推失败：${where}（${e.message}）`);
      continue;
    }

    // 全部分片成功才推进：中途失败就留在旧位置，下次整段重推，服务端判重。
    offsets[s.file] = { bytes: s.size, mtimeMs: s.mtime, turns: log_.turns.length, at: Date.now() };
    saveOffsets(all);
    sum.sessions++;
    sum.turns += turns.length;
    sum.chars += turns.reduce((n, t) => n + t.text.length, 0);
    sum.duplicates += dups;
    log(`  ${log_.harness}  ${turns.length} 轮 / ${chars(turns)} 字  ${chunks.length > 1 ? `${chunks.length} 包 ` : ""}${where}${dups ? `（${dups} 包重复）` : ""}`);
  }

  if (!dry) saveOffsets(all);
  sum.left = Math.max(0, candidates.length - limit);
  return sum;
}

const chars = (turns) => turns.reduce((n, t) => n + t.text.length, 0);

/** 常驻推送。间隔比中心宽松：边缘这一侧要做的只有读文件和发请求。 */
export async function pushWatch(opts = {}) {
  const cfg = loadConfig();
  const gap = (opts.intervalSeconds ?? cfg.push?.intervalSeconds ?? 120) * 1000;
  let stop = false;
  const onSignal = () => {
    if (stop) process.exit(1);
    stop = true;
    opts.log?.("收到信号，这一轮跑完就退");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  for (let round = 1; !stop; round++) {
    try {
      const r = await pushOnce({ ...opts, log: opts.log ?? (() => {}) });
      opts.log?.(
        `第 ${round} 轮：扫描 ${r.scanned}，推送 ${r.sessions} 个会话 / ${r.turns} 轮，` +
          `重复 ${r.duplicates} 包，失败 ${r.failed}${r.left ? `，还有 ${r.left} 个下轮继续` : ""}`
      );
    } catch (e) {
      opts.log?.(`第 ${round} 轮失败：${e.message}`);
    }
    if (stop) break;
    const t0 = Date.now();
    while (!stop && Date.now() - t0 < gap) await new Promise((r) => setTimeout(r, 1000));
  }
}
