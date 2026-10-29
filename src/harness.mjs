/**
 * 找出本机上所有 harness 的会话日志。
 *
 * 这里只做发现和统计，不做解读——解读在 readers.mjs。
 * 分开的理由：路径会变（各家改版本就换目录），读取逻辑不该跟着动。
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 已知的会话根目录。match 只判断文件名，目录层级由 walk 处理。 */
export const ROOTS = [
  {
    harness: "workbuddy",
    dir: "~/.workbuddy/projects",
    match: (f) => f.endsWith(".jsonl"),
    // 同目录下还有 *.file-rollback.ndjson（文件回滚记录），不是对话。
    skip: (f) => /\.(file-rollback|meta)\./.test(f),
  },
  { harness: "qoder", dir: "~/.qoder/projects", match: (f) => f.endsWith(".jsonl") },
  { harness: "claude", dir: "~/.claude/projects", match: (f) => f.endsWith(".jsonl") },
  { harness: "omp", dir: "~/.omp/agent/sessions", match: (f) => f.endsWith(".jsonl") },
  {
    harness: "dsh",
    dir: "~/.dsh/sessions",
    match: (f) => f === "session.v4.jsonl.zstd" || f === "session.v4.jsonl",
  },
];

function expand(dir) {
  return dir.startsWith("~") ? join(homedir(), dir.slice(1)) : dir;
}

function walk(dir, match, skip, out, depth = 0) {
  if (depth > 4) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, match, skip, out, depth + 1);
      continue;
    }
    if (!e.isFile() || !match(e.name)) continue;
    if (skip?.(e.name)) continue;
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    out.push({ file: p, size: st.size, mtime: st.mtimeMs });
  }
}

/**
 * 列出全部会话文件。
 * @returns {{harness:string,file:string,size:number,mtime:number}[]}
 */
export function listSessions(only = "") {
  const out = [];
  for (const root of ROOTS) {
    if (only && root.harness !== only) continue;
    const found = [];
    walk(expand(root.dir), root.match, root.skip, found);
    for (const f of found) out.push({ harness: root.harness, ...f });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 按 harness 分组统计：会话数、总字节、最新时间。 */
export function summarize(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const g = map.get(s.harness) ?? { harness: s.harness, count: 0, bytes: 0, newest: 0 };
    g.count++;
    g.bytes += s.size;
    g.newest = Math.max(g.newest, s.mtime);
    map.set(s.harness, g);
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes);
}
