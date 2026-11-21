import test from "node:test";
import assert from "node:assert/strict";
const { stripPointer, bigrams, pickPairs } = await import("../src/core/dups.mjs");

test("算相似度前剔掉原文指针，别让共用路径把不相干的两条连一起", () => {
  const a = "容器端口是 7788 [原文](assets/mem-raw/Mac/dsh/sess-a.jsonl#1-20)";
  const b = "数据库端口是 3306 [原文](assets/mem-raw/Mac/dsh/sess-a.jsonl#1-20)";
  assert.ok(bigrams(stripPointer(a)).size > 0);
  assert.equal([...bigrams(stripPointer(a))].some((g) => g.includes("assets")), false);
  assert.equal(stripPointer(a).includes("原文"), false);
});

test("同一个 drop 只采纳重合度最高的一次，不会标给两个 keep", () => {
  const pairs = [
    { cov: 0.9, keep: { id: "k1" }, drop: { id: "d1" } },
    { cov: 0.8, keep: { id: "k2" }, drop: { id: "d1" } },
    { cov: 0.77, keep: { id: "k3" }, drop: { id: "d2" } },
  ];
  assert.deepEqual(pickPairs(pairs).map((p) => [p.keep.id, p.drop.id]), [["k1", "d1"], ["k3", "d2"]]);
});
