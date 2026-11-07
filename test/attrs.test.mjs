/**
 * 条目属性的拼装。写块要连思源，但「拼成什么」是纯函数，应该能单独验。
 *
 * 这里钉的主要是一件事：可选字段**不写空串**。思源会把 `custom-mem-project=""`
 * 当成一个真属性存下来，于是「没有项目」和「项目是空」变成两种状态，
 * 查询就得写两个条件——这种坑一旦埋下去，后面每次查都得记得它。
 */
import test from "node:test";
import assert from "node:assert/strict";

const { entryAttrs, ATTR } = await import("../src/center/store.mjs");

const entry = { text: "x", entity: "订货系统", type: "decision", brief: "缩写", confidence: 4 };
const meta = { source: "workbuddy", session: "s1", date: "2026-11-03", project: "mini-wms", machine: "Mac", raw: "assets/a.jsonl#1-2" };

test("该有的都有，值都转成字符串", () => {
  const a = entryAttrs({ entry, meta, date: "2026-11-03", hash: "abc123" });
  assert.equal(a[ATTR.status], "current");
  assert.equal(a[ATTR.entity], "订货系统");
  assert.equal(a[ATTR.type], "decision");
  assert.equal(a[ATTR.hash], "abc123");
  assert.equal(a[ATTR.source], "workbuddy");
  assert.equal(a[ATTR.session], "s1");
  assert.equal(a[ATTR.project], "mini-wms");
  assert.equal(a[ATTR.machine], "Mac");
  assert.equal(a[ATTR.raw], "assets/a.jsonl#1-2");
  // 思源的属性值是字符串，数字传进去会被转成 "4" 也可能不被转，统一自己转。
  assert.equal(a[ATTR.confidence], "4");
});

test("没有项目就不出现这个键，不是空串", () => {
  const a = entryAttrs({ entry, meta: { ...meta, project: "" }, date: "2026-11-03", hash: "h" });
  assert.equal(ATTR.project in a, false);
});

test("机器、原文、摘要同理：没有就不写", () => {
  const a = entryAttrs({
    entry: { text: "x", entity: "e" },
    meta: { source: "dsh" },
    date: "2026-11-03",
    hash: "h",
  });
  assert.equal(ATTR.machine in a, false);
  assert.equal(ATTR.raw in a, false);
  assert.equal(ATTR.brief in a, false);
  // 没有 type / confidence 时给默认值，不能让属性缺一块。
  assert.equal(a[ATTR.type], "fact");
  assert.equal(a[ATTR.confidence], "3");
  // session 空是正常的（mem remember 没有会话），但要写成空串而不是 undefined——
  // undefined 会被 JSON 序列化丢掉，块上就少一个属性。
  assert.equal(a[ATTR.session], "");
});
