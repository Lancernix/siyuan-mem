/**
 * 原文归档与实体归一的纯逻辑测试。不联网、不碰思源。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildPart, sliceByBytes, parsePtr, readRange } from "../src/raw.mjs";
import { norm, similarity, editDistance, longestCommonSubstring, parsePending } from "../src/entities.mjs";

/* ---------- 归一化与相似度 ---------- */

test("规范化只做不改变语义的变形", () => {
  assert.equal(norm("风盾 500"), norm("风盾500"));
  assert.equal(norm("风盾（京造）500"), "风盾500");
  assert.equal(norm("UTO 速干衣"), "uto速干衣");
  // 数字和字母必须留着：500 和 500pro 的区别就在这里
  assert.notEqual(norm("风盾500"), norm("风盾500pro"));
});

test("编辑距离", () => {
  assert.equal(editDistance("风盾500", "风盾500"), 0);
  assert.equal(editDistance("风盾500", "风盾501"), 1);
  assert.equal(editDistance("", "abc"), 3);
});

test("最长公共子串（不是子序列）", () => {
  assert.equal(longestCommonSubstring("风盾500", "京造风盾500"), 5);
  assert.equal(longestCommonSubstring("abc", "xyz"), 0);
});

test("包含关系算强命中", () => {
  // 品牌前缀不影响判断：京造风盾500 就是风盾500 的全称
  assert.ok(similarity("风盾500", "京造风盾500").score >= 0.85);
  assert.ok(similarity("风盾500", "风盾 500").score >= 0.85);
});

test("型号后缀不算强命中", () => {
  // 这一条是刻意压低的：pro/max/mini 一般是另一个 SKU，合错了要重灌
  for (const suf of ["pro", "max", "mini", "plus", "ultra", "2"]) {
    const s = similarity("风盾500", `风盾500${suf}`);
    assert.ok(s.score < 0.85, `${suf} 不该强命中，实际 ${s.score}`);
    assert.ok(s.score >= 0.55, `${suf} 应该至少进候选，实际 ${s.score}`);
  }
});

test("无关名字不给候选", () => {
  assert.ok(similarity("风盾500", "UTO速干衣").score < 0.55);
  assert.ok(similarity("思源MCP", "投影仪桌面").score < 0.55);
});

/* ---------- 指针 ---------- */

test("指针能解析出路径和轮次", () => {
  const p = parsePtr("assets/mem-raw/Mac/wb/x.p1-2026.jsonl#120-180");
  assert.equal(p.path, "assets/mem-raw/Mac/wb/x.p1-2026.jsonl");
  assert.equal(p.from, 120);
  assert.equal(p.to, 180);
});

test("指针没有区间时当整份读", () => {
  const p = parsePtr("assets/a/b.jsonl");
  assert.equal(p.path, "assets/a/b.jsonl");
  assert.equal(p.from, null);
});

/* ---------- JSONL ---------- */

const turns = Array.from({ length: 8 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  text: `第 ${i + 1} 轮的内容`,
}));

test("首行是 meta，后面一行一轮", () => {
  const p = buildPart({ machine: "Mac", harness: "workbuddy", session: "s1", from: 101 }, turns);
  const lines = p.buf.toString("utf8").trimEnd().split("\n");
  assert.equal(lines.length, 9);
  const head = JSON.parse(lines[0]);
  assert.equal(head.type, "session");
  assert.equal(head.from, 101);
  assert.equal(head.to, 108);
  assert.equal(head.turns, 8);
  assert.ok(head.hash);
  const last = JSON.parse(lines[8]);
  assert.equal(last.i, 108);
  assert.equal(last.role, "assistant");
});

test("轮次号是全局的，不是每次从 1 开始", () => {
  const p = buildPart({ machine: "Mac", harness: "wb", session: "s1", from: 500 }, turns.slice(0, 3));
  const rows = p.buf.toString("utf8").trimEnd().split("\n").slice(1).map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.i), [500, 501, 502]);
});

test("超大时按轮次切块，一块不丢", () => {
  const big = Array.from({ length: 40 }, (_, i) => ({ role: "user", text: "字".repeat(200) }));
  const chunks = sliceByBytes({ machine: "Mac" }, big, 2000);
  assert.ok(chunks.length > 1, "应该切成多块");
  assert.equal(chunks.reduce((n, c) => n + c.length, 0), 40, "轮次总数不变");
  // 顺序不能乱：拼起来必须等于原文
  assert.deepEqual(chunks.flat().map((t) => t.text), big.map((t) => t.text));
});

/* ---------- 读回 ---------- */

const fakeSy = (text) => ({ getAsset: async () => text });

test("按区间读，超界截断", async () => {
  const p = buildPart({ machine: "Mac", harness: "wb", session: "s", from: 10 }, turns);
  const sy = fakeSy(p.buf.toString("utf8"));
  const r = await readRange(sy, "assets/x.jsonl#12-14", { maxChars: 10000 });
  assert.deepEqual(r.turns.map((t) => t.i), [12, 13, 14]);
  assert.equal(r.truncated, false);
});

test("字数上限会标记 truncated", async () => {
  const p = buildPart({ machine: "Mac", harness: "wb", session: "s", from: 1 }, turns);
  const sy = fakeSy(p.buf.toString("utf8"));
  const r = await readRange(sy, "assets/x.jsonl#1-8", { maxChars: 20 });
  assert.ok(r.turns.length > 0 && r.turns.length < 8);
  assert.equal(r.truncated, true);
});

test("附件不存在返回 missing，不抛", async () => {
  const r = await readRange(fakeSy(null), "assets/nope.jsonl#1-2");
  assert.equal(r.missing, true);
  assert.equal(r.turns.length, 0);
});

test("坏行跳过，不影响后面的", async () => {
  const good = buildPart({ machine: "Mac", harness: "wb", session: "s", from: 1 }, turns.slice(0, 4));
  const lines = good.buf.toString("utf8").split("\n");
  lines[2] = "{ 这不是合法 JSON";
  const r = await readRange(fakeSy(lines.join("\n")), "assets/x.jsonl#1-4");
  assert.equal(r.turns.length, 3);
  assert.deepEqual(r.turns.map((t) => t.i), [1, 3, 4]);
});

/* ---------- 待确认三态 ---------- */

test("三态：空格待确认、X 合并、- 否定", () => {
  const md = [
    '- {: id="20260101000000-aaaaaaa"} [ ] 甲 ← 乙',
    '- {: id="20260101000000-bbbbbbb"} [X] 丙 ← 丁',
    '- {: id="20260101000000-ccccccc"} [-] 戊 ← 己',
  ].join("\n");
  const p = parsePending(md);
  assert.deepEqual(p.map((x) => x.state), ["todo", "merge", "reject"]);
  assert.deepEqual(p.map((x) => x.a), ["甲", "丙", "戊"]);
  assert.deepEqual(p.map((x) => x.b), ["乙", "丁", "己"]);
});

test("小写 x 也认：思源会存成大写，但手写的可能是小写", () => {
  const p = parsePending('- {: id="1-a"} [x] 甲 ← 乙');
  assert.equal(p[0].state, "merge");
});

test("没有箭头的行忽略（不会被当成待确认项）", () => {
  const md = ['- {: id="1-a"} [ ] 随便一段话', '- {: id="1-b"} [X] 甲 ← 乙'].join("\n");
  assert.equal(parsePending(md).length, 1);
});

test("行尾的括注（时间戳）不算名字的一部分", () => {
  const p = parsePending('- {: id="1-a"} [X] 甲 ← 乙（2026-10-30 起）');
  assert.equal(p[0].b, "乙");
});
