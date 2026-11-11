/**
 * 召回评测：给一句话，看该想起的那条有没有被想起来。
 *
 * 判重那边早就有评测集了（34 对），召回一直靠手感——排序权重是"我觉得这样更合理"
 * 拍出来的。这个脚本就是为了把"我觉得"换成数字。
 *
 * 题库分四档，别混在一起看平均数：
 *
 *   easy     问题里带着答案正文的原词（"亚狮龙 NO.5 是什么档位"）
 *   medium   换了说法，但还共享一些词（"羽毛球训练级用球的号段怎么排"）
 *   hard     一个答案里的词都不用（"买球时那几个号哪个是比赛用的"）
 *   negative 库里没有的东西，正确答案是一条都不返回
 *
 * 分档的意义：easy 高不说明什么（LIKE 子串匹配天生擅长），
 * **hard 才是判断"要不要上向量"的依据**。只看总分会被 easy 拉高。
 *
 * 用法：
 *   node scripts/eval-recall.mjs                     # 用 ~/.siyuan-mem/eval/recall-pairs.json
 *   node scripts/eval-recall.mjs --file other.json
 *   node scripts/eval-recall.mjs --limit 5 --verbose
 *
 * 题库不进仓库：里面是真实记忆的正文和 id。
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = join(homedir(), ".siyuan-mem");
const DEFAULT_FILE = join(HOME, "eval", "recall-pairs.json");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const file = arg("file", DEFAULT_FILE);
const limit = Number(arg("limit", 5));
const verbose = has("verbose");

if (!existsSync(file)) {
  console.error(`找不到题库：${file}`);
  console.error("题库不进仓库，放在 ~/.siyuan-mem/eval/recall-pairs.json。");
  process.exit(1);
}

const cases = JSON.parse(readFileSync(file, "utf8"));
const { searchEntries } = await import("../src/core/search.mjs");

const byKind = new Map();
const rows = [];

/** 跑一次，返回期望条目在结果里的名次（1 起）；没命中返回 0；负例误召回返回 -1。 */
async function rankOf(question, expect, kind) {
  const t0 = Date.now();
  // silent：评测不能往 memory.hit 里灌数，否则「这条记忆被人用过」的信号就假了。
  const r = await searchEntries({ q: question, limit, silent: true });
  const hits = (r.hits ?? []).map((h) => h.id);
  const ms = Date.now() - t0;
  if (kind === "negative") return { rank: hits.length === 0 ? 1 : -1, hits, ms, n: hits.length };
  for (const id of expect ?? []) {
    const at = hits.indexOf(id);
    if (at >= 0) return { rank: at + 1, hits, ms };
  }
  return { rank: 0, hits, ms };
}

for (const c of cases) {
  const kind = c.kind ?? "medium";
  if (!byKind.has(kind)) byKind.set(kind, { n: 0, plain: 0, keyed: 0, mrrPlain: 0, mrrKeyed: 0 });
  const s = byKind.get(kind);
  s.n++;

  // 同一道题两种问法：整句（人真实会那么问）和关键词（词对得上）。
  // 两者的差距就是「查询理解」的债——排序再好，词对不上也召回不到。
  const plain = await rankOf(c.q, c.expect, kind);
  const keyed = c.qk ? await rankOf(c.qk, c.expect, kind) : null;

  const ok = (r) => r && r.rank >= 1 && r.rank <= limit;
  if (ok(plain)) {
    s.plain++;
    s.mrrPlain += 1 / plain.rank;
  }
  if (keyed && ok(keyed)) {
    s.keyed++;
    s.mrrKeyed += 1 / keyed.rank;
  }
  rows.push({ ...c, kind, plain, keyed, ms: plain.ms });
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : "-");
const ORDER = ["easy", "medium", "hard", "negative"];
const label = { easy: "简单（有原词）", medium: "中等（换说法）", hard: "困难（无原词）", negative: "负例（不该命中）" };

console.log(`\n题库 ${cases.length} 条，取前 ${limit} 条算命中。每题两种问法：整句 / 关键词。\n`);
console.log("档位".padEnd(16), "题数".padStart(4), "整句".padStart(7), "关键词".padStart(8), "整句MRR".padStart(9));
for (const k of ORDER) {
  const s = byKind.get(k);
  if (!s) continue;
  // 负例只有一种问法（库里没有，理应返回空），没有「关键词」这一列，
  // 也不谈 MRR。打 0% / 1.00 会让人误以为负例在关键词问法上全军覆没。
  const keyedN = rows.filter((r) => r.kind === k && r.keyed).length || s.n;
  const isNeg = k === "negative";
  console.log(
    label[k].padEnd(16),
    String(s.n).padStart(5),
    pct(s.plain, s.n).padStart(8),
    (isNeg ? "-" : pct(s.keyed, keyedN)).padStart(8),
    (isNeg ? "-" : (s.mrrPlain / s.n).toFixed(2)).padStart(9),
  );
}

const pos = ORDER.filter((k) => k !== "negative").map((k) => byKind.get(k)).filter(Boolean);
const n = pos.reduce((a, s) => a + s.n, 0);
const pl = pos.reduce((a, s) => a + s.plain, 0);
const kd = pos.reduce((a, s) => a + s.keyed, 0);
if (n) console.log("\n正例合计".padEnd(16), String(n).padStart(4), pct(pl, n).padStart(8), pct(kd, n).padStart(8));

// 整句没中、关键词中了：这一批全是「查询理解」的锅，跟排序无关
const gap = rows.filter((r) => r.kind !== "negative" && r.keyed && r.plain.rank === 0 && r.keyed.rank >= 1 && r.keyed.rank <= limit);
if (gap.length) {
  console.log(`\n整句没中、关键词中了 ${gap.length} 条 —— 这批是查询没拆对，不是排序：`);
  for (const r of gap) console.log(`  · ${r.q}\n      关键词「${r.qk}」→ 第 ${r.keyed.rank} 条`);
}

const miss = rows.filter((r) => r.kind !== "negative" && r.plain.rank === 0 && (!r.keyed || r.keyed.rank === 0));
if (miss.length) {
  console.log(`\n两种问法都没中 ${miss.length} 条：`);
  for (const r of miss) {
    const top = r.plain.hits.slice(0, 2).join("、") || "（空）";
    console.log(`  · [${r.kind}] ${r.q}`);
    console.log(`      实际返回：${top}`);
  }
}

const wrong = rows.filter((r) => r.kind === "negative" && r.plain.rank === -1);
if (wrong.length) {
  console.log(`\n负例误召回 ${wrong.length} 条（库里明明没有，却返回了）：`);
  for (const r of wrong) console.log(`  · ${r.q} → ${r.plain.n} 条`);
}
