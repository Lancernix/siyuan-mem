import { readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { INBOX_DIR, DONE_DIR, ensureDirs } from "../util/config.mjs";

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
  writeFileSync(file, body);
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
  return target;
}
