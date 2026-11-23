import test from "node:test";
import assert from "node:assert/strict";
const { stripPointer, bigrams, pickPairs, findDuplicates } = await import("../src/core/dups.mjs");
const { parseArgs } = await import("../src/util/args.mjs");
const { ymd } = await import("../src/util/ymd.mjs");

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


test("--min 要当值参数解析，不能变成 true（Number(true)=1 会让阈值悄悄变 1）", () => {
  assert.equal(parseArgs(["--min", "0.8"]).flags.min, "0.8");
  assert.equal(parseArgs(["--min=0.8"]).flags.min, "0.8");
});


test("超短条目不参与配对：2 个字的「端口」不能跟长条目算出 1.00", async () => {
  const rows = [
    {
      id: "short",
      content: "端口\n\n((assets/mem-raw/Mac/dsh/s.jsonl#1-2))",
      ial: 'custom-mem-entity="端口映射" custom-mem-date="2026-11-20"',
    },
    {
      id: "long",
      content: "端口映射要从 7789 改回 7788，改完重启容器才生效。\n\n((assets/mem-raw/Mac/dsh/s.jsonl#1-2))",
      ial: 'custom-mem-entity="端口映射" custom-mem-date="2026-11-20"',
    },
  ];
  const sy = { listNotebooks: async () => [{ id: "box", name: "记忆" }], sql: async () => rows };
  const cfg = { siyuan: { notebook: "记忆" } };
  const { pairs } = await findDuplicates({ sy, cfg, min: 0.5, minLen: 6 });
  assert.equal(pairs.length, 0, "短于 6 字的条目不该进配对");
});


test("ymd 认秒级时间戳：1700000000 不能落到 1970", () => {
  assert.equal(ymd(1700000000), "2023-11-15");
  assert.equal(ymd(1700000000000), "2023-11-15");
});
