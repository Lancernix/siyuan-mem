import { readdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { INBOX_DIR, DONE_DIR, DEAD_DIR, ATTEMPTS_PATH, ensureDirs } from "../util/config.mjs";

/**
 * 写文件要么完整、要么不见。
 *
 * 原来直接 writeFileSync 到目标路径：进程在写到一半时被 kill（容器重建、机器重启），
 * 队列里就留下一个半截 JSON。它每轮都被当成队头读一遍、读不动，后面的会话全堵在
 * 它后面。先写同目录下的临时文件再 rename，rename 是原子的，读到的永远是完整内容。
 *
 * 顺手把权限收到 0600：队列里是会话原文，没必要让同机其他用户读。
 */
function writeAtomic(file, body) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 临时文件可能压根没建出来 */
    }
    throw e;
  }
}

/**
 * 队列就是目录。
 *
 * 思源没开、模型超时、机器重启，写不进去的都留在这里，下次 once 接着处理。
 *
 * `key` 是幂等键：给了就用它当文件名（`sess-<key>.json`），同一份内容重复投递
 * 会落到同一个文件上，直接判重。跨机器推送时必须这样——边缘机器重装、offset
 * 丢了，会把历史整个重推一遍；没有幂等键，队列里就堆满同样内容的副本。
 * `done/` 也一起查：已经处理完的再推一次，不该重新排队。
 */
export function drop(payload, { key } = {}) {
  ensureDirs();
  const body = JSON.stringify(payload, null, 0);
  const name = key
    ? `sess-${key}.json`
    : `sess-${Date.now()}-${createHash("sha1").update(body).digest("hex").slice(0, 8)}.json`;
  const file = join(INBOX_DIR, name);
  if (key && (existsSync(file) || existsSync(join(DONE_DIR, name)))) {
    return { file: join(DONE_DIR, name), duplicate: true };
  }
  writeAtomic(file, body);
  return { file, duplicate: false };
}

/**
 * 会话增量包的幂等键：哪个机器的哪个会话、从第几轮开始的哪几轮。
 *
 * 起始轮次必须进去。原来只算「会话 + 条数 + 内容哈希」，于是同一场会话里
 * 两段**内容恰好相同**的区间（比如两次一模一样的问答）会算出同一个键，
 * 后一段被中心当成重复拒掉——合法的分片就这么没了。
 */
export function ingestKey({ machine = "", harness = "", session_id: sid = "", turns = [], turnFrom = 1 } = {}) {
  const from = Math.max(1, Number(turnFrom) || 1);
  const body = turns.map((t) => `${t.role}\u0000${t.text}`).join("\u0001");
  const tail = createHash("sha1").update(`${from}\u0002${body}`).digest("hex").slice(0, 12);
  return `${createHash("sha1").update(`${machine}|${harness}|${sid}`).digest("hex").slice(0, 10)}-${from}-${turns.length}-${tail}`;
}

export function pending() {
  ensureDirs();
  return readdirSync(INBOX_DIR)
    .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"))
    .sort()
    .map((f) => join(INBOX_DIR, f));
}

export function readSession(file) {
  const raw = readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) {
    return {
      turns: raw
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean),
    };
  }
  return JSON.parse(raw);
}

export function archive(file) {
  ensureDirs();
  const target = join(DONE_DIR, file.split("/").pop());
  renameSync(file, target);
  clearAttempt(file);
  return target;
}

/**
 * 就地改写队列里的一包内容。
 *
 * 只有一个用途：这一场抽到单会话预算就用完了，把已经抽过的那几轮从 payload 里摘掉，
 * 剩下的下轮接着抽。不摘的话每轮都从头重抽一遍，永远走不到后半段——一场 384 轮的
 * 会话能抽到下辈子。
 */
export function rewrite(file, payload) {
  writeAtomic(file, JSON.stringify(payload));
}

/**
 * 死信：这个会话试到上限了，挪出去别再占着队头。
 *
 * 原文件整个保留，旁边写一份 .why 说明为什么挪的、试了几次、最后一次报什么错；
 * 修好之后 `mv` 回 inbox 就能重跑（文件名没变，幂等键也没变）。
 */
export function deadLetter(file, reason = "") {
  ensureDirs();
  const name = file.split("/").pop();
  const target = join(DEAD_DIR, name);
  renameSync(file, target);
  try {
    writeAtomic(`${target}.why`, `${new Date().toISOString()}\n${reason}\n`);
  } catch {
    // 说明文件写不进去不影响打包本身，死信已经在 dead/ 里了。
  }
  clearAttempt(file);
  return target;
}

function loadAttempts() {
  try {
    return JSON.parse(readFileSync(ATTEMPTS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveAttempts(map) {
  try {
    writeAtomic(ATTEMPTS_PATH, JSON.stringify(map));
  } catch {
    // 记不上账最多是死信永远不触发，比抛出去让整轮挂掉好。
  }
}

/** 这个会话又失败了一次，返回累计次数。 */
export function bumpAttempt(file) {
  const map = loadAttempts();
  const name = file.split("/").pop();
  map[name] = (Number(map[name]) || 0) + 1;
  saveAttempts(map);
  return map[name];
}

export function clearAttempt(file) {
  const map = loadAttempts();
  const name = file.split("/").pop();
  if (name in map) {
    delete map[name];
    saveAttempts(map);
  }
}

export function attemptsOf(file) {
  return Number(loadAttempts()[file.split("/").pop()]) || 0;
}
