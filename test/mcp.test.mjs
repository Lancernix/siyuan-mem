/**
 * MCP 这层的边界：握手、工具清单、调用、错误、以及「stdout 里只有协议」。
 *
 * 这些都不依赖思源和模型——检索是注入的。验的是协议壳，不是 SQL。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";

const { handleMessage, startMcp, formatHits, TOOL } = await import("../src/mcp/server.mjs");

const hits = [
  {
    id: "b1",
    entity: "静默阈值",
    brief: "从 3 分钟改成 30 分钟",
    date: "2026-11-02",
    type: "decision",
    text: "静默阈值从 3 分钟改成 30 分钟，目的是别推还在写的会话。",
    raw: "assets/mem-raw/laptop/x.jsonl#3-9",
  },
];

const stub = (calls = [], out = { terms: ["静默"], hits }) => async (opts) => {
  calls.push(opts);
  return out;
};

test("握手回自己支持的协议版本，不回显客户端的", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  // 回显等于承诺"这个版本的语义我也懂"。只实现了 2024-11-05 就只报这个，
  // 客户端不支持会自己断开——那是明确的失败，比连上之后不响应好查。
  assert.equal(r.result.protocolVersion, "2024-11-05");
  assert.deepEqual(r.result.capabilities.tools, {});
  assert.equal(r.result.serverInfo.name, "siyuan-mem");
});

test("serverInfo 的版本来自 package.json，不是写死的", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const r = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  // 以前写死 "0.1.0"，发到 0.1.3 还报 0.1.0——而这个字段正是排查「客户端到底
  // 加载了哪一版」的第一条线索，写死等于永远给错答案。
  assert.equal(r.result.serverInfo.version, pkg.version);
  assert.notEqual(pkg.version, "0.1.0", "发布副本里这份会被 CI 改成 tag 版本；开发副本是占位符");
});

test("initialize 带 instructions：告诉客户端什么时候该来查", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const text = r.result.instructions;
  // 八天里一次主动检索都没有——工具不缺，缺的是「这种问法该查」的判断。
  // 这段会被客户端注入模型上下文，所以触发词必须在里面。
  assert.ok(typeof text === "string" && text.length > 80, "instructions 不能是空的");
  for (const kw of ["之前", "上次", "memory_search", "memory_topics"]) {
    assert.ok(text.includes(kw), `instructions 里要有「${kw}」`);
  }
  // 光有「之前/上次」这类词法触发不够：用户说「今天打球，拍子手感不对」，
  // 一个字都没提过去，但答案要靠他不知道的私有事实（什么拍子、几磅）。
  // 判断标准必须写成缺口，而不是话题相关——后者会让它每轮都去查一遍。
  assert.ok(text.includes("私有情况") || text.includes("不掌握"), "要给出「什么时候算需要查」的判断标准");
  assert.ok(text.includes("就别查") || text.includes("就不用查"), "要有刹车：上下文已清楚、寒暄常识都不查");
  // 枚举会把范围钉死：写了「器材、车、项目、老毛病」之后，模型遇到第五类就
  // 认为不在授权范围内。所以必须明说这三条只是形状，不是清单。
  assert.ok(text.includes("不是清单"), "触发条件要给自主权，不能写成封闭枚举");
  assert.ok(text.length < 600, "别写太长，每轮都要占 token");
});

test("通知不回：回了客户端会当成孤儿响应", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(r, null);
});

test("工具清单是「一个主入口 + 两个导航工具」，各自说清互相的路由", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(
    r.result.tools.map((t) => t.name),
    ["memory_search", "memory_topics", "memory_entries"]
  );
  assert.equal(r.result.tools[0].name, TOOL.name);
  assert.deepEqual(r.result.tools[0].inputSchema.required, ["query"]);
  assert.deepEqual(r.result.tools[2].inputSchema.required, ["topic"]);
  // 路由必须写在 description 里：不依赖 harness 的系统提示词，每个客户端自带。
  // 少一条就等于没给工具——模型不知道什么时候该换一个。
  for (const [i, others] of [
    [0, ["memory_topics", "memory_entries"]],
    [1, ["memory_search", "memory_entries"]],
    [2, ["memory_search", "memory_topics"]],
  ]) {
    for (const other of others) {
      assert.ok(r.result.tools[i].description.includes(other), `工具 ${i} 的描述该提到 ${other}`);
    }
  }
});

test("每个工具都声明四个 hint：缺一个，OpenAI 目录直接退回", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  for (const t of r.result.tools) {
    const a = t.annotations;
    assert.ok(a, `${t.name} 该有 annotations`);
    // 四个都必须是布尔值：规范默认值是「非只读 + 可能破坏 + 非幂等 + 开放世界」，
    // 漏写一个就等于按最坏情况算，客户端每次调用都会弹确认。
    for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.equal(typeof a[k], "boolean", `${t.name} 的 ${k} 该是布尔`);
    }
    // 这三个工具都不碰思源里的数据、也不访问外网，只有一行本地审计日志。
    assert.equal(a.readOnlyHint, true, `${t.name} 只读`);
    assert.equal(a.destructiveHint, false, `${t.name} 不破坏`);
    assert.equal(a.openWorldHint, false, `${t.name} 不访问开放世界`);
    assert.ok(typeof a.title === "string" && a.title.length > 0, `${t.name} 该有给人看的标题`);
  }
});

test("调用：参数翻译对了，结果是人读文本带原文指针", async () => {
  const calls = [];
  const r = await handleMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "memory_search", arguments: { query: "静默 阈值", limit: 3, topic: "阈值", project: "siyuan-mem", include_superseded: true } },
    },
    { search: stub(calls) }
  );
  assert.equal(calls[0].q, "静默 阈值");
  assert.equal(calls[0].limit, 3);
  assert.equal(calls[0].topic, "阈值");
  assert.equal(calls[0].project, "siyuan-mem");
  // include_superseded 要翻成 status=""；传 undefined 服务端会退回 current，等于没生效。
  assert.equal(calls[0].status, "");

  const text = r.result.content[0].text;
  assert.match(text, /静默阈值/);
  assert.match(text, /原文：assets\/mem-raw/);
  assert.equal(r.result.isError, undefined);
});

test("调用：缺 query 直接说缺，不打到检索层", async () => {
  const calls = [];
  const r = await handleMessage(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_search", arguments: {} } },
    { search: stub(calls) }
  );
  assert.equal(r.result.isError, true);
  assert.equal(calls.length, 0);
});

test("调用：检索抛错变成 isError 的工具结果，不是协议错误", async () => {
  const r = await handleMessage(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "memory_search", arguments: { query: "x" } } },
    {
      search: async () => {
        throw new Error("连不上中心：超时");
      },
    }
  );
  // 协议层没错：模型看到原因还能换个词重试。
  assert.equal(r.error, undefined);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /连不上中心/);
});

test("不认识的方法回 -32601，不是 500 也不是静默", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 6, method: "resources/list" });
  assert.equal(r.error.code, -32601);
  const t = await handleMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope" } });
  assert.equal(t.error.code, -32602);
});

test("空结果也要说人话，不能回一段空字符串", async () => {
  const r = await handleMessage(
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "memory_search", arguments: { query: "没有的东西" } } },
    { search: stub([], { terms: ["没有的东西"], hits: [] }) }
  );
  assert.match(r.result.content[0].text, /没找到相关记忆/);
});

test("stdio：一行一条消息，按序回，多余输出会毁掉整条通道", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = "";
  output.on("data", (c) => (raw += c.toString("utf8")));
  startMcp({ search: stub(), input, output, log: () => {} });

  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  input.write("这不是 JSON\n");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_search", arguments: { query: "静默" } } })}\n`);
  input.end();
  await new Promise((r) => setTimeout(r, 120));

  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 4, `应该只有 4 条响应（通知不回），实际 ${lines.length} 条：${raw.slice(0, 200)}`);
  const msgs = lines.map((l) => JSON.parse(l)); // 解析不了就说明混进了非协议输出
  assert.deepEqual(msgs.map((m) => m.id), [1, 2, null, 3]);
  assert.equal(msgs[2].error.code, -32700);
  assert.match(msgs[3].result.content[0].text, /静默阈值/);
});

test("格式：长正文截断，摘要和正文相同时不重复两遍", () => {
  const long = "长".repeat(500);
  const s = formatHits([{ entity: "e", date: "2026-11-01", brief: "摘要", text: long }]);
  assert.ok(s.includes(`${"长".repeat(400)}…`));
  assert.ok(!s.includes(long));
  const same = formatHits([{ entity: "e", brief: "同一句", text: "同一句" }]);
  assert.equal(same.split("同一句").length - 1, 1);
});

test("检索层报 failed：回 isError，不能说「没找到」", async () => {
  // 后端返回异常时 hits 是空的。要是走正常的 formatHits，模型会得到
  // 「没找到相关记忆」，然后当成「库里没记过」去回答用户——这是比报错更糟的错。
  const r = await handleMessage(
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "memory_search", arguments: { query: "部署计划" } } },
    { search: async () => ({ hits: [], terms: ["部署", "计划"], failed: true, reason: "sql-not-array" }) }
  );
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /检索失败/);
  assert.match(r.result.content[0].text, /不代表没记过/);
  assert.doesNotMatch(r.result.content[0].text, /没找到/);
});

test("没问出词：明说「换个说法」，别让人继续换近义词", async () => {
  const r = await handleMessage(
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "memory_search", arguments: { query: "怎么样" } } },
    { search: async () => ({ hits: [], terms: ["怎么", "么样"], reason: "no-meaningful-terms" }) }
  );
  const text = r.result.content[0].text;
  assert.match(text, /没有能定位的词/);
  assert.match(text, /换个具体的说法/);
});
