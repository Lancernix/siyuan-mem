/**
 * MCP 的 memory_archive：分发、参数翻译、四种结局的文案。
 *
 * 这里最要紧的不是「调通了」，是每一种结局都必须是不同的句子：
 * 预览要说怎么确认，成功要说怎么撤销，没对上要说为什么，后端挂了要说「失败」——
 * 全渲染成「没找到」的话，模型会转头告诉用户「确实没记过」。
 */
import test from "node:test";
import assert from "node:assert/strict";

const { handleMessage, formatArchive, formatHits } = await import("../src/mcp/server.mjs");

const call = (args, io) =>
  handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_archive", arguments: args } },
    io
  );
const textOf = (r) => r.result?.content?.[0]?.text ?? "";

const item = { id: "20261118160331-abc1234", ref: "abc1234", entity: "小账本", date: "2026-11-01", brief: "试用记账" };

test("什么范围都没给：直接拒绝，绝不落到全库归档", async () => {
  let called = 0;
  const r = await call({}, { archive: async () => (called++, { ok: true, count: 0, items: [] }) });
  assert.equal(called, 0);
  assert.equal(r.result.isError, true);
  assert.match(textOf(r), /ids/);
});

test("ids 原样传下去、source 记成 mcp、confirm 缺省是 false", async () => {
  const calls = [];
  const io = { archive: async (o) => (calls.push(o), { ok: true, mode: "archive", count: 1, items: [item] }) };
  await call({ ids: ["abc1234"], reason: "试用" }, io);
  assert.deepEqual(calls[0].ids, ["abc1234"]);
  assert.equal(calls[0].reason, "试用");
  assert.equal(calls[0].confirm, false);
  assert.equal(calls[0].source, "mcp");
  assert.equal(calls[0].undo, false);
});

test("整话题超过 10 条：渲染成「没有动」，并说清怎么确认", async () => {
  const r = await call(
    { topic: "小账本" },
    {
      archive: async () => ({
        ok: true,
        mode: "preview",
        scope: "topic",
        count: 12,
        needsConfirm: true,
        items: [item],
        note: "话题「小账本」下 12 条，超过 10 条，先没动。",
      }),
    }
  );
  const t = textOf(r);
  assert.match(t, /没有动/);
  assert.match(t, /confirm=true/);
  assert.match(t, /#abc1234/);
});

test("归档成功：说清条数、可撤销，还带短引用", async () => {
  const r = await call(
    { ids: ["abc1234"], reason: "当时只是试试" },
    {
      archive: async () => ({
        ok: true,
        mode: "archive",
        scope: "ids",
        reason: "当时只是试试",
        count: 1,
        items: [item],
      }),
    }
  );
  const t = textOf(r);
  assert.match(t, /已归档 1 条/);
  assert.match(t, /当时只是试试/);
  assert.match(t, /undo=true/);
  assert.match(t, /#abc1234/);
});

test("撤销：说清恢复了几条", async () => {
  const r = await call({ undo: true, ids: ["abc1234"] }, { archive: async () => ({ ok: true, mode: "undo", count: 1, items: [item] }) });
  assert.match(textOf(r), /已撤销归档 1 条/);
});

test("列归档：没有就说没有，有就给短引用和原因", async () => {
  const empty = await call({ list: true }, { archive: async () => ({ ok: true, mode: "list", count: 0, items: [] }) });
  assert.match(textOf(empty), /还没有归档/);

  const some = await call({ list: true }, {
    archive: async () => ({ ok: true, mode: "list", count: 1, items: [{ ...item, reason: "噪音" }] }),
  });
  assert.match(textOf(some), /#abc1234/);
  assert.match(textOf(some), /噪音/);
});

test("没对上条目：给的是「为什么没对上」，不是「失败」", async () => {
  const r = await call({ topic: "不存在的" }, {
    archive: async () => ({ ok: false, mode: "archive", count: 0, items: [], note: "话题「不存在的」下没有可归档的条目（current 状态）。" }),
  });
  assert.equal(r.result.isError, undefined);
  assert.match(textOf(r), /没有可归档的条目/);
});

test("后端挂了：必须说「归档失败」，不能伪装成没有条目", async () => {
  const r = await call({ topic: "小账本" }, {
    archive: async () => ({ failed: true, reason: "backend-error", detail: "连不上思源" }),
  });
  assert.equal(r.result.isError, true);
  assert.match(textOf(r), /归档失败/);
  assert.match(textOf(r), /不代表条目不存在/);
});

test("命中行末尾带短引用：没有它，模型没法点名「就这一条」", () => {
  const text = formatHits([{ ...item, text: "小账本 的结论", raw: "" }]);
  assert.match(text, /#abc1234/);
});

test("渲染函数对空结果也不抛", () => {
  assert.equal(typeof formatArchive(null), "string");
  assert.equal(typeof formatArchive(undefined), "string");
});
