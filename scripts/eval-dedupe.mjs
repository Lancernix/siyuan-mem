#!/usr/bin/env node
/**
 * 判重候选的评测：三条通道各自捞回多少真重复、又放进多少噪音。
 *
 *   node scripts/eval-dedupe.mjs                       # 拿当前库跑私有评测集
 *   node scripts/eval-dedupe.mjs --no-project           # 消融：把「同项目」兜底关掉
 *   node scripts/eval-dedupe.mjs --with-model           # 再把模型叫来判一遍（花钱、慢）
 *   node scripts/eval-dedupe.mjs --fixture xxx.json --json
 *
 * 为什么要有这个东西：判重只有「候选」这一段会漏，而漏掉是静默的——模型看不见的
 * 那一条永远不会被判定，库里就永久并存两个说法。改门槛（0.15 / 0.28 / 稀有词 / 同项目）
 * 之前必须能量出「改完多捞回几条、多放进几条噪音」，否则每次调整都只是换一种感觉。
 *
 * 评测集**不在仓库里**：它由真实记忆正文构成，放公开仓库等于把私人笔记搬到大街上。
 * 默认读 ~/.siyuan-mem/eval/dedupe-pairs.json（容器里 /data/.siyuan-mem/eval-dedupe-pairs.json）。
 *
 * 口径（上一版有三处不严谨，都被评审点出来了，现在按生产的真实条件算）：
 *   - 候选池只有 `current`，和 `listCurrent` 一致。a 若已被标过时，它根本不在池子里，
 *     这一对直接跳过并计数——**不把 a 硬塞回池子**，否则召回虚高。
 *   - 「召回」和「终局」两段用同一个池子（都去掉了 fixture 里的 b），否则两个数字
 *     不是同一道题，没法互相解释。
 *   - token 估算按生产里的截断算（新条目 260 字、每条候选 200 字），不是按全文累加。
 *
 * 评测集本身只有 34 对，既用来调门槛又用来报数，严格说是训练集指标。所以汇总里按
 * 序号每 3 对切一份「holdout」（这批没参与调参），两个数字一起看。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const valueOf = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const fixturePath = resolve(
  valueOf("fixture", join(process.env.HOME ?? "~", ".siyuan-mem/eval/dedupe-pairs.json"))
);
const wantJson = flag("json");
const withModel = flag("with-model");
// 消融：把项目名清空，「同项目」那条通道就不再成立——不用给生产代码加测试开关。
const dropProject = flag("no-project");

const { Store } = await import("../src/core/store.mjs");
const { SiYuan } = await import("../src/util/siyuan.mjs");
const { loadConfig } = await import("../src/util/config.mjs");
const { pickCandidates, judgeDuplicates } = await import("../src/core/dedupe.mjs");

let doc;
try {
  doc = JSON.parse(readFileSync(fixturePath, "utf8"));
} catch {
  console.error(
    `读不到评测集：${fixturePath}\n` +
      "  它是私有的（真实记忆正文），不随仓库分发。放一份到上面这个路径，或者用 --fixture 指过去。"
  );
  process.exit(2);
}
const pairs = doc.pairs ?? doc;

const cfg = loadConfig();
const store = new Store(new SiYuan(cfg.siyuan), cfg);
const current = await store.listCurrent(3000);
const poolAll = dropProject ? current.map((e) => ({ ...e, project: "" })) : current;

/** 命中的那条候选是靠哪条通道进来的。多条同时命中时按「先验强弱」取最有代表性的一个。 */
function channelOf(why = []) {
  if (why.some((w) => w.startsWith("同话题"))) return "同话题";
  if (why.some((w) => w.startsWith("稀有词"))) return "稀有词";
  if (why.some((w) => w.startsWith("同项目"))) return "同项目";
  return "仅覆盖率";
}

/** 字二元组覆盖率，和 dedupe.mjs 里同一套算法（这边只用来判「是不是同一份内容的另一份拷贝」）。 */
function coverOf(a, b) {
  const grams = (s) => {
    const t = String(s ?? "").replace(/[\s\p{P}]/gu, "");
    const out = new Set();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let hit = 0;
  for (const g of small) if (big.has(g)) hit++;
  return hit / small.size;
}

// 两段共用的池子：库去掉 fixture 里的 b（线上这一刻它们还没入库）。
const bIds = new Set(pairs.map((p) => p.b.id));
const pool = poolAll.filter((e) => !bIds.has(e.id));

const rows = [];
let candTotal = 0;
let estChars = 0;

for (const [i, p] of pairs.entries()) {
  const idA = p.a.id;
  const a = pool.find((e) => e.id === idA);
  if (!a) {
    // 生产里候选池只有 current；a 已被标过时就根本不在池子里。硬塞进去会把召回算高。
    rows.push({ n: i + 1, same: Boolean(p.same), note: p.note ?? "", skipped: "a 不在 current" });
    continue;
  }
  const b = dropProject ? { ...p.b, project: "" } : { ...p.b };
  const { plan } = pickCandidates({
    news: [{ entity: b.entity, text: b.text, brief: "", project: b.project }],
    existing: pool,
  });
  const cands = plan[0]?.cands ?? [];
  const hit = cands.find((c) => c.e.id === idA);

  candTotal += cands.length;
  // 按生产里的截断算：新条目正文 260 字、每条候选 200 字。
  estChars += Math.min(b.text.length, 260) + cands.reduce((n, c) => n + Math.min(c.e.text.length, 200), 0);

  rows.push({
    n: i + 1,
    same: Boolean(p.same),
    note: p.note ?? "",
    inCandidates: Boolean(hit),
    channel: hit ? channelOf(hit.why) : "",
    rank: hit ? cands.indexOf(hit) + 1 : 0,
    cands: cands.length,
  });
}

let judged = null;
if (withModel) {
  const batchSize = Number(valueOf("batch", 34));
  const liveRows = rows.filter((r) => !r.skipped);
  const t0 = Date.now();
  const decisions = new Map();
  for (let s = 0; s < liveRows.length; s += batchSize) {
    const slice = liveRows.slice(s, s + batchSize);
    const news = slice.map((r) => {
      const p = pairs[r.n - 1];
      const bb = dropProject ? { ...p.b, project: "" } : { ...p.b };
      return { entity: bb.entity, text: bb.text, brief: "", project: bb.project };
    });
    const got = await judgeDuplicates({ cfg, news, existing: pool });
    for (const [i, d] of got) decisions.set(slice[i].n, d);
  }
  judged = { decisions, ms: Date.now() - t0 };
  for (const r of liveRows) {
    const d = decisions.get(r.n) ?? null;
    r.decision = d;
    const p = pairs[r.n - 1];
    // 正例判对的口径是「认出了重复」，不是「指到我标的那一条」——库里同一件事常常有
    // 三四份拷贝，模型指到另一份是正确行为。凡是与 a 正文覆盖率 ≥0.6 的都算同一份。
    const equivalents = new Set([
      p.a.id,
      ...pool.filter((e) => coverOf(e.text, p.a.text) >= 0.6).map((e) => e.id),
    ]);
    r.correct = r.same ? Boolean(d && equivalents.has(d.id)) : !d;
  }
}

const live = rows.filter((r) => !r.skipped);
const pos = live.filter((r) => r.same);
const neg = live.filter((r) => !r.same);
const hitCount = pos.filter((r) => r.inCandidates).length;
const noiseCount = neg.filter((r) => r.inCandidates).length;
const byChannel = {};
for (const r of pos.filter((x) => x.inCandidates)) byChannel[r.channel] = (byChannel[r.channel] ?? 0) + 1;
// 每 3 对切一份没参与调参的 holdout。
const holdout = (list) => list.filter((r) => r.n % 3 === 0);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-");

if (wantJson) {
  console.log(
    JSON.stringify(
      {
        library: { entries: current.length, withProject: current.filter((e) => e.project).length },
        pairs: rows.length,
        skipped: rows.filter((r) => r.skipped).length,
        recall: { hit: hitCount, of: pos.length, byChannel },
        noise: { hit: noiseCount, of: neg.length },
        avgCandidates: Number((candTotal / Math.max(live.length, 1)).toFixed(2)),
        model: judged ? { correct: live.filter((r) => r.correct).length, of: live.length, ms: judged.ms } : undefined,
        rows,
      },
      null,
      2
    )
  );
} else {
  console.log(`库：${current.length} 条 current（带项目名 ${current.filter((e) => e.project).length} 条）`);
  console.log(
    `评测集：${rows.length} 对，跳过 ${rows.length - live.length} 对（a 不在 current）` +
      `，实评 ${live.length} 对（正例 ${pos.length} / 负例 ${neg.length}）${dropProject ? " · 已关掉同项目兜底" : ""}\n`
  );

  console.log("正例（同一件事，必须进候选）");
  for (const r of pos) {
    const mark = r.correct === false ? "✗" : r.inCandidates ? "✓" : "✗";
    const tail = [
      r.inCandidates ? `第 ${r.rank} 条 · ${r.channel}` : "没进候选",
      r.decision !== undefined ? (r.decision ? `→ 判 ${r.decision.action}` : "→ 判 keep") : "",
      r.correct === undefined ? "" : r.correct ? "✓" : "✗",
    ]
      .filter(Boolean)
      .join("  ");
    console.log(`  ${mark} ${String(r.n).padStart(2)}. ${r.note.slice(0, 34).padEnd(34)} ${tail}`);
  }
  console.log("\n负例（不是同一件事，进来就是噪音）");
  for (const r of neg) {
    const mark = r.correct === false ? "✗" : r.inCandidates ? "·" : "✓";
    const tail = [
      r.inCandidates ? `进候选（${r.channel}，第 ${r.rank} 条）` : "没进来",
      r.decision !== undefined ? (r.decision ? `→ 判 ${r.decision.action}` : "→ 判 keep") : "",
      r.correct === undefined ? "" : r.correct ? "✓" : "✗",
    ]
      .filter(Boolean)
      .join("  ");
    console.log(`  ${mark} ${String(r.n).padStart(2)}. ${r.note.slice(0, 34).padEnd(34)} ${tail}`);
  }
  if (rows.some((r) => r.skipped)) {
    console.log("\n跳过（生产里这些 a 已不在 current，不参与统计）");
    for (const r of rows.filter((x) => x.skipped)) console.log(`  - ${r.n}. ${r.note.slice(0, 40)}`);
  }

  const hp = holdout(pos);
  const hn = holdout(neg);
  console.log("\n汇总");
  console.log(
    `  召回    ${hitCount}/${pos.length}  (${pct(hitCount, pos.length)})   ` +
      (Object.entries(byChannel).map(([k, v]) => `${k} ${v}`).join(" · ") || "-")
  );
  console.log(`  召回·holdout  ${hp.filter((r) => r.inCandidates).length}/${hp.length}`);
  console.log(
    `  噪音    ${noiseCount}/${neg.length}  (${pct(noiseCount, neg.length)})   holdout ${hn.filter((r) => r.inCandidates).length}/${hn.length}`
  );
  console.log(
    `  成本    平均 ${(candTotal / Math.max(live.length, 1)).toFixed(1)} 条候选/条` +
      `，约 ${Math.round(estChars / Math.max(live.length, 1) / 1.6)} token/条（按生产截断 + 1.6 字符一 token 粗算）`
  );
  if (judged) {
    const ok = live.filter((r) => r.correct).length;
    console.log(
      `  终局    ${ok}/${live.length}  (${pct(ok, live.length)})` +
        `   正例 ${pos.filter((r) => r.correct).length}/${pos.length}` +
        `、负例 ${neg.filter((r) => r.correct).length}/${neg.length}` +
        `   调用 ${(judged.ms / 1000).toFixed(1)}s`
    );
  }
}
