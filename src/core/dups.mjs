/**
 * 存量重复体检。判重是写入前的闸，这里查的是"闸收紧之前已经写进去的"双胞胎。
 *
 * 只按字面重合找，范围限定同话题；跨话题要显式 --all，因为跨话题的同义改写
 * 常常是同一件事的不同侧面，不该合。结果只给建议，处置必须人点头。
 */
import { ATTR } from "./store.mjs";

/** 原文指针会占几十个二元组，两条毫不相干的条目也能因此被判成相似。 */
export function stripPointer(s) {
  return String(s ?? "")
    .replace(/\[原文\]\([^)]*\)/g, " ")
    .replace(/原文\s*assets\/\S+/g, " ")
    .replace(/assets\/mem-raw\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function bigrams(s) {
  const t = String(s ?? "").replace(/[\s，。；：、！？（）()「」【】《》—…·,.;:!?]/g, "");
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

const attr = (ial, key) => {
  const m = new RegExp(`${key}="([^"]*)"`).exec(String(ial ?? ""));
  return m ? m[1] : "";
};

/** 找重复对。keep 只是按正文长度给的默认建议，不是结论。 */
export async function findDuplicates({ sy, cfg, min = 0.75, crossEntity = false, limit = 5000 }) {
  const notebook = cfg?.siyuan?.notebook ?? "";
  const boxes = await sy.listNotebooks();
  const box = boxes.find((b) => b.name === notebook)?.id ?? "";
  if (!box) throw new Error(`找不到笔记本「${notebook}」`);
  const rows = await sy.sql(
    `SELECT id, content, ial FROM blocks WHERE box='${box}' AND type='p'
       AND ial LIKE '%${ATTR.hash}="%' AND ial NOT LIKE '%${ATTR.status}="archived"%'
       ORDER BY updated DESC LIMIT ${limit}`
  );
  if (!Array.isArray(rows)) throw new Error("列条目失败：SQL 没返回数组");
  const items = rows.map((r) => ({
    id: r.id,
    text: stripPointer(r.content),
    entity: attr(r.ial, ATTR.entity),
    date: attr(r.ial, ATTR.date),
  }));
  const sets = items.map((it) => bigrams(it.text));
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (!crossEntity && items[i].entity !== items[j].entity) continue;
      const A = sets[i], B = sets[j];
      if (!A.size || !B.size) continue;
      const [small, big] = A.size <= B.size ? [A, B] : [B, A];
      let hit = 0;
      for (const g of small) if (big.has(g)) hit++;
      const cov = hit / small.size;
      if (cov < min) continue;
      const a = items[i], b = items[j];
      const keep = a.text.length >= b.text.length ? a : b;
      const drop = a.text.length >= b.text.length ? b : a;
      pairs.push({ cov, keep, drop });
    }
  }
  return { total: items.length, pairs: pairs.sort((a, b) => b.cov - a.cov) };
}

/** 同一个 drop 只处理一次：优先采纳重合度最高的那对，避免一条被标给两个 keep。 */
export function pickPairs(pairs) {
  const used = new Set();
  const out = [];
  for (const p of pairs) {
    if (used.has(p.drop.id) || used.has(p.keep.id)) continue;
    used.add(p.drop.id);
    used.add(p.keep.id);
    out.push(p);
  }
  return out;
}
