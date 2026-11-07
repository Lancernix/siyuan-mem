/**
 * 把条目的日期从「灌库那天」改回「那场对话真正发生的那天」。
 *
 * 为什么需要它：写入时用的是 `new Date()`，所以 652 条全挂在 2026-10-30 上。
 * 冷热分层、按月分文档、按时间回溯，全都建在这个字段上，字段是假的，后面全是空转。
 *
 * 日期取日志文件的 mtime，也就是这场对话**最后一次被写入**的时间。
 * 不用首轮时间：分组标题记的是「日期 · 项目」，人对得上的也是"那天我们聊完"。
 * 长会话跨月的情况，按结束月归，跟分组标题保持一致。
 *
 * 用法：
 *   node scripts/backfill-date.mjs          只报告，不改
 *   node scripts/backfill-date.mjs --apply  真改
 */
import { statSync } from "node:fs";

import { listSessions } from "../src/util/harness.mjs";
import { readLog } from "../src/util/readers/index.mjs";
import { open } from "../src/core/jobs.mjs";

const APPLY = process.argv.includes("--apply");
const BOX = process.env.MEM_BOX || "20261029100254-hk4qbtl";

const p2 = (n) => String(n).padStart(2, "0");
const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};

/** session_id → 日期。一场会话读一次日志，拿它自己的 id。 */
function sessionDates() {
  const map = new Map();
  const list = listSessions();
  let n = 0;
  for (const s of list) {
    let log;
    try {
      log = readLog(s.file);
    } catch {
      continue;
    }
    const id = log?.sessionId;
    if (!id) continue;
    map.set(String(id), dayOf(statSync(s.file).mtimeMs));
    n++;
  }
  console.error(`  读了 ${n} 个会话，拿到 ${map.size} 个 session → date`);
  return map;
}

const { sy, store } = open();

const rows = await sy.sql(
  `SELECT id, ial FROM blocks WHERE type='p' AND box='${BOX}'
     AND ial LIKE '%custom-mem-session="%' LIMIT 5000`
);
const attr = (ial, k) => new RegExp(k + '="([^"]*)"').exec(ial ?? "")?.[1] ?? "";

const dates = sessionDates();

const updates = [];
const unknown = new Map();
const byMonth = new Map();
for (const r of rows) {
  const session = attr(r.ial, "custom-mem-session");
  const cur = attr(r.ial, "custom-mem-date");
  const day = dates.get(session);
  if (!day) {
    unknown.set(session, (unknown.get(session) ?? 0) + 1);
    continue;
  }
  byMonth.set(day.slice(0, 7), (byMonth.get(day.slice(0, 7)) ?? 0) + 1);
  if (day !== cur) updates.push({ id: r.id, date: day });
}

console.log(`\n条目 ${rows.length} 条，可定位日期 ${rows.length - [...unknown.values()].reduce((a, b) => a + b, 0)} 条，需要改 ${updates.length} 条`);
console.log("按月分布：", [...byMonth.entries()].sort().map(([k, v]) => `${k}:${v}`).join("  "));
if (unknown.size) {
  console.log(`认不出日期的会话 ${unknown.size} 个（条目多半来自早期的沙箱或已删除的日志）：`);
  for (const [k, v] of [...unknown.entries()].slice(0, 6)) console.log(`   ${String(k).slice(0, 40)}  ×${v}`);
}

if (!APPLY) {
  console.log("\n（dry，没改。加 --apply 真写）");
  process.exit(0);
}

let ok = 0;
let bad = 0;
for (let i = 0; i < updates.length; i += 40) {
  const chunk = updates.slice(i, i + 40).map((u) => ({ id: u.id, attrs: { "custom-mem-date": u.date } }));
  // #post 成功时返回 null / data，失败才抛；所以这里不检查 code，只看有没有抛。
  try {
    await sy.setBlockAttrsBatch(chunk);
    ok += chunk.length;
  } catch (e) {
    bad += chunk.length;
    console.log("  批量失败", e.message);
  }
}
console.log(`\n改了 ${ok} 条，失败 ${bad} 条`);
