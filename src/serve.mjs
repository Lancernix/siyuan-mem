/**
 * mem serve —— 常驻调度。
 *
 * 三件 `mem once` 做不了的事：
 *
 *   1. 进程锁：思源没有行级合并，两个进程同时写同一份文档会整块覆盖；
 *   2. 节奏：会话还在写的时候不要每十分钟切一刀，等它安静下来再投；
 *   3. 退避：思源没开、模型 429 的时候不要连着重试，越急越糟。
 *
 * 一轮的顺序是固定的：先探思源活着没有 → 再看有没有新会话 → 最后才调模型抽取。
 * 反过来先抽再写，等于思源一天没开、模型的钱就白花一天。
 */
import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  appendFileSync,
  statSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { HOME_DIR, ensureDirs, loadConfig, loadOffsets } from "./config.mjs";
import { listSessions } from "./harness.mjs";
import { enqueueLog, processQueue } from "./jobs.mjs";
import { SiYuan } from "./siyuan.mjs";

export const LOCK_PATH = join(HOME_DIR, "serve.lock");
export const LOG_PATH = join(HOME_DIR, "serve.log");

/** 单轮失败后第一次等 1 分钟，之后翻倍，最多 30 分钟。 */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;

/** 锁里记 host：换了机器或重启过，pid 就不可信了。 */
function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid, host) {
  if (!pid) return false;
  if (host && host !== hostname()) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM：进程在，只是不归我管。
    return e.code === "EPERM";
  }
}

/** 给 `mem status` 看的：服务在不在、跑到第几轮、上次心跳什么时候。 */
export function lockInfo() {
  const info = readLock();
  if (!info) return { running: false };
  return { ...info, running: alive(info.pid, info.host) };
}

function writeLock(patch) {
  const body = JSON.stringify(patch, null, 2) + "\n";
  writeFileSync(LOCK_PATH, body);
}

/**
 * 拿锁。用 O_EXCL 建文件，靠内核保证"只有一个进程能建成"。
 * 文件已存在时先看持锁进程还在不在：kill -9、断电、重启都会留下孤锁。
 */
export function acquire({ force = false, log = () => {} } = {}) {
  ensureDirs();
  const base = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    round: 0,
    at: Date.now(),
  };

  try {
    const fd = openSync(LOCK_PATH, "wx");
    writeSync(fd, JSON.stringify(base, null, 2) + "\n");
    closeSync(fd);
    return { pid: process.pid };
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }

  const info = readLock();
  if (info && alive(info.pid, info.host) && !force) {
    const since = info.startedAt ? new Date(info.startedAt).toLocaleString() : "?";
    throw new Error(
      `已经有一个 mem serve 在跑（pid ${info.pid}，${since} 启动，第 ${info.round ?? 0} 轮）。\n` +
        `  要接手先停掉它；确认它是僵尸进程再加 --force。`
    );
  }
  log(`接管上一把锁（pid ${info?.pid ?? "?"} 已不在，${info?.host ?? "?"}）`);
  writeLock(base);
  return { pid: process.pid };
}

/** 只删自己的锁：被别人 --force 接管之后，退出时不能把新人的锁删掉。 */
export function release() {
  const info = readLock();
  if (info?.pid === process.pid) {
    try {
      unlinkSync(LOCK_PATH);
    } catch {}
  }
}

function heartbeat(round) {
  const info = readLock();
  if (info?.pid !== process.pid) throw new Error("锁已被别的进程接管，本轮作废");
  writeLock({ ...info, round, at: Date.now() });
}

/** 日志用本地时间：UTC 的 07:05 对不上"我下午三点干的"。 */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 日志同时进文件和终端：launchd 下没人看终端，前台跑时又不想 tail 文件。 */
export function makeLogger({ echo = true } = {}) {
  return (line) => {
    const full = `${stamp()}  ${line}`;
    if (echo) console.log(full);
    try {
      if (statSync(LOG_PATH, { throwIfNoEntry: false })?.size > LOG_MAX_BYTES) {
        renameSync(LOG_PATH, `${LOG_PATH}.1`);
      }
      appendFileSync(LOG_PATH, full + "\n");
    } catch {}
  };
}

function backoff(failures) {
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(failures - 1, 5), RETRY_MAX_MS);
}

/** 可中断的等待：收到退出信号不用等满十分钟。 */
function sleep(ms, stopped) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (stopped() || Date.now() - t0 >= ms) {
        clearInterval(tick);
        resolve();
      }
    }, 500);
  });
}

/**
 * 一轮。
 *
 * 只读"体积变过"的文件：105 个会话共 500MB，每十分钟全解析一遍纯属浪费，
 * 而 stat 一个文件是微秒级的。体积没变就不可能出新内容。
 */
async function runRound({ dry, useModel, log }) {
  const cfg = loadConfig();
  const quietMs = (cfg.serve?.quietSeconds ?? 180) * 1000;
  const limit = cfg.serve?.maxSessionsPerRound ?? 8;

  const sy = new SiYuan({ baseUrl: cfg.siyuan.baseUrl, token: cfg.siyuan.token, timeoutMs: 3000 });
  const version = await sy.version(); // 不通就抛，交给外层退避

  const offsets = loadOffsets();
  const now = Date.now();
  const sessions = listSessions();
  const candidates = [];

  for (const s of sessions) {
    const prev = offsets[s.file];
    if (prev && prev.bytes === s.size) continue; // 一个字节没变
    // 还在写的会话先别切：等它安静，或者文件被轮转（变小）就立刻处理。
    if (now - s.mtime < quietMs && (!prev || s.size >= prev.bytes)) continue;
    candidates.push(s);
  }

  let enqueued = 0;
  let turns = 0;
  if (dry) {
    log(`  --dry：只报数，不投递（${candidates.length} 个会话有新内容）`);
  } else {
    for (const s of candidates.slice(0, limit)) {
      try {
        const r = enqueueLog(s.file);
        if (r.added) {
          enqueued++;
          turns += r.added;
          log(`  投递 ${r.harness}  ${r.added} 轮${r.before ? `（跳过前 ${r.before} 轮）` : ""}  ${s.file.replace(process.env.HOME, "~")}`);
        }
      } catch (e) {
        log(`  ! 读不动，下轮再试：${s.file.replace(process.env.HOME, "~")}（${e.message}）`);
      }
    }
  }
  const left = Math.max(0, candidates.length - limit);
  if (left) log(`  还有 ${left} 个待投，下轮继续`);

  const sum = await processQueue({ dry, useModel, onLine: log });
  return { version, scanned: sessions.length, candidates: candidates.length, enqueued, turns, left, ...sum };
}

/**
 * @param {object} opts
 * @param {boolean} opts.once      只跑一轮（给 launchd StartInterval 用）
 * @param {boolean} opts.dry       只打印，不写思源
 * @param {boolean} opts.useModel  默认 true；false 走规则抽取
 * @param {number}  opts.intervalMs
 * @param {boolean} opts.force     强行接管锁
 */
export async function serve({ once = false, dry = false, useModel = true, intervalMs, force = false } = {}) {
  const cfg = loadConfig();
  const gap = intervalMs ?? (cfg.serve?.intervalMinutes ?? 10) * 60_000;
  const log = makeLogger();

  acquire({ force, log });
  log(
    `启动 pid ${process.pid}，每 ${Math.round(gap / 60_000)} 分钟一轮${once ? "（单轮）" : ""}` +
      `${dry ? "，--dry 不写思源" : ""}${useModel ? "" : "，--no-model 走规则抽取"}`
  );

  let stop = false;
  const onSignal = (sig) => {
    if (stop) process.exit(1); // 第二次 Ctrl-C：不体面退出了
    stop = true;
    log(`收到 ${sig}，跑完这一轮就退出`);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // 无论怎么退（包括抛异常），锁都要还回去，否则下次启动得人肉删文件。
  process.on("exit", release);

  let roundNo = 0;
  let failures = 0;
  let lastError = null;

  while (!stop) {
    roundNo++;
    const t0 = Date.now();
    let wait = gap;
    try {
      heartbeat(roundNo);
      const r = await runRound({ dry, useModel, log });
      failures = 0;
      lastError = null;
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      log(
        `第 ${roundNo} 轮 ${secs}s：思源 v${r.version}，扫描 ${r.scanned} 个会话，` +
          `新投 ${r.enqueued} 个（${r.turns} 轮），写入 ${r.written} 条，跳过 ${r.skipped}，失败 ${r.failed}`
      );
      if (r.degraded) log(`  · ${r.degraded} 个会话抽取不完整，原文留在队列里等重试`);
      if (!r.candidates && !r.sessions) log("  队列空，也没有新会话");
    } catch (e) {
      failures++;
      lastError = e;
      wait = backoff(failures);
      log(`第 ${roundNo} 轮失败：${e.message}（连续 ${failures} 次，${Math.round(wait / 1000)} 秒后再试）`);
    }

    if (once || stop) break;
    log(`下一轮 ${new Date(Date.now() + wait).toLocaleTimeString("zh-CN", { hour12: false })}`);
    await sleep(wait, () => stop);
  }

  release();
  if (lastError) {
    process.exitCode = 1;
    log(`退出（有未恢复的错误）：${lastError.message}`);
  } else {
    log(`退出（跑了 ${roundNo} 轮）`);
  }
}
