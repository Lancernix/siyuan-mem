/**
 * 推送一轮：从本地日志切出增量、发给中心。
 *
 * 这条链上出过一个静默得很深的 bug：切片改成 slicePlan 之后，后面算起始轮次
 * 还在用已删除的变量 `fresh`。结果不是报错退出，是每一个会话都「推失败」，
 * 而摘要只在最后一行说「推送 0 个」——看日志的人会以为是没新会话。
 * 所以这里真的启动一个假中心，断言它收到了什么。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "mem-push-"));
process.env.HOME = HOME;

const dir = join(HOME, ".workbuddy/projects/demo");
mkdirSync(dir, { recursive: true });
const file = join(dir, "s1.jsonl");
const line = (role, text, ts) =>
  JSON.stringify({ type: "message", sessionId: "s1", role, timestamp: ts, content: [{ type: role === "user" ? "input_text" : "output_text", text }] });
writeFileSync(
  file,
  [
    line("user", "中心节点那台机器上，思源的 API token 要怎么配？", 1),
    line("assistant", "用 conf.json 里的 api.token，别用访问授权码，那个只用于登录。", 2),
  ].join("\n") + "\n"
);

const { pushOnce } = await import("../src/push.mjs");
const { listSessions } = await import("../src/harness.mjs");

function fakeCenter() {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, duplicate: false, accepted: 1, queue: 1 }));
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, got, to: `http://127.0.0.1:${srv.address().port}` })));
}

test("一轮推送：把 0 起的 range 和两条轮次发出去，不报 fresh 之类的东西", async (t) => {
  const { srv, got, to } = await fakeCenter();
  t.after(() => srv.close());

  const r = await pushOnce({ to, token: "", sessions: listSessions(), quietSeconds: 0, limit: 5 });
  assert.equal(r.failed, 0, "不该有失败");
  assert.equal(r.sessions, 1, "应该推了一个会话");

  const post = got.find((g) => g.url === "/api/ingest");
  assert.ok(post, "必须真的发到 /api/ingest");
  assert.deepEqual(post.body.range, [0, 2], "range 用 0-based 起点，两条轮次就是 [0,2]");
  assert.equal(post.body.turns.length, 2);
  assert.equal(post.body.harness, "workbuddy");
  assert.equal(post.body.machine.length > 0, true, "必须带机器名，中心靠它分来源");
});

test("已经推过的会话不再重复推（偏移生效）", async (t) => {
  const { srv, got, to } = await fakeCenter();
  t.after(() => srv.close());

  await pushOnce({ to, token: "", sessions: listSessions(), quietSeconds: 0, limit: 5 });
  const n = got.filter((g) => g.url === "/api/ingest").length;
  const r2 = await pushOnce({ to, token: "", sessions: listSessions(), quietSeconds: 0, limit: 5 });
  assert.equal(got.filter((g) => g.url === "/api/ingest").length, n, "第二轮不该再发");
  assert.equal(r2.sessions, 0);
});

test("from-scratch：忽略已有偏移，整份重推", async (t) => {
  const { srv, got, to } = await fakeCenter();
  t.after(() => srv.close());

  await pushOnce({ to, token: "", sessions: listSessions(), quietSeconds: 0, limit: 5 });
  const r = await pushOnce({ to, token: "", sessions: listSessions(), quietSeconds: 0, limit: 5, fromScratch: true });
  assert.equal(r.sessions, 1, "换中心时要重推");
  assert.deepEqual(got.at(-1).body.range, [0, 2], "起点回到 0");
});
