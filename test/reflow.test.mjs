/**
 * 回流计数：这场会话自己读过记忆库吗。
 *
 * 只统计，不拦截。但它必须是「硬证据」而不是猜：采集层本来就把工具结果整块丢掉，
 * 所以原文不会原样回流；能说明来源的只剩「调用过我们自己的 MCP 工具」这一件事。
 * 三个环节任一断掉，这个数就会永远是 0，而 0 看起来和「没人用」一模一样——
 * 所以从采集、推送到入库，每一段都验一遍。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "mem-reflow-"));
process.env.HOME = HOME;

const { walkMessages } = await import("../src/util/readers/base.mjs");
const { startIngest } = await import("../src/core/ingest.mjs");
const { pending, readSession } = await import("../src/core/inbox.mjs");
const { derivedHealthToday } = await import("../src/core/selfcheck.mjs");
const { event } = await import("../src/util/log.mjs");

const TOKEN = "reflow-token-0123456789";
const say = (role, blocks) => ({ message: { role, content: blocks } });

test("采集：调过 memory_* 就计数，别的工具不算", () => {
  const lines = [
    say("user", [{ type: "text", text: "翻一下 mem 里关于端口的记录" }]),
    say("assistant", [
      { type: "tool_use", id: "t1", name: "mcp__siyuan-mem__memory_search" },
      { type: "tool_use", id: "t2", name: "memory_entries" },
      { type: "tool_use", id: "t3", name: "Bash" },
      { type: "tool_use", id: "t4", name: "Read" },
      { type: "text", text: "查到三条。" },
    ]),
  ];
  const r = walkMessages(lines);
  assert.equal(r.memTools, 2);
  // 工具结果/调用本身不进语料：能回流的只有它自己写的那段话。
  assert.equal(r.turns.length, 2);
});

test("采集：普通会话是 0，不能把 0 当成「没装」", () => {
  const r = walkMessages([
    say("user", [{ type: "text", text: "帮我看看这个报错" }]),
    say("assistant", [{ type: "text", text: "是端口占用。" }]),
  ]);
  assert.equal(r.memTools, 0);
  assert.equal(r.turns.length, 2);
});

test("子代理文件整份不读，计数也归零", () => {
  const hooks = { isSubagentFile: () => true, sessionIdOf: () => "sub" };
  const r = walkMessages([say("assistant", [{ type: "text", text: "x" }])], hooks);
  assert.equal(r.memTools, 0);
  assert.equal(r.skipped, "subagent");
});

test("推送：mem_tools 跟着 payload 进队列，缺省是 0", async (t) => {
  const s = startIngest({ port: 0, bind: "127.0.0.1", token: TOKEN, log: () => {} });
  t.after(() => s.close());
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${s.url}/api/ping`, { headers: { authorization: `Bearer ${TOKEN}` } });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const post = (body) =>
    fetch(`${s.url}/api/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const turns = [{ role: "user", text: "翻一下 mem" }, { role: "assistant", text: "查到三条。" }];

  const before = pending().length;
  assert.equal((await post({ machine: "m1", session_id: "s-derived", harness: "dsh", date: "2026-11-18", range: [0, 2], mem_tools: 3, turns })).status, 200);
  assert.equal((await post({ machine: "m1", session_id: "s-plain", harness: "dsh", date: "2026-11-18", range: [0, 2], turns })).status, 200);

  const files = pending().slice(before);
  const bySession = Object.fromEntries(files.map((f) => { const p = readSession(f); return [p.session_id, p]; }));
  assert.equal(bySession["s-derived"].memTools, 3);
  // 老版本边缘不会推这个字段：不能变成 NaN 或者丢掉整包。
  assert.equal(bySession["s-plain"].memTools, 0);
  assert.equal(bySession["s-plain"].turns.length, 2);
});

test("统计：今天几场会话读过库、一共调了几次", () => {
  event("session.begin", { session: "a", memTools: 0 });
  event("session.begin", { session: "b", memTools: 4 });
  event("session.begin", { session: "c", memTools: 1 });
  event("memory.hit", { q: "x", n: 1, source: "mcp" });
  const d = derivedHealthToday();
  assert.deepEqual(d, { sessions: 3, reading: 2, calls: 5 });
});

test("统计：没有日志时也要返回零值，不能抛", () => {
  const d = derivedHealthToday("2000-01-01");
  assert.deepEqual(d, { sessions: 0, reading: 0, calls: 0 });
});
