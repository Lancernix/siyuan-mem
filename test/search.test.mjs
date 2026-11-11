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

test("虚词丢掉，标点切开，上限 16 个词（2-gram 需要更多位置）", () => {
  assert.deepEqual(termsOf("the with rust"), ["rust"]);
  assert.deepEqual(termsOf("静默，阈值；条目"), ["静默", "阈值", "条目"]);
  // 原来 6 个词的帽子会把整句的后半截 2-gram 砍掉，等于白拆。
  assert.ok(termsOf("一 二 三 四 五 六 七 八").length <= 16);
});

test("ASCII 标识符整体保留，不再被 . : / - 切碎", () => {
  // 收窄那边把这些当「模型编不出来的硬锚」，检索这边切碎就自相矛盾了。
  assert.ok(termsOf("亚狮龙 NO.5 是什么档位").includes("NO.5"));
  assert.ok(termsOf("镜像是 node:22-alpine 吗").includes("node:22-alpine"));
  assert.ok(termsOf("地址 192.168.1.10 不通").includes("192.168.1.10"));
  assert.ok(termsOf("改 /etc/nginx.conf 之后重启").some((t) => t.includes("nginx.conf")));
});

test("连续汉字长串切 2-gram，不再整句当成一个词", () => {
  const t = termsOf("羽毛球训练级用球的号段怎么排");
  assert.ok(t.length > 1, `整句 14 字不该是一个词，实际 ${t.length}`);
  assert.ok(t.includes("羽毛") && t.includes("用球"));
});

const { strongTerms, queryPlan, strongHits, anchorsHit, entryMatchesAnchors } = await import("../src/core/search.mjs");

test("虚词 2-gram 不算强词：否则负例会被「我的」「是多」灌进来", () => {
  const t = termsOf("我的护照号码是多少");
  const strong = strongTerms(t);
  assert.ok(!strong.includes("我的"), "「我的」是虚词组合");
  assert.ok(!strong.includes("是多"), "「是多」是虚词组合");
  assert.ok(strong.includes("护照") || strong.includes("号码"), "实词要留下");
});

test("queryPlan：关键词问法要求全中，整句问法放宽到 2 个实词", () => {
  const kw = queryPlan("亚狮龙 等级");
  assert.ok(kw.strong.length >= 2);
  assert.equal(kw.minShould, 2, "两个强词就该两个都命中，等价于原来的 AND");
  const full = queryPlan("羽毛球那几个号，哪些是比赛用的");
  assert.equal(full.minShould, 2, "整句切成一堆 2-gram，只要求 2 个实词");
  assert.ok(full.terms.length > full.strong.length, "整句里确实混着虚词片段");
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


test("强词门槛：虚词 2-gram 撑不起一次命中（真实库上的负例灌水回归）", () => {
  // 2026-11-11 实测：只把 SQL 从 AND 放宽到 OR、不加这道门槛，
  // 「我的护照号码是多少」会被一条提到「我的 / 是多」的记忆误召回。
  const p = queryPlan("我的护照号码是多少");
  const hay = "判重规则又调了一次，我的理解是多看一遍再决定";
  assert.equal(strongHits(hay, p.strong), 0, "虚词不算证据，不能过门槛");
  assert.ok(p.minShould >= 1);
});

test("强词门槛：正文里真有两个实词才放行", () => {
  const p = queryPlan("亚狮龙 NO.2 是什么级别");
  const hit = strongHits("亚狮龙的等级划分是 NO.1、NO.2 为高端竞赛级用球", p.strong);
  assert.ok(hit >= p.minShould, `命中 ${hit} 个强词，门槛 ${p.minShould}`);
});

test("查询里的标识符是硬约束：问 NO.9 不能拿 NO.5 来答", () => {
  // 加这道闸之前，「亚狮龙 NO.9 价格」会被 NO.5 的条目用「亚狮龙 + 价格」凑够
  // 两个强词蒙过去——结果看起来像答案，答的却是另一个型号。误答比空手更糟。
  const p = queryPlan("亚狮龙 NO.9 现在什么价格");
  assert.ok(p.anchors.includes("NO.9"), `锚应保留 NO.9，实际 ${p.anchors.join(",")}`);
  assert.equal(anchorsHit("亚狮龙 NO.5/6/7 入手价：85/80/75 元以下", p.anchors), false);
  assert.equal(anchorsHit("亚狮龙 NO.9 暂无报价，NO.5 是 85 元", p.anchors), true);
});

test("不含标识符的查询不设这道约束", () => {
  const p = queryPlan("怎么关掉 skill 自动生成");
  assert.deepEqual(p.anchors, []);
  assert.equal(anchorsHit("完全无关的内容", p.anchors), true);
});

test("虚词判定不能单字连坐：性能 / 时间 / 会议 都是实词", () => {
  // 2026-11-11 第十二轮 CR 实证：单字连坐把这些词整批判成虚词，强词集一空
  // 闸门就退回全部虚词 2-gram + 门槛 1——「会议时间」能命中任何提到「时间」的条目。
  for (const q of ["性能", "功能", "智能", "时间", "会议", "能力", "上限", "下游"]) {
    const p = queryPlan(q);
    assert.ok(p.strong.length > 0, `「${q}」不该被判成虚词`);
    assert.equal(p.meaningful, true);
  }
  // 真虚词仍然要挡住
  for (const q of ["我的", "怎么样", "可能"]) {
    assert.equal(queryPlan(q).meaningful, false, `「${q}」没有实词，不该往下走`);
  }
});

test("两个实词的短查询门槛是 2：会议时间不该被只提「时间」的条目蒙过", () => {
  const p = queryPlan("会议时间");
  assert.ok(p.strong.length >= 2);
  assert.equal(p.minShould, 2);
  assert.equal(strongHits("部署时间改到凌晨，避开业务高峰", p.strong) >= p.minShould, false);
});

test("年份当锚时把 date 也算上：不然按年份查必然空手", () => {
  // 2026 是硬锚，但日期不在正文里。只用 text/brief/entity 比对，
  // 「2026 年的部署计划」会把所有 2026 年写的条目都过滤掉。
  const p = queryPlan("2026 年的部署计划");
  assert.deepEqual(p.anchors, ["2026"]);
  assert.equal(anchorsHit("部署计划改用 compose 编排", p.anchors), false);
});

test("提问框架词不进强词：一次 / 需要 / 大概 / 多少 在正文里到处都是", () => {
  // 变异验证过：去掉 WEAK_GRAMS 这条会红。当时两条负例就是靠「需要 + 一次」
  // 命中读书笔记和投影仪的，三条命中里没有一条跟咖啡有关。
  const t = termsOf("咖啡机多久需要除一次垢");
  const strong = strongTerms(t);
  for (const w of ["一次", "需要", "多久", "多少", "大概"]) {
    assert.ok(!strong.includes(w), `「${w}」是提问框架词，不该进强词集`);
  }
  assert.ok(strong.some((x) => x.includes("咖啡")), "咖啡是实词，要留下");
});

test("锚校验把 date 算进去：年份查询不该必然空手", () => {
  // 变异验证过：改回只传 hay 这条会红。2026 是硬锚，但日期不在正文里，
  // 只比正文的话，所有 2026 年写的条目都会被过滤掉。
  const anchors = ["2026"];
  assert.equal(entryMatchesAnchors({ text: "部署计划改用 compose 编排", brief: "", entity: "轻量云服务器", date: "2026-11-06" }, anchors), true);
  assert.equal(entryMatchesAnchors({ text: "部署计划改用 compose 编排", brief: "", entity: "轻量云服务器", date: "2025-11-06" }, anchors), false);
});
