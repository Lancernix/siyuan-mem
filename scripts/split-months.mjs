/**
 * 把 01-条目 拆成按月文档：/01-条目/2026-10。
 *
 * 为什么拆：一个文档装 691 条、15.6 万字以后，大纲、移动端、全文搜索都开始变慢，
 * 而我们每次重建视图还要遍历全篇。按月是因为一个月 150-250 条、4-6 万字，
 * 正好在思源舒服的区间，而且「上个月我们在弄 mcp-adapter」是人的记忆刻度。
 *
 * 迁移只搬块（事务 action=move），不重建：块 id 不变，条目属性、02-实体 里的
 * 引用、原文指针全都跟着走，不用重抽。
 *
 * 顺序：每篇里按日期升序重排，否则现在是「写入顺序」，日期是跳的。
 * 一个月里的分组 = 一个会话的标题 + 它下面那个列表，两个块要一起搬且相邻。
 *
 * 用法：
 *   node scripts/split-months.mjs          只出迁移表
 *   node scripts/split-months.mjs --apply  真搬
 */
import fs from "node:fs";

import { open } from "../src/core/jobs.mjs";

const APPLY = process.argv.includes("--apply");
const BOX = process.env.MEM_BOX || "20261029100254-hk4qbtl";
const MERGE = { "2026-05": "2026-06" }; // 5 月只有 1 条，单开太碎

const { sy, store } = open();

// 标题正文里就写着日期，直接读它，比再从日志推一遍稳。
const heads = await sy.sql(
  `SELECT id, content FROM blocks WHERE type='h' AND box='${BOX}' AND content LIKE '%·%' LIMIT 500`
);
const dateOf = new Map();
for (const h of heads) {
  const t = String(h.content ?? "").replace(/<[^>]+>/g, "");
  const m = /(\d{4}-\d{2}-\d{2})/.exec(t);
  if (m) dateOf.set(h.id, m[1]);
}

const groups = JSON.parse(fs.readFileSync(process.env.HOME + "/.siyuan-mem/entry-groups.json", "utf8"));
const plan = [];
const missing = [];
for (const [session, g] of Object.entries(groups)) {
  const day = dateOf.get(g.heading);
  if (!day) { missing.push(session); continue; }
  let month = day.slice(0, 7);
  month = MERGE[month] ?? month;
  plan.push({ session, heading: g.heading, list: g.list, day, month });
}
plan.sort((a, b) => a.day.localeCompare(b.day));

const byMonth = new Map();
for (const p of plan) {
  if (!byMonth.has(p.month)) byMonth.set(p.month, []);
  byMonth.get(p.month).push(p);
}

console.log(`分组 ${plan.length}，分到 ${byMonth.size} 个月；找不到日期 ${missing.length}`);
for (const [month, list] of [...byMonth.entries()].sort()) {
  console.log(`  ${month}  ${list.length} 组  ${list[0].day} → ${list.at(-1).day}`);
}
if (!APPLY) {
  console.log("\n（dry，没搬。加 --apply 真搬）");
  process.exit(0);
}

// 文档先建好，记进 state 的 months，写入路径后面就照这个走。
const docOf = new Map();
for (const month of [...byMonth.keys()].sort()) {
  docOf.set(month, await store.entriesDocFor(`${month}-01`));
}
console.log("\n月文档：");
for (const [m, id] of docOf) console.log(`  ${m}  ${id}`);

// 一个一个搬：标题先落到目标文档末尾，列表紧跟其后。
const move = (id, parentID, previousID) =>
  sy.transaction([{ action: "move", id, parentID, previousID }]);

let moved = 0;
let failed = 0;
for (const [month, list] of [...byMonth.entries()].sort()) {
  const doc = docOf.get(month);
  let prev = "";
  for (const g of list) {
    try {
      await move(g.heading, doc, prev);
      await move(g.list, doc, g.heading);
      prev = g.list;
      moved++;
    } catch (e) {
      failed++;
      console.log(`  ! ${month} ${g.session.slice(0, 16)} 搬不动：${e.message}`);
    }
  }
  console.log(`  ${month} 搬完 ${list.length - failed} 组`);
}
console.log(`\n搬了 ${moved} 组，失败 ${failed} 组`);
