/**
 * 检索词拆分。看起来是个小函数，但拆错了会让召回"看起来有结果、其实全不相干"。
 */
import test from "node:test";
import assert from "node:assert/strict";

const { termsOf } = await import("../src/center/search.mjs");

test("单个汉字是有意义的检索词", () => {
  // 原来一律要求 ≥2 字，`mem search 车` 会拆出空数组；SQL 里没有 LIKE 条件，
  // 结果退化成"按更新时间返回最新几十条"，一条都不相关，还看不出来。
  assert.deepEqual(termsOf("车"), ["车"]);
  assert.deepEqual(termsOf("书 钱"), ["书", "钱"]);
});

test("单字母英文丢掉，两字母以上保留", () => {
  assert.deepEqual(termsOf("a b io"), ["io"]);
});

test("虚词丢掉，标点切开，最多六个词", () => {
  assert.deepEqual(termsOf("the with rust"), ["rust"]);
  assert.deepEqual(termsOf("静默，阈值；条目"), ["静默", "阈值", "条目"]);
  assert.equal(termsOf("一 二 三 四 五 六 七 八").length, 6);
});

test("只有标点时返回空——调用方据此返回 no-terms，而不是捞最新几条", () => {
  assert.deepEqual(termsOf("，。！？？"), []);
  assert.deepEqual(termsOf("   "), []);
});
