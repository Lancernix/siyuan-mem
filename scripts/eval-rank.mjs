/**
 * 排序诊断 + 权重 A/B。
 *
 * 召回评测（eval-recall.mjs）只回答「有没有进前 5」，答不出「为什么没进」。
 * 这个脚本把每道题的候选池（limit=50）取回来，离线用不同权重重排，比较命中率、
 * MRR 和「进了池但排不进前 5」的条数——**改权重之前先看数字**，别凭手感。
 *
 * 为什么离线重排：生产里的排序是纯函数（词频 / 话题 / 摘要 / 时间惩罚），
 * 候选拿到手就能复算；这样试十套权重只打一轮思源，也不会动到线上代码。
 * 代价：候选池是 base 权重下排序后取的前 50，50 名外的条目任何权重都救不回来
 * （那是召回边界，不是排序）。分因输出里会把它单列。
 *
 * 用法：
 *   node scripts/eval-rank.mjs                 # 用默认题库
 *   node scripts/eval-rank.mjs --file x.json --limit 5
 *   node scripts/eval-rank.mjs --explain      # 打印排序问题明细
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { poolGate } from "./rank-pool.mjs";

const DEFAULT_FILE = join(homedir(), ".siyuan-mem", "eval", "recall-pairs.json");
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);
const file = arg("file", DEFAULT_FILE);
const limit = Number(arg("limit", 5));
const explain = has("explain");
const POOL = 50;

if (!existsSync(file)) {
  console.error(`找不到题库：${file}`);
  process.exit(1);
}
const cases = JSON.parse(readFileSync(file, "utf8"));
const { searchEntries, RANK_WEIGHTS } = await import("../src/core/search.mjs");

/* ---------- 取候选池：一次查询，多套权重复用 ---------- */

const pools = [];
for (const c of cases) {
  for (const [label, q] of [["整句", c.q], ["关键词", c.qk]]) {
    if (!q) continue;
    const r = await searchEntries({ q, limit: POOL, silent: true });
    // 取池逻辑在 rank-pool.mjs，有单测锁着：必须用 scoreTerms（生产真正打分
    // 的词集），不能用含日期词的 r.terms（第十八轮复审 P2-1）。
    pools.push({ ...poolGate(r, q), c, label });
  }
}

/* ---------- 可变的排序权重 ---------- */

/** 和 scoreOf 同形，只是权重可变。日期缺失按 60 天算，与生产一致。 */
function scoreWith(h, gate, w) {
  const text = String(h.text ?? "");
  const brief = String(h.brief ?? "");
  const entity = String(h.entity ?? "");
  let s = 0;
  for (const t of gate) {
    const low = String(t).toLowerCase();
    s += Math.min(text.toLowerCase().split(low).length - 1, w.textCap ?? 5) * w.text;
    if (entity.toLowerCase().includes(low)) s += w.entity;
    if (brief.toLowerCase().includes(low)) s += w.brief;
  }
  const days = h.date ? Math.max(0, (Date.now() - Date.parse(h.date + "T00:00:00")) / 86400000) : 60;
  return s - Math.min(days * w.daily, w.cap);
}

// 直接从生产读，别在这里再抄一份（日期那次「两处各一套归一」的教训）。
const BASE = {
  text: RANK_WEIGHTS.textPerHit,
  textCap: RANK_WEIGHTS.textCap,
  entity: RANK_WEIGHTS.entity,
  brief: RANK_WEIGHTS.brief,
  daily: RANK_WEIGHTS.daily,
  cap: RANK_WEIGHTS.cap,
};
const w = (over = {}) => ({ ...BASE, ...over });

/** 结果限流：同话题最多 K 条（0 = 不限）；brief 完全相同的只留最高分一条。 */
function diversify(rows, { perEntity = 0, briefDedupe = false } = {}) {
  const seenEntity = new Map();
  const seenBrief = new Set();
  return rows.filter((h) => {
    const e = h.entity || `\0${h.id}`;
    if (perEntity && (seenEntity.get(e) ?? 0) >= perEntity) return false;
    const b = String(h.brief ?? "").trim();
    if (briefDedupe && b && seenBrief.has(b)) return false;
    seenEntity.set(e, (seenEntity.get(e) ?? 0) + 1);
    if (b) seenBrief.add(b);
    return true;
  });
}

const VARIANTS = [
  { name: "base（现版）", w: w() },
  { name: "话题限 2 条", w: w(), opt: { perEntity: 2 } },
  { name: "话题限 3 条", w: w(), opt: { perEntity: 3 } },
  { name: "摘要去重", w: w(), opt: { briefDedupe: true } },
  { name: "时间惩罚封顶 4", w: w({ cap: 4 }) },
  { name: "时间惩罚封顶 2", w: w({ cap: 2 }) },
  { name: "话题权重 +3", w: w({ entity: 3 }) },
  { name: "摘要权重 +6", w: w({ brief: 6 }) },
  { name: "摘要6 / 话题限2", w: w({ brief: 6 }), opt: { perEntity: 2 } },
  { name: "摘要6 / 限2 / 时间4", w: w({ brief: 6, cap: 4 }), opt: { perEntity: 2 } },
  { name: "摘要去重 / 限2 / 时间4", w: w({ cap: 4 }), opt: { perEntity: 2, briefDedupe: true } },
];

/* ---------- 逐套权重算指标 ---------- */

function evaluate(v) {
  let hitPlain = 0, nPlain = 0, hitKeyed = 0, nKeyed = 0;
  let mrrPlain = 0, negWrong = 0, rankIssue = 0;
  const details = [];
  for (const p of pools) {
    const sorted = p.rows
      .map((h) => ({ ...h, score2: scoreWith(h, p.gate, v.w) }))
      .sort((a, b) => b.score2 - a.score2 || String(b.date ?? "").localeCompare(String(a.date ?? "")));
    const top = diversify(sorted, v.opt ?? {}).slice(0, limit);
    const ids = top.map((h) => h.id);
    if (p.c.kind === "negative") {
      if (ids.length) negWrong++;
      continue;
    }
    const fullRank = sorted.findIndex((h) => (p.c.expect ?? []).includes(h.id)) + 1;
    const at = (p.c.expect ?? []).map((id) => ids.indexOf(id)).find((x) => x >= 0);
    const ok = at !== undefined;
    if (p.label === "整句") {
      nPlain++;
      if (ok) { hitPlain++; mrrPlain += 1 / (at + 1); }
    } else {
      nKeyed++;
      if (ok) hitKeyed++;
    }
    if (fullRank > limit && fullRank > 0) {
      rankIssue++;
      if (explain && v.name.startsWith("base")) {
        details.push({
          q: p.q, label: p.label, kind: p.c.kind, fullRank, after: at === undefined ? 0 : at + 1,
          want: sorted[fullRank - 1],
          top5: top.slice(0, 5),
        });
      }
    }
  }
  return {
    name: v.name,
    plain: nPlain ? hitPlain / nPlain : 0,
    keyed: nKeyed ? hitKeyed / nKeyed : 0,
    mrr: nPlain ? mrrPlain / nPlain : 0,
    rankIssue, negWrong, details,
  };
}

const results = VARIANTS.map(evaluate);
const pct = (x) => `${(x * 100).toFixed(0)}%`;

/**
 * 护栏：时间惩罚最初就是为「旧但啰嗦的条目压过新而简短的」加的。
 * 扫参数时必须同时验这两条，否则命中率涨了、过时结论却又排到前面去了。
 */
function guards(w) {
  const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const g = ["bwrap"];
  const old4 = { text: "bwrap bwrap bwrap bwrap 沙箱", brief: "", date: d(200), entity: "" };
  const old5 = { text: "bwrap 沙箱 bwrap 限制 bwrap 权限 bwrap 规则 bwrap 边界", brief: "", date: d(200), entity: "" };
  const fresh10 = { text: "bwrap 已移除", brief: "", date: d(10), entity: "" };
  const fresh1 = { text: "bwrap 已移除", brief: "", date: d(1), entity: "" };
  return {
    freshBeatsChatty: scoreWith(fresh10, g, w) > scoreWith(old4, g, w),
    detailedOldStillWins: scoreWith(old5, g, w) > scoreWith(fresh1, g, w),
  };
}

if (has("sweep")) {
  const sweep = [];
  for (const textCap of [2, 3, 5])
    for (const text of [1, 2])
      for (const entity of [3, 4, 6])
        for (const brief of [3, 5, 6])
          for (const cap of [2, 4, 8]) {
            const v = { name: `t${text}/cap${textCap} e${entity} b${brief} time${cap}`, w: w({ text, textCap, entity, brief, cap }) };
            const r = evaluate(v);
            const g = guards(v.w);
            sweep.push({ ...v, r, g });
          }
  // 排序：命中率优先，再看 MRR；护栏破一条就排到后面（仍展示，便于判断代价）。
  const score = (x) => x.r.plain + x.r.keyed + x.r.mrr / 10 + (x.g.freshBeatsChatty && x.g.detailedOldStillWins ? 0.02 : -0.05);
  sweep.sort((a, b) => score(b) - score(a));
  console.log("\n===== 参数扫描（护栏：新压啰嗦旧 / 说透了的旧仍能赢）=====");
  console.log("权重".padEnd(34), "整句".padStart(7), "关键词".padStart(8), "MRR".padStart(6), "排序遗留".padStart(9), "护栏");
  for (const x of sweep.slice(0, 18)) {
    const g = `${x.g.freshBeatsChatty ? "✓" : "✗"}${x.g.detailedOldStillWins ? "✓" : "✗"}`;
    console.log(x.name.padEnd(34), pct(x.r.plain).padStart(8), pct(x.r.keyed).padStart(8), x.r.mrr.toFixed(2).padStart(6), String(x.r.rankIssue).padStart(9), g.padStart(6));
  }
  const ok = sweep.filter((x) => x.g.freshBeatsChatty && x.g.detailedOldStillWins && x.r.negWrong === 0);
  console.log(`\n护栏全过且负例全绿的方案 ${ok.length} 套；其中最好的是：`);
  for (const x of ok.slice(0, 3)) console.log(`  ${x.name} → ${pct(x.r.plain)} / ${pct(x.r.keyed)} / MRR ${x.r.mrr.toFixed(2)} / 排序遗留 ${x.r.rankIssue}`);
} else {
console.log(`\n题库 ${cases.length} 条 / ${pools.length} 次查询，候选池 ${POOL}，取前 ${limit} 条算命中。\n`);
console.log("方案".padEnd(28), "整句".padStart(7), "关键词".padStart(8), "整句MRR".padStart(9), "排序遗留".padStart(9), "负例误召回".padStart(11));
for (const r of results) {
  console.log(
    r.name.padEnd(28),
    pct(r.plain).padStart(8),
    pct(r.keyed).padStart(8),
    r.mrr.toFixed(2).padStart(9),
    String(r.rankIssue).padStart(9),
    String(r.negWrong).padStart(11),
  );
}

/* ---------- 分因：哪些是排序能救的，哪些不能 ---------- */

const base = results[0];
const never = pools.filter((p) => p.c.kind !== "negative" && !p.rows.some((h) => (p.c.expect ?? []).includes(h.id)));
console.log(`\n排序救不了的（期望条目不在候选池前 ${POOL}）：${never.length} 条 —— 这属于召回边界/查询理解，不是权重。`);
for (const p of never.slice(0, 12)) console.log(`  · [${p.label}/${p.c.kind}] ${p.q}`);

if (explain) {
  console.log("\n===== base 权重下「进了池但排不进前 5」=====");
  for (const d of base.details) {
    console.log(`\n[${d.label}/${d.kind}] ${d.q} → 第 ${d.fullRank} 名（重排后第 ${d.after || "-"} 名）`);
    const f = (h) => `score=${h.score2.toFixed(2)} date=${h.date} entity=${h.entity} brief=${String(h.brief ?? "").slice(0, 28)}`;
    const t = (h) => String(h.text ?? "").replace(/\s+/g, " ").slice(0, 110);
    console.log(`   想要: ${f(d.want)}\n         ${t(d.want)}`);
    d.top5.forEach((h, i) => console.log(`   #${i + 1}: ${f(h)}\n         ${t(h)}`));
  }
}

}
