/**
 * MCP 层两个新工具：分发、参数翻译、路由文案、空结果兜底、失败分类、控量。
 *
 * 协议壳测试不连思源：三个实现都注入。重点验「模型看到的结果能不能自己走下一步」——
 * 这是加多工具的意义所在，工具能调通但结果没有引导，等于没加。
 */
import test from "node:test";
import assert from "node:assert/strict";

const { handleMessage, formatTopics, formatEntries, TOOLS } = await import("../src/mcp/server.mjs");

const call = (name, args, io) =>
  handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, io);

const textOf = (r) => r.result?.content?.[0]?.text ?? "";

const topicResult = {
  topics: [{ name: "通勤骑行", aliases: ["骑行穿搭"], count: 3, last: "2026-11-10", match: "name" }],
  total: 1, shown: 1, truncated: false, degraded: false, hint: "", q: "通勤", fallback: false,
};

test("三个工具都能分发，参数翻译对了（含 include_superseded → status 空串）", async () => {
  const calls = [];
  const io = {
    search: async (o) => (calls.push(["search", o]), { hits: [], terms: ["x"] }),
    topics: async (o) => (calls.push(["topics", o]), topicResult),
    entries: async (o) => (calls.push(["entries", o]), { hits: [], total: 0, topic: o.topic, canonical: o.topic, hint: "", unknown: false }),
  };
  await call("memory_topics", { q: "通勤", limit: 7, include_superseded: true }, io);
  await call("memory_entries", { topic: "通勤骑行", limit: 3, days: 30 }, io);
  assert.equal(calls[0][0], "topics");
  assert.equal(calls[0][1].q, "通勤");
  assert.equal(calls[0][1].limit, 7);
  assert.equal(calls[0][1].status, "");
  assert.equal(calls[0][1].source, "mcp");
  assert.equal(calls[1][0], "entries");
  assert.equal(calls[1][1].topic, "通勤骑行");
  assert.equal(calls[1][1].days, 30);
  assert.equal(calls[1][1].status, undefined);
});

test("工具清单三个，各自 description 都点名另两个", () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ["memory_search", "memory_topics", "memory_entries"]);
  TOOLS.forEach((t, i) => {
    for (const other of TOOLS.filter((_, j) => j !== i)) {
      assert.ok(t.description.includes(other.name), `${t.name} 该提到 ${other.name}`);
    }
  });
});

test("目录结果带匹配依据、条目数、下一步建议", async () => {
  const r = await call("memory_topics", { q: "通勤" }, { topics: async () => topicResult });
  const text = textOf(r);
  assert.match(text, /通勤骑行/);
  assert.match(text, /别名：骑行穿搭/);
  assert.match(text, /3 条/);
  assert.match(text, /\[名字命中\]/);
  assert.match(text, /下一步：/);
  assert.match(text, /memory_entries/);
  assert.equal(r.result.isError, undefined);
});

test("目录空了要给可操作兜底，不是一句「没有」", async () => {
  const r = await call("memory_topics", {}, { topics: async () => ({ topics: [], total: 0, shown: 0, hint: "", degraded: false }) });
  const text = textOf(r);
  assert.match(text, /话题目录是空的/);
  assert.match(text, /mem status/);
  assert.match(text, /memory_search/);
});

test("目录无匹配：兜底浏览要标明「不是匹配上的」，并指回搜索", async () => {
  const r = await call(
    "memory_topics",
    { q: "量子纠缠" },
    {
      topics: async () => ({
        topics: [{ name: "羽毛球", aliases: [], count: 2, last: "2026-09-20", match: "fallback" }],
        total: 1, shown: 1, truncated: false, degraded: false, fallback: true,
        hint: "可以用 memory_search 直接搜内容，或换个更短的词再列目录。",
        q: "量子纠缠",
      }),
    }
  );
  const text = textOf(r);
  assert.match(text, /\[兜底浏览\]/);
  // 头部先说清「没匹配上」，不能写成「共 1 个（过滤提示…）」——那看着像匹配了。
  assert.match(text.split("\n")[0], /没有匹配「量子纠缠」/);
  assert.match(text, /memory_search/);
  assert.equal(text.split("没有匹配").length - 1, 1, "同一句话别在结果里重复两遍");
  assert.doesNotMatch(text, /用 q 缩小范围/, "q 本来就没匹配上，不能再让人用它缩小范围");
});

test("实体表读不出来：目录要标降级，不能当权威清单", async () => {
  const r = await call(
    "memory_topics",
    {},
    { topics: async () => ({ ...topicResult, degraded: true, hint: "实体表读不出来，下面列的是条目上原样写的话题名；别名和已合并的旧名没归并，别当权威目录。" }) }
  );
  assert.match(textOf(r), /实体表读不出来/);
});

test("翻条目：结果带话题范围、别名归并依据、下一步", async () => {
  const r = await call(
    "memory_entries",
    { topic: "骑行穿搭" },
    {
      entries: async () => ({
        hits: [{ id: "a", entity: "通勤骑行", date: "2026-11-10", type: "decision", brief: "", text: "通勤车换 32C 光头胎" }],
        total: 3, shown: 1, truncated: true, topic: "骑行穿搭", canonical: "通勤骑行",
        hint: "「骑行穿搭」已归到规范名「通勤骑行」，连它的别名和旧名一起查了。",
        unknown: false,
      }),
    }
  );
  const text = textOf(r);
  assert.match(text, /话题「通勤骑行」下共 3 条/);
  assert.match(text, /已归到规范名/);
  assert.match(text, /32C 光头胎/);
  assert.match(text, /还有更多条目没列出/);
  assert.match(text, /memory_search\(query=/);
});

test("翻条目：名字没对上给候选名，不让模型继续换近义词", async () => {
  const r = await call(
    "memory_entries",
    { topic: "骑行穿塔" },
    {
      entries: async () => ({
        hits: [], total: 0, topic: "骑行穿塔", canonical: "", candidates: ["通勤骑行", "骑行穿搭"],
        hint: "没有「骑行穿塔」这个话题。最接近的是：通勤骑行 / 骑行穿搭。用规范名重试，或先用 memory_topics 查。",
        unknown: true,
      }),
    }
  );
  const text = textOf(r);
  assert.match(text, /最接近的是/);
  assert.match(text, /memory_topics/);
  assert.equal(r.result.isError, undefined, "这是可恢复的名字问题，不是工具失败");
});

test("翻条目：话题对上但没内容，下一步不同", async () => {
  const r = await call(
    "memory_entries",
    { topic: "羽毛球" },
    { entries: async () => ({ hits: [], total: 0, topic: "羽毛球", canonical: "羽毛球", hint: "", unknown: false }) }
  );
  const text = textOf(r);
  assert.match(text, /话题「羽毛球」下没有条目/);
  assert.match(text, /days \/ include_superseded/);
});

test("三个工具的后端故障统一走 isError，绝不说「没找到」", async () => {
  const failed = { failed: true, reason: "sql-not-array", hits: [], topics: [] };
  for (const [name, args, io] of [
    ["memory_search", { query: "x" }, { search: async () => failed }],
    ["memory_topics", {}, { topics: async () => failed }],
    ["memory_entries", { topic: "x" }, { entries: async () => failed }],
  ]) {
    const r = await call(name, args, io);
    assert.equal(r.result.isError, true, name);
    assert.match(textOf(r), /检索失败/);
    assert.match(textOf(r), /不代表没记过/);
    assert.doesNotMatch(textOf(r), /没找到|没有条目|目录是空的/, name);
  }
});

test("缺参数要在本地拦住，不打到后端", async () => {
  const calls = [];
  const r1 = await call("memory_entries", {}, { entries: async (o) => (calls.push(o), { hits: [] }) });
  const r2 = await call("memory_search", {}, { search: async (o) => (calls.push(o), { hits: [] }) });
  assert.equal(r1.result.isError, true);
  assert.match(textOf(r1), /缺 topic/);
  assert.match(textOf(r1), /memory_topics/);
  assert.equal(r2.result.isError, true);
  assert.equal(calls.length, 0);
});

test("入口没接某个实现：明确说「没接上」，不伪装成空结果", async () => {
  const r = await call("memory_topics", {}, { search: async () => ({ hits: [] }) });
  assert.equal(r.result.isError, true);
  assert.match(textOf(r), /话题目录没接上/);
});

test("未知工具把可用清单一起给，模型能自己纠名字", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "memory_lst" } });
  assert.equal(r.error.code, -32602);
  assert.match(r.error.message, /memory_search \/ memory_topics \/ memory_entries/);
});

test("search 空手时给导航出口，别让模型一直换近义词", async () => {
  const r = await call("memory_search", { query: "那个记账小工具" }, { search: async () => ({ hits: [], terms: ["记账", "小工"], reason: "no-match" }) });
  assert.match(textOf(r), /没找到相关记忆/);
  assert.match(textOf(r), /memory_topics/);
  assert.match(textOf(r), /memory_entries/);
});

test("格式化函数的控量边界：正文截断、条目数上限提示", () => {
  const long = "长".repeat(500);
  const out = formatEntries({
    hits: [{ id: "a", entity: "e", date: "2026-11-01", text: long, brief: "" }],
    total: 25, shown: 1, truncated: true, topic: "e", canonical: "e", hint: "", unknown: false,
  });
  assert.ok(out.includes(`${"长".repeat(400)}…`));
  assert.ok(!out.includes(long));
  assert.match(out, /最多 20/);
  const t = formatTopics({
    topics: [{ name: "e", aliases: [], count: 1, last: "2026-11-01", match: "" }],
    total: 80, shown: 1, truncated: true, q: "", hint: "", degraded: false,
  });
  assert.match(t, /最多 50/);
});
