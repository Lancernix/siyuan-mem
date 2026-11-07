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
import { HOME_DIR, ensureDirs, loadConfig, loadOffsets, offsetsOf, machineId, LOCK_PATH, LOG_PATH } from "../util/config.mjs";
import { listSessions } from "../util/harness.mjs";
import { enqueueLog, processQueue, assertModel } from "./jobs.mjs";
import { event } from "../util/log.mjs";
import { SiYuan } from "../util/siyuan.mjs";
import { startUi } from "./ui.mjs";
import { startIngest } from "./ingest.mjs";

export { LOCK_PATH, LOG_PATH };

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

/**
 * 同一时刻只许一轮在跑。
 *
 * 进程锁挡的是"第二个进程"，挡不住同一个进程里的两条异步流：面板上点「跑一轮」，
 * 走的是另一个入口，和定时那一轮各跑各的 `processQueue`，两边同时往同一批块上
 * append、同时改 supersede 标记。思源没有行级合并，撞上去只表现为"偶尔有条目写到
 * 一半"或"旧条目没被标过时"——不报错，最难查。
 *
 * 所以这里在进程内加一道单飞：谁先来谁跑，后来者直接被告知"等它跑完"。
 */
let inFlight = null;
let inFlightKind = "";
let inFlightSince = 0;

export function roundStatus() {
  return inFlight
    ? { running: true, kind: inFlightKind, seconds: Math.round((Date.now() - inFlightSince) / 1000) }
    : { running: false };
}

export function beginRound(kind, fn) {
  if (inFlight) {
    throw new Error(
      `有一轮正在跑（${inFlightKind}，已 ${Math.round((Date.now() - inFlightSince) / 1000)} 秒），等它跑完再来`
    );
  }
  inFlightKind = kind;
  inFlightSince = Date.now();
  inFlight = (async () => {
    try {
      return await fn();
    } finally {
      inFlight = null;
      inFlightKind = "";
      inFlightSince = 0;
    }
  })();
  return inFlight;
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

  // 只看本机的偏移：中心机器自己也可能跑着 harness。
  const offsets = offsetsOf(loadOffsets(), machineId());
  const now = Date.now();
  const sessions = listSessions();
  const candidates = [];

  for (const s of sessions) {
    const prev = offsets[s.file];
    // 老记录没有 mtimeMs：那就只认体积（回到原来的行为），别把"不知道"当成"变了"。
    // 注意字段名是 mtime 不是 mtimeMs——listSessions 返回的就是 mtime，
    // 写成 s.mtimeMs 会恒为 undefined，于是每轮都把已补 mtime 的会话当成"变了"，
    // 反复读取解压，再由 enqueueLog 发现没新轮次。日志上看不出错，只是白烧 CPU。
    if (prev && prev.bytes === s.size && (prev.mtimeMs == null || prev.mtimeMs === s.mtime)) continue;
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

  // 一轮的预算：默认 20 个会话 / 20 分钟。跑不完留到下一轮，队列是持久的。
  // 不设预算的话，一次全量迁移就能让一轮跑四小时，期间心跳不动、新数据插不进来。
  const sum = await processQueue({
    dry,
    useModel,
    onLine: log,
    maxSessions: cfg.serve?.maxSessionsPerRound ?? 20,
    maxMs: (cfg.serve?.maxMinutesPerRound ?? 20) * 60_000,
  });
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

  // 起不来比起一直重试好：没 key 的时候每轮都会失败在同一个地方，日志只会刷屏。
  // 这里"干净退出"（exit 0）是有意的：launchd 的 KeepAlive 只对失败重启，
  // 配置不对就退出而不是每 30 秒撞一次同一个墙。
  try {
    assertModel(cfg, { useModel, dry });
  } catch (e) {
    log(`配置问题，这次不启动：${e.message.split("\n")[0]}`);
    log("  配好之后：mem service install 再装一次，或 launchctl kickstart -k gui/$(id -u)/com.siyuan.mem");
    return;
  }

  acquire({ force, log });
  log(
    `启动 pid ${process.pid}，每 ${Math.round(gap / 60_000)} 分钟一轮${once ? "（单轮）" : ""}` +
      `${dry ? "，--dry 不写思源" : ""}${useModel ? "" : "，--no-model 走规则抽取"}`
  );

  // 面板跟着常驻进程起：没有它就只能 tail 日志。绑定在 127.0.0.1，没有鉴权，
  // 所以绝不绑 0.0.0.0——局域网里任何设备都能读你的记忆库。
  let ui = null;
  if (cfg.ui?.enabled !== false && !once) {
    try {
      ui = startUi({
        port: cfg.ui?.port ?? 7787,
        // 面板那一轮也要在 serve.log 里留痕：不然"我刚点了一下"和"什么都没发生"
        // 在日志上长得一样，排查时会怀疑按钮坏了。
        runRound: async () => {
          const t0 = Date.now();
          log("面板手动触发一轮");
          const r = await beginRound("面板", () => runRound({ dry, useModel, log }));
          log(`面板那一轮 ${((Date.now() - t0) / 1000).toFixed(1)}s：写入 ${r.written} 条，跳过 ${r.skipped}，失败 ${r.failed}`);
          event("round", {
            no: 0,
            trigger: "panel",
            ms: Date.now() - t0,
            scanned: r.scanned,
            enqueued: r.enqueued,
            written: r.written,
            skipped: r.skipped,
            failed: r.failed,
            degraded: r.degraded ?? 0,
            tokens: r.tokens ?? { prompt: 0, completion: 0 },
          });
          return r;
        },
      });
      log(`面板 ${ui.url}`);
    } catch (e) {
      log(`  面板起不来（${e.message}），继续跑`);
    }
  }

  // 接收端只给别的机器用；单机不需要它，所以默认关。开了就必须有 token，
  // 否则 startIngest 会抛错——写入通道不能裸奔。
  let ingest = null;
  if (cfg.ingest?.enabled && !once) {
    try {
      ingest = startIngest({
        port: cfg.ingest.port ?? 7788,
        bind: cfg.ingest.bind ?? "127.0.0.1",
        token: cfg.ingest.token ?? "",
        maxBytes: cfg.ingest.maxBytes,
        log,
      });
      log(`接收端 ${ingest.url}/api/ingest${cfg.ingest.token ? "" : "（无 token，只接受本机）"}`);
    } catch (e) {
      log(`  接收端起不来：${e.message.split("\n")[0]}`);
    }
  }

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
      const r = await beginRound("定时", () => runRound({ dry, useModel, log }));
      failures = 0;
      lastError = null;
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      log(
        `第 ${roundNo} 轮 ${secs}s：思源 v${r.version}，扫描 ${r.scanned} 个会话，` +
          `新投 ${r.enqueued} 个（${r.turns} 轮），写入 ${r.written} 条，跳过 ${r.skipped}，失败 ${r.failed}` +
            (r.tokens?.prompt ? `，tokens ${r.tokens.prompt}+${r.tokens.completion}` : "")
      );
      if (r.degraded) log(`  · ${r.degraded} 个会话抽取不完整，原文留在队列里等重试`);
      if (!r.candidates && !r.sessions) log("  队列空，也没有新会话");
      event("round", {
        no: roundNo,
        ms: Date.now() - t0,
        scanned: r.scanned,
        enqueued: r.enqueued,
        written: r.written,
        skipped: r.skipped,
        failed: r.failed,
        degraded: r.degraded ?? 0,
        tokens: r.tokens ?? { prompt: 0, completion: 0 },
      });
    } catch (e) {
      // 面板那一轮还没跑完不算故障：不记账、不退避，等下一轮就好。
      if (/有一轮正在跑/.test(e.message)) {
        log(`第 ${roundNo} 轮跳过：${e.message}`);
      } else {
        failures++;
        lastError = e;
        wait = backoff(failures);
        event("error", { where: "round", no: roundNo, message: e.message });
        log(`第 ${roundNo} 轮失败：${e.message}（连续 ${failures} 次，${Math.round(wait / 1000)} 秒后再试）`);
      }
    }

    if (once || stop) break;
    log(`下一轮 ${new Date(Date.now() + wait).toLocaleTimeString("zh-CN", { hour12: false })}`);
    await sleep(wait, () => stop);
  }

  if (ui) await ui.close().catch(() => {});
  if (ingest) await ingest.close().catch(() => {});
  release();
  if (lastError) {
    process.exitCode = 1;
    log(`退出（有未恢复的错误）：${lastError.message}`);
  } else {
    log(`退出（跑了 ${roundNo} 轮）`);
  }
}
