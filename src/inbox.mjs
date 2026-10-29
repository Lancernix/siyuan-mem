import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { INBOX_DIR, DONE_DIR, ensureDirs } from "./config.mjs";

/**
 * 队列就是目录。
 *
 * 思源没开、模型超时、机器重启，写不进去的都留在这里，下次 once 接着处理。
 * 文件名带内容哈希，同一份会话重复投递不会处理两遍。
 */
export function drop(payload) {
  ensureDirs();
  const body = JSON.stringify(payload, null, 0);
  const name = `sess-${Date.now()}-${createHash("sha1").update(body).digest("hex").slice(0, 8)}.json`;
  const file = join(INBOX_DIR, name);
  writeFileSync(file, body);
  return file;
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
