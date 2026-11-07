/**
 * 稳定性对照：同一段语料抽两遍，差多少。
 *
 * 「重建不是还原」这句话如果只是嘴上说说，就等于给调优留了一个无底洞：每次重跑
 * 结果不一样，都能解释成「模型本来就不确定」。反过来，如果两遍差很多，那也不是
 * 语料的问题，是提示词或者参数没定住，该调。
 *
 * 这个脚本就是去量那个差：同一份 exchanges，同样的配置，跑 N 遍，逐条对齐，
 * 看有多少条是「同一件事的不同说法」，有多少条只在一遍里出现。
 *
 * 用法：
 *   node scripts/stability.mjs <会话文件> [...更多] [--runs=2]
 *
 * 只调模型，不写库——抽取结果是打印出来比的，思源一条都不会动。
 */
import { readLog } from "../src/shared/readers/index.mjs";
import { toExchanges, extractEntries } from "../src/center/extract.mjs";
import { loadConfig } from "../src/shared/config.mjs";
import { parseArgs } from "../src/shared/args.mjs";

const { flags, rest: raw } = parseArgs(process.argv.slice(2));
// `--runs 3` 这种空格写法，parseArgs 会把 3 留进 rest，于是被当成一个文件名读。
// 只删掉"和 --runs 值相同、且是纯数字"的那一个，别误伤真的文件。
const rest = [...raw];
if (flags.runs !== undefined) {
  const i = rest.indexOf(String(flags.runs));
  if (i >= 0 && /^\d+$/.test(rest[i])) rest.splice(i, 1);
}
const runs = Math.max(2, Number(flags.runs) || 2);
if (!rest.length) {
  console.error("用法：node scripts/stability.mjs <会话文件> [...] [--runs=2]");
  process.exitCode = 1;
  throw new Error("没有输入");
}

/** 二元组覆盖率：只用来判「这两条说的是不是同一件事」，不判顺序也不判长短。 */
const bigrams = (s) => {
  const t = String(s ?? "").replace(/[\s，。；：、（）()「」【】]/g, "");
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};

const cover = (a, b) => {
  const A = bigrams(a);
  const B = bigrams(b);
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  if (!small.size) return 0;
  let hit = 0;
  for (const g of small) if (big.has(g)) hit++;
  return hit / small.size;
};

/** 每条在另一份里找最好的那条。同一件事的两种写法，覆盖率一般 0.4 以上。 */
function align(base, other) {
  return base.map((e) => {
    let best = { score: 0, text: "" };
    for (const o of other) {
      const s = cover(e.text, o.text);
      if (s > best.score) best = { score: s, text: o.text };
    }
    return { entry: e, ...best };
  });
}

const cfg = loadConfig();

for (const file of rest) {
  const log = readLog(file);
  const exchanges = toExchanges(log.turns);
  const chars = exchanges.reduce((n, x) => n + x.q.length + x.a.length, 0);
  console.log(`\n=== ${file.split("/").pop()}`);
  console.log(`    ${log.harness}  ${exchanges.length} 轮  ${chars} 字`);

  const results = [];
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    const r = await extractEntries(cfg, exchanges);
    results.push(r);
    console.log(
      `    第 ${i + 1} 遍：${r.entries.length} 条  批 ${r.batches}  ` +
        `${Math.round((Date.now() - t0) / 1000)}s  ` +
        `prompt ${r.usage.prompt} / completion ${r.usage.completion}`
    );
  }

  const counts = results.map((r) => r.entries.length);
  console.log(`    条数 ${counts.join(" / ")}`);

  const ents = results.map((r) => new Set(r.entries.map((e) => e.entity).filter(Boolean)));
  const union = new Set(ents.flatMap((s) => [...s]));
  const inter = [...ents[0]].filter((e) => ents.every((s) => s.has(e)));
  console.log(`    话题 交集 ${inter.length} / 并集 ${union.size}`);
  const onlySomewhere = [...union].filter((e) => !inter.includes(e));
  if (onlySomewhere.length) console.log(`    只在某一遍里的话题：${onlySomewhere.join("、")}`);

  // 两两对齐，看「同一件事」的覆盖率分布。
  const [a, b] = results;
  const ab = align(a.entries, b.entries);
  const ba = align(b.entries, a.entries);
  const both = [...ab, ...ba];
  const same = both.filter((x) => x.score >= 0.6);
  const weak = both.filter((x) => x.score >= 0.3 && x.score < 0.6);
  console.log(
    `    对齐：${same.length} 条能对上（≥0.6），${weak.length} 条勉强（0.3-0.6），` +
      `${both.length - same.length - weak.length} 条只在一遍里`
  );

  const orphan = [...ab, ...ba].filter((x) => x.score < 0.3).map((x) => x.entry);
  for (const e of orphan.slice(0, 8)) {
    console.log(`      · [${e.entity}] ${String(e.text).slice(0, 70)}`);
  }
}
