/**
 * 检索词拆分。看起来是个小函数，但拆错了会让召回"看起来有结果、其实全不相干"。
 */
import test from "node:test";
import assert from "node:assert/strict";

const { termsOf } = await import("../src/core/search.mjs");

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

// ---- LIKE 通配符必须转义 ----

const { likeEsc } = await import("../src/core/search.mjs");

test("百分号、下划线、反斜杠都转义：% 不该变成「匹配所有」", () => {
  assert.equal(likeEsc("100%"), "100\\%");
  assert.equal(likeEsc("a_b"), "a\\_b");
  assert.equal(likeEsc("c\\d"), "c\\\\d");
});

test("单引号仍然按 SQL 规则转，两件事不互相覆盖", () => {
  assert.equal(likeEsc("it's 50%"), "it''s 50\\%");
});

// ---- 时间权重：旧而详细不能压过新而简短 ----

const { scoreOf } = await import("../src/core/search.mjs");

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test("半年差的旧条目，压不过新条目——哪怕它多提了几次关键词", () => {
  // 这就是 bwrap 那对真实数据：5 月那条把 bwrap 说了 4 次，6 月那条只说 1 次，
  // 旧的却排在前面。旧权重 -0.05/最多 -5 挡不住 8 分的关键词分。
  const old = { text: "bwrap bwrap bwrap bwrap 沙箱", brief: "", date: daysAgo(200) };
  const fresh = { text: "bwrap 已移除", brief: "", date: daysAgo(10) };
  assert.ok(scoreOf(fresh, ["bwrap"], "") > scoreOf(old, ["bwrap"], ""), "新条目该赢");
});

test("相关性极强时旧条目仍能胜出：提到 5 次就够翻盘", () => {
  // 封顶 8 分 ≈ 4 次词频。所以「把这件事说透了的旧条目」还能赢，
  // 「顺口提了四次的旧条目」赢不了——这个区分是刻意留的。
  const old = { text: "bwrap 沙箱 bwrap 限制 bwrap 权限 bwrap 规则 bwrap 边界", brief: "", date: daysAgo(200) };
  const fresh = { text: "bwrap 已移除", brief: "", date: daysAgo(1) };
  assert.ok(scoreOf(old, ["bwrap"], "") > scoreOf(fresh, ["bwrap"], ""), "旧条目该赢");
});

test("只说四次的旧条目赢不了：封顶就是为了这条", () => {
  const old = { text: "bwrap bwrap bwrap bwrap 沙箱", brief: "", date: daysAgo(200) };
  const fresh = { text: "bwrap 已移除", brief: "", date: daysAgo(1) };
  assert.ok(scoreOf(fresh, ["bwrap"], "") > scoreOf(old, ["bwrap"], ""), "新的该赢");
});

test("日期缺失按 60 天算，不当成今天", () => {
  const noDate = { text: "bwrap", brief: "", date: "" };
  const today = { text: "bwrap", brief: "", date: daysAgo(0) };
  assert.ok(scoreOf(today, ["bwrap"], "") > scoreOf(noDate, ["bwrap"], ""));
});
