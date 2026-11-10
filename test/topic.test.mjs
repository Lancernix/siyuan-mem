import test from "node:test";
import assert from "node:assert/strict";

const { topicNames, lookup } = await import("../src/core/entities.mjs");

/**
 * 话题过滤为什么需要这一层，直接看 2026-11-09 dsh 的实测：
 *
 *   topic="CAMP CROSS X 通勤车"（合并链的根）→ 「没找到」
 *   topic="通勤骑行"（条目上真正挂的名字）→ 6 条
 *
 * 条目上的 entity 是写入当时的名字，合并后旧名从条目上消失，可人记住的往往是旧名。
 * 只做字面匹配的话，这个失败长得和「库里没有这个话题」一模一样。
 */
const TABLE = [
  {
    name: "CAMP CROSS X 通勤车",
    aliases: ["后货架", "骑行驼包通勤载电脑"],
    status: "active",
    mergedInto: "",
  },
  { name: "秋冬骑行通勤穿衣", aliases: ["骑行背包背部出汗"], status: "merged", mergedInto: "CAMP CROSS X 通勤车" },
  { name: "骑行驼包通勤载电脑", aliases: [], status: "merged", mergedInto: "后货架" },
  { name: "骑行能力", aliases: ["骑行记录"], status: "active", mergedInto: "" },
  { name: "骑行记录", aliases: [], status: "merged", mergedInto: "骑行能力" },
];

test("主名字：直接命中，names 里带上它所有别名和归到它名下的旧名", () => {
  const r = topicNames(TABLE, "CAMP CROSS X 通勤车");
  assert.equal(r.found, true);
  assert.equal(r.canonical, "CAMP CROSS X 通勤车");
  // 二级合并：骑行驼包通勤载电脑 → 后货架 → CAMP CROSS X 通勤车
  for (const n of ["CAMP CROSS X 通勤车", "后货架", "骑行驼包通勤载电脑", "秋冬骑行通勤穿衣", "骑行背包背部出汗"]) {
    assert.ok(r.names.includes(n), `应该包含「${n}」`);
  }
});

test("别名：拿别名当话题，也要落到主名字上", () => {
  const r = topicNames(TABLE, "秋冬骑行通勤穿衣");
  assert.equal(r.canonical, "CAMP CROSS X 通勤车");
  assert.ok(r.names.includes("CAMP CROSS X 通勤车"));
});

test("已合并的旧名：顺着 mergedInto 爬到根，而不是原地匹配", () => {
  // 只按名字精确匹配的话，这里会 found=true 且 canonical="骑行背包背部出汗"，
  // 然后拿这个已死的名字去查条目，永远 0 条。
  const r = topicNames(TABLE, "骑行背包背部出汗");
  assert.equal(r.found, true);
  assert.equal(r.canonical, "CAMP CROSS X 通勤车");
  assert.ok(!r.names.includes("__missing__"));
});

test("规范化：空格和大小写不影响", () => {
  assert.equal(topicNames(TABLE, "  camp cross x 通勤车 ").canonical, "CAMP CROSS X 通勤车");
});

test("真没有的话题：found=false，让调用方报「没有这个话题」而不是「这个话题没内容」", () => {
  const r = topicNames(TABLE, "完全不存在的主题");
  assert.equal(r.found, false);
  assert.deepEqual(r.names, []);
});

test("表被改坏成环：不能挂死，退化成找不到", () => {
  const broken = [
    { name: "A", aliases: [], status: "merged", mergedInto: "B" },
    { name: "B", aliases: [], status: "merged", mergedInto: "A" },
  ];
  const r = topicNames(broken, "A");
  assert.equal(r.found, false);
});

test("空表 / 空名字不炸", () => {
  assert.equal(topicNames([], "任意").found, false);
  assert.equal(topicNames(TABLE, "   ").found, false);
  // lookup 保持原语义：只认活实体
  assert.equal(lookup(TABLE, "骑行背包背部出汗"), null);
});
