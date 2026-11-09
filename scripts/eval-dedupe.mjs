#!/usr/bin/env node
/**
 * 判重候选的评测：三条通道各自捞回多少真重复、又放进多少噪音。
 *
 *   node scripts/eval-dedupe.mjs                    # 拿当前库跑 test/fixtures/dedupe-pairs.json
 *   node scripts/eval-dedupe.mjs --no-project       # 消融：把「同项目」通道关掉再跑
 *   node scripts/eval-dedupe.mjs --with-model       # 再把模型叫来判一遍（要花钱，量的是终局准确率）
 *   node scripts/eval-dedupe.mjs --fixture xxx.json --json
 *
 * 为什么要有这个东西：判重只有「候选」这一段会漏，而漏掉是静默的——模型看不见的
 * 那一条永远不会被判定，库里就永久并存两个说法。改门槛（0.15 / 0.28 / 稀有词 / 同项目）
 * 之前必须能量出「改完多捞回几条、多放进几条噪音」，否则每次调整都只是换一种感觉。
 *
 * 评测集是真实条目（见 fixture 里的 note）。正例大多是同一次抽取跑两遍留下的重复，
 * 负例是同项目里的不同事实——后者才是真难点：它们字面像、话题也沾边，但删掉一条就丢信息。
 *
 * 口径：
 *   - 召回 = 正例里那条「旧条目」出现在候选里的比例。没进候选就等于模型永远看不到。
 *   - 噪音 = 负例里那条不该进来的也进了候选的比例。进候选不等于判错（模型还能否掉），
 *     但它要花 token，而且越多越容易判错，所以这是成本指标。
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

const fixturePath = resolve(valueOf("fixture", join(ROOT, "test/fixtures/dedupe-pairs.json")));
const wantJson = flag("json");
// 带模型跑：候选召回只是第一段，模型看得到之后判不判得对是第二段。两段分开量，
// 才知道该调门槛还是该调提示词。
const withModel = flag("with-model");
// 消融：把项目名清空，「同项目」那条通道就不再成立——不用给生产代码加测试开关。
const dropProject = flag("no-project");

const { Store } = await import("../src/core/store.mjs");
const { SiYuan } = await import("../src/util/siyuan.mjs");
const { loadConfig } = await import("../src/util/config.mjs");
const { pickCandidates, judgeDuplicates } = await import("../src/core/dedupe.mjs");

const cfg = loadConfig();
const store = new Store(new SiYuan(cfg.siyuan), cfg);
const known = await store.listCurrent(3000);
const pool = dropProject ? known.map((e) => ({ ...e, project: "" })) : known;

const doc = JSON.parse(readFileSync(fixturePath, "utf8"));
const pairs = doc.pairs ?? doc;

/** 命中的那条候选是靠哪条通道进来的。多条同时命中时按「先验强弱」取最有代表性的一个。 */
function channelOf(why = []) {
  if (why.some((w) => w.startsWith("同话题"))) return "同话题";
  if (why.some((w) => w.startsWith("稀有词"))) return "稀有词";
  if (why.some((w) => w.startsWith("同项目"))) return "同项目";
  return "仅覆盖率";
}

/** 字二元组覆盖率，和 dedupe.mjs 里同一套算法（这边只要它判「是不是同一份内容的另一份拷贝」）。 */
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

const rows = [];
let candTotal = 0;
let charsTotal = 0;

for (const [i, p] of pairs.entries()) {
  const idA = p.a.id;
  // 用库里的现行版本（正文可能被改过）；库里没有（比如已被标 superseded）就用 fixture 里那份。
  const inLib = known.find((e) => e.id === idA);
  const a = { ...p.a, ...(inLib ?? {}) };
  if (dropProject) a.project = "";
  const b = dropProject ? { ...p.b, project: "" } : { ...p.b };
  // 池子 = 库，去掉 b 自己（新条目还没入库），把 a 换成上面那份。
  // 注意 a **不能**从池子里删掉：它就是「库里已有的那条」，删了等于这一对永远不可能命中。
  const existing = pool.filter((e) => e.id !== b.id).map((e) => (e.id === idA ? a : e));
  if (!existing.some((e) => e.id === idA)) existing.push(a);
  const { plan } = pickCandidates({ news: [{ entity: b.entity, text: b.text, brief: "", project: b.project }], existing });
  const cands = plan[0]?.cands ?? [];

  const hit = cands.find((c) => c.e.id === idA);
  const rank = hit ? cands.indexOf(hit) + 1 : 0;
  const why = hit?.why ?? [];
  candTotal += cands.length;
  charsTotal += cands.reduce((n, c) => n + c.e.text.length, 0);

  rows.push({
    n: i + 1,
    same: Boolean(p.same),
    note: p.note ?? "",
    entity: b.entity,
    project: b.project,
    inCandidates: Boolean(hit),
    channel: hit ? channelOf(why) : "",
    why,
    rank,
    cands: cands.length,
  });
}

// 带模型时按批判：34 条一次性送进去，模型会退化成「全判 covered」——实测终局
// 只有 4/34，而同一批分成 6 条一组就正常。这不是提示词的问题，是一次要它同时
// 守住太多组上下文；线上一个会话也就几条到十几条，天然比这个大杂烩小。
let judged = null;
if (withModel) {
  // b 自己绝不能留在池子里：它在库里存在（评测集是从库里挖的），而线上这一刻它还没入库。
  // 留着的话模型会把它当成「库里已有的一条」，直接指回它自己——第一版就是这么错的，
  // 34 对里 30 对判成了「把新条目当成旧条目」，看起来像模型不会判。
  const bIds = new Set(pairs.map((p) => p.b.id));
  const poolForJudge = pool.filter((e) => !bIds.has(e.id));
  const batchSize = Number(valueOf("batch", 6));
  const t0 = Date.now();
  const decisions = new Map();
  for (let start = 0; start < pairs.length; start += batchSize) {
    const slice = pairs.slice(start, start + batchSize);
    const news = slice.map((p) => {
      const bb = dropProject ? { ...p.b, project: "" } : { ...p.b };
      return { entity: bb.entity, text: bb.text, brief: "", project: bb.project };
    });
    const got = await judgeDuplicates({ cfg, news, existing: poolForJudge });
    for (const [i, d] of got) decisions.set(start + i, d);
  }
  judged = { decisions, ms: Date.now() - t0 };
  for (const [i, r] of rows.entries()) {
    const d = decisions.get(i);
    r.decision = d ?? null;
    // 正例判对的口径是「认出了重复」，不是「指到我标的那一条」——库里同一件事常常
    // 有三四份拷贝（同一次抽取跑两遍、按月导入），模型指到另一份是正确行为。
    // 所以凡是与 a 正文覆盖率 ≥0.6 的条目都算「同一份」，指到其中任何一个都算对。
    // 不再要求实体名相同：改名那件事在库里同时挂在「思源笔记」和「思源记忆库」下，
    // 实体名不同但正文几乎一样，要求同名会把正确行为判成错。
    const pair = pairs[i];
    const equivalents = new Set([
      pair.a.id,
      ...pool.filter((e) => coverOf(e.text, pair.a.text) >= 0.6).map((e) => e.id),
    ]);
    if (r.same) r.correct = Boolean(d && equivalents.has(d.id));
    // 负例：没被判成重复才算对。
    else r.correct = !d;
  }
}

const pos = rows.filter((r) => r.same);
const neg = rows.filter((r) => !r.same);
const hitCount = pos.filter((r) => r.inCandidates).length;
const noiseCount = neg.filter((r) => r.inCandidates).length;
const byChannel = {};
for (const r of pos.filter((x) => x.inCandidates)) byChannel[r.channel] = (byChannel[r.channel] ?? 0) + 1;
const covered = new Set(known.map((e) => e.id)).size;

if (wantJson) {
  console.log(
    JSON.stringify(
      {
        library: { entries: known.length, withProject: known.filter((e) => e.project).length },
        pairs: rows.length,
        recall: { hit: hitCount, of: pos.length, byChannel },
        noise: { hit: noiseCount, of: neg.length },
        avgCandidates: Number((candTotal / Math.max(rows.length, 1)).toFixed(2)),
        ...(judged
          ? {
              modelMs: judged.ms,
              model: {
                positiveCorrect: pos.filter((r) => r.correct).length,
                positiveWrong: pos.filter((r) => r.correct === false).length,
                negativeCorrect: neg.filter((r) => r.correct).length,
                negativeWrong: neg.filter((r) => r.correct === false).length,
              },
            }
          : {}),
        rows,
      },
      null,
      2
    )
  );
} else {
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  console.log(`库：${known.length} 条 current（带项目名 ${known.filter((e) => e.project).length} 条）`);
  console.log(`评测集：${rows.length} 对（正例 ${pos.length} / 负例 ${neg.length}）${dropProject ? " · 已关掉同项目通道" : ""}\n`);

  const tailOf = (r) => {
    const parts = [r.inCandidates ? `第 ${r.rank} 条 · ${r.channel}` : "没进候选"];
    if (r.decision !== undefined) {
      parts.push(r.decision ? `→ 判 ${r.decision.action}` : "→ 判 keep");
      parts.push(r.correct ? "✓" : "✗");
    }
    return parts.join("  ");
  };
  console.log("正例（同一件事，必须进候选）");
  for (const r of pos) {
    const mark = r.correct === false ? "✗" : r.inCandidates ? "✓" : "✗";
    console.log(`  ${mark} ${String(r.n).padStart(2)}. ${r.note.slice(0, 34).padEnd(34)} ${tailOf(r)}`);
  }
  console.log("\n负例（不是同一件事，进来就是噪音）");
  for (const r of neg) {
    const mark = r.correct === false ? "✗" : r.inCandidates ? "·" : "✓";
    console.log(`  ${mark} ${String(r.n).padStart(2)}. ${r.note.slice(0, 34).padEnd(34)} ${tailOf(r)}`);
  }

  console.log("\n汇总");
  console.log(`  召回    ${hitCount}/${pos.length}  (${pct(hitCount, pos.length)})   ${Object.entries(byChannel).map(([k, v]) => `${k} ${v}`).join(" · ") || "-"}`);
  console.log(`  噪音    ${noiseCount}/${neg.length}  (${pct(noiseCount, neg.length)})`);
  console.log(
    `  成本    平均 ${(candTotal / Math.max(rows.length, 1)).toFixed(1)} 条候选/条` +
      `，约 ${Math.round(charsTotal / Math.max(rows.length, 1) / 1.6)} token/条（按 1.6 字符一 token 粗算）`
  );
  if (judged) {
    const ok = rows.filter((r) => r.correct).length;
    console.log(`  终局    ${ok}/${rows.length}  (${pct(ok, rows.length)})   判重调用 ${(judged.ms / 1000).toFixed(1)}s`);
  }
  if (covered !== known.length) console.log(`  （库里有 ${known.length - covered} 条 id 重复，已按 id 去重）`);
}
