/**
 * 找出语义重复的条目：同一实体里字面高度重合的两条。
 *
 * 这不是判重，是体检。判重发生在写入前，只能看当时能取到的候选；跑久了之后
 * 会留下两类东西——重跑同一天内容留下的双胞胎，以及早期判重还没收紧时写进去的
 * 近义条目。它们不会自己消失，也不该由下一轮抽取来"顺手覆盖"，因为两者都
 * 有原文指针，覆盖等于丢掉一条时间线。
 *
 * 所以这里只负责「找出来给人看」。怎么处置是人的决定：一般是把信息更全的那条
 * 留下，另一条 supersede（不删块，指针保得住）。
 *
 *   node scripts/find-dups.mjs            # 同实体，重合 ≥0.75
 *   node scripts/find-dups.mjs --all --min=0.6
 *   node scripts/find-dups.mjs --json
 *
 * 覆盖率取的是「较短那条被较长的覆盖了多少」，只看字面。所以 0.75 以上基本
 * 是同义改写，0.6-0.75 之间要人读一遍——经常是同一件事的不同侧面，不该合。
 */
import { loadConfig } from "../src/util/config.mjs";
import { SiYuan } from "../src/util/siyuan.mjs";
import { ATTR } from "../src/core/store.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const min = Number(opt("min", 0.75));
const crossEntity = flag("all");
const asJson = flag("json");

const cfg = loadConfig();
const sy = new SiYuan(cfg.siyuan);

// 笔记本名不是 box id，得先换过来。（原来这里还有一条按 content 查 box 的 SQL，
// 查完从没用过——留着只会让人以为它在起什么作用。）
const notebooks = await sy.listNotebooks();
const nb = notebooks.find((n) => n.name === cfg.siyuan.notebook);
if (!nb) {
  console.error(`找不到笔记本：${cfg.siyuan.notebook}`);
  process.exit(1);
}

// 口径要跟 store.listCurrent 一致：type='p' + hash 入口 + box 收口。
// 少了 hash 那一条，会把别的属性视图/索引块里偶然带 status 的段落也算进来。
const rows = await sy.sql(
  `SELECT id, content, ial FROM blocks WHERE box='${nb.id}' AND type='p'
     AND ial LIKE '%${ATTR.hash}="%'
     AND ial LIKE '%${ATTR.status}="current"%' LIMIT 5000`
);
const attr = (ial, key) => {
  const m = ial.match(new RegExp(`${key}="([^"]*)"`));
  return m ? m[1] : "";
};

/**
 * 条目末尾挂着原文指针，同一场会话的条目共用一长串路径
 * （`原文 assets/mem-raw/Mac/workbuddy/75af3e28-1a8c-…`）。
 *
 * 算相似度前必须剔掉：那串路径本身有几十个二元组，能把两条毫不相干的条目
 * 顶到 0.6 以上。第一次跑这个脚本报了 17 对疑似重复，其中 13 对是这么来的
 * ——条目的正文完全不同，共享的只有路径。这种假阳性比漏报更费时间。
 */
const stripPointer = (s) =>
  String(s ?? "")
    .replace(/\[原文\]\([^)]*\)/g, " ")
    .replace(/原文\s*assets\/\S+/g, " ")
    .replace(/assets\/mem-raw\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const items = rows.map((r) => ({
  id: r.id,
  text: stripPointer(r.content),
  entity: attr(r.ial, ATTR.entity),
  date: attr(r.ial, ATTR.date),
  type: attr(r.ial, ATTR.type),
}));

/** 汉字按二元组切。标点先去掉，否则「，」会把两条不相干的句子连成共同片段。 */
function bigrams(s) {
  const t = s.replace(/[\s，。；：、！？（）()「」【】《》—…·,.;:!?]/g, "");
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

const sets = items.map((it) => bigrams(it.text));
const pairs = [];
for (let i = 0; i < items.length; i++) {
  for (let j = i + 1; j < items.length; j++) {
    if (!crossEntity && items[i].entity !== items[j].entity) continue;
    const A = sets[i];
    const B = sets[j];
    if (!A.size || !B.size) continue;
    const [small, big] = A.size <= B.size ? [A, B] : [B, A];
    let hit = 0;
    for (const g of small) if (big.has(g)) hit++;
    const cov = hit / small.size;
    if (cov >= min) {
      const a = items[i];
      const b = items[j];
      pairs.push({ cov, keep: a.text.length >= b.text.length ? a : b, drop: a.text.length >= b.text.length ? b : a });
    }
  }
}
pairs.sort((x, y) => y.cov - x.cov);

if (asJson) {
  console.log(JSON.stringify({ total: items.length, min, pairs }, null, 2));
} else {
  console.log(`${items.length} 条 current，${crossEntity ? "跨实体" : "同实体"}重合约 ${min}：${pairs.length} 对\n`);
  for (const p of pairs) {
    console.log(`${p.cov.toFixed(2)}  ${p.keep.entity} · ${p.keep.date}`);
    console.log(`  留 ${p.keep.id} (${p.keep.text.length}) ${p.keep.text.slice(0, 60)}…`);
    console.log(`  弃 ${p.drop.id} (${p.drop.text.length}) ${p.drop.text.slice(0, 60)}…`);
    console.log("");
  }
  if (pairs.length) {
    console.log("「留/弃」只是按长度给的默认建议，不是结论——信息更全的那条不一定是更长的那条。");
    console.log("处置用 mem 的 supersede：标 superseded，不删块，原文指针还在。");
  }
}
