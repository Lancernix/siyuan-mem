/**
 * 把存量条目的粗原文指针收窄到真正出处的那几轮。
 *
 * 新写入的条目在 jobs.mjs 里已经按锚点收窄；这本脚本补的是**之前写进去的那些**——
 * 抽取是「一批一次模型调用」，那批抽出来的 4–10 条共用一个 from/to，指针常常横跨
 * 几十轮、三万多字，点开等于没指。
 *
 * 只改 `custom-mem-raw` 一个属性，不动正文、hash、status，所以判重和状态链不受影响。
 * 收窄是保守的：跨轮归纳、锚点分散、证据掉太多，一律保持原指针（见 raw.mjs）。
 *
 * 用法：
 *   node scripts/retighten.mjs            只报告，不改
 *   node scripts/retighten.mjs --apply    真改（分批 40 条 setBlockAttrsBatch）
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, HOME_DIR, ensureDirs } from "../src/util/config.mjs";
import { SiYuan, resolveNotebookId } from "../src/util/siyuan.mjs";
import { parsePtr, narrowAnchor, stripRawLink } from "../src/util/raw.mjs";

const APPLY = process.argv.includes("--apply");
const cfg = loadConfig();
const sy = new SiYuan({ baseUrl: cfg.siyuan.baseUrl, token: cfg.siyuan.token, timeoutMs: 30000 });
const box = await resolveNotebookId(sy, cfg);

const rows = await sy.sql(
  `SELECT id, content, ial FROM blocks WHERE box='${box}' AND type='p' AND ial LIKE '%custom-mem-raw="%' LIMIT 5000`
);

/** 同一份附件只下一次。返回 全局轮次号 → {text}。 */
const cache = new Map();
async function linesOf(path) {
  if (!cache.has(path)) {
    const text = await sy.getAsset(path);
    const map = new Map();
    for (const line of String(text ?? "").split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r.type !== "session" && Number.isFinite(Number(r.i))) map.set(Number(r.i), { text: String(r.text ?? "") });
      } catch {
        /* 坏一行不连累别的 */
      }
    }
    cache.set(path, map);
  }
  return cache.get(path);
}

// 幂等：备份文件里记着「哪些块已经收窄过」，全部跳过。
//
// 不做这个的话，重复跑会继续缩：窗口两边各扩了一行作上下文，下一轮又从新窗口里
// 找峰值、再扩一行……每次都满足安全约束，但指针会被一点点蚕食到只剩三行。脚本是
// 运维工具，跑一次就够；跳过清单正好复用回滚用的备份，不用给块加新属性。
ensureDirs();
const done = new Set();
for (const f of readdirSync(HOME_DIR).filter((x) => x.startsWith("retighten-backup-") && x.endsWith(".json"))) {
  try {
    for (const u of JSON.parse(readFileSync(join(HOME_DIR, f), "utf8"))) done.add(u.id);
  } catch {
    /* 坏备份不该让主流程挂掉 */
  }
}

const updates = [];
const reasons = {};
let before = 0;
let after = 0;
let missing = 0;
let skipped = 0;
let processed = 0;
const samples = [];

for (const r of rows) {
  if (done.has(r.id)) {
    skipped++;
    continue;
  }
  const m = String(r.ial).match(/custom-mem-raw="([^"]*)"/);
  if (!m) continue;
  const p = parsePtr(m[1]);
  if (p.from == null || p.to == null) continue;
  const lines = await linesOf(p.path).catch(() => new Map());
  if (!lines.size) {
    missing++;
    continue;
  }
  // 稀疏数组：下标就是全局轮次号，跟指针里的 from/to 同坐标系。
  const turns = [];
  for (const [i, obj] of lines) turns[i] = obj;
  const text = stripRawLink(r.content, m[1]);
  const out = narrowAnchor(text, turns, p.from, p.to);
  reasons[out.reason] = (reasons[out.reason] ?? 0) + 1;
  processed++;
  before += p.to - p.from + 1;
  after += out.to - out.from + 1;
  if (!out.narrowed) continue;
  updates.push({ id: r.id, ptr: `${p.path}#${out.from}-${out.to}`, old: m[1] });
  if (samples.length < 6) {
    samples.push(
      `${p.to - p.from + 1} 行 → ${out.rows} 行  #${p.from}-${p.to} → #${out.from}-${out.to}  ${text.slice(0, 40)}`
    );
  }
}

console.log(`带原文指针的条目 ${rows.length} 条，附件 ${cache.size} 份，附件读不出 ${missing} 条，已收窄过跳过 ${skipped} 条`);
console.log(`本次可收窄 ${updates.length} 条；判定分布：`, JSON.stringify(reasons));
if (processed) {
  console.log(`本次处理 ${processed} 条，平均轮次范围 ${(before / processed).toFixed(1)} → ${(after / processed).toFixed(1)} 行`);
}
if (samples.length) {
  console.log("\n=== 样例 ===");
  for (const s of samples) console.log("  " + s);
}

if (!APPLY) {
  console.log("\n（dry，没改。加 --apply 真写；只改 custom-mem-raw 一个属性）");
  process.exit(0);
}

// 改之前先把旧指针全量留一份：只改一个属性虽然风险低，但收窄错了没有备份就只能
// 靠重新算一遍。备份是纯本地文件，不进思源、不占块。
ensureDirs();
const backup = join(HOME_DIR, `retighten-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(
  backup,
  JSON.stringify(updates.map((u) => ({ id: u.id, old: u.old, now: u.ptr })), null, 2) + "\n",
  { mode: 0o600 }
);
console.log(`\n旧指针已备份到 ${backup}`);

// 注：setBlockAttrs 会刷新块的 updated，而检索取候选是 ORDER BY updated DESC LIMIT 5000。
// 当前 1500 条远没撞上限，且相关度打分用的是 custom-mem-date 不是 updated，所以
// 这次批量改属性不会改变召回排序；库长到 5000 以上再跑就要重新掂量这一条。
let ok = 0;
let bad = 0;
for (let i = 0; i < updates.length; i += 40) {
  const chunk = updates.slice(i, i + 40).map((u) => ({ id: u.id, attrs: { "custom-mem-raw": u.ptr } }));
  try {
    await sy.setBlockAttrsBatch(chunk);
    ok += chunk.length;
  } catch (e) {
    bad += chunk.length;
    console.log(`  批量失败（第 ${i}–${i + chunk.length} 条）：${e.message}`);
  }
}
console.log(`\n改了 ${ok} 条，失败 ${bad} 条`);
