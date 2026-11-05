/**
 * MCP 这层的边界：握手、工具清单、调用、错误、以及「stdout 里只有协议」。
 *
 * 这些都不依赖思源和模型——检索是注入的。验的是协议壳，不是 SQL。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

const { handleMessage, startMcp, formatHits, TOOL } = await import("../src/mcp.mjs");

const hits = [
  {
    id: "b1",
    entity: "静默阈值",
    brief: "从 3 分钟改成 30 分钟",
    date: "2026-11-02",
    type: "decision",
    text: "静默阈值从 3 分钟改成 30 分钟，目的是别推还在写的会话。",
    raw: "assets/mem-raw/Mac/x.jsonl#3-9",
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

test("通知不回：回了客户端会当成孤儿响应", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(r, null);
});

test("工具清单只有 memory_search，query 是必填", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(r.result.tools.length, 1);
  assert.equal(r.result.tools[0].name, TOOL.name);
  assert.deepEqual(r.result.tools[0].inputSchema.required, ["query"]);
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
