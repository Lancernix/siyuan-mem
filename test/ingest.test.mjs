/**
 * 接收端的边界：鉴权、限大小、幂等、拒收不完整的包。
 *
 * 全部在临时 HOME 里跑：碰真实队列一次就够恶心了（历史上误写进正式库 33 条）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "mem-ingest-"));
process.env.HOME = HOME;

const { startIngest } = await import("../src/ingest.mjs");
const { ingestKey, pending } = await import("../src/inbox.mjs");
const { splitTurns } = await import("../src/push.mjs");
const { INBOX_DIR } = await import("../src/config.mjs");

const TOKEN = "test-token-123";

/** 每个用例一个随机端口；t.after 保证关掉——不关的话 node 进程会一直挂着。 */
async function boot(t, extra = {}) {
  const s = startIngest({ port: 0, bind: "127.0.0.1", token: TOKEN, log: () => {}, ...extra });
  t.after(() => s.close());
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${s.url}/api/ping`);
      return s;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error("接收端没起来");
}

const sample = (sid = "s-1") => ({
  machine: "mac",
  harness: "workbuddy",
  session_id: sid,
  cwd: "/tmp/x",
  date: "2026-10-29",
  turns: [
    { role: "user", text: "风盾500 和 500pro 是同一款吗" },
    { role: "assistant", text: "是同一款，只是文案差异。" },
  ],
});

function post(s, body, token = TOKEN) {
  return fetch(`${s.url}/api/ingest`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("没 token 或 token 不对都拒绝", async (t) => {
  const s = await boot(t);
  assert.equal((await post(s, sample("auth-1"), "")).status, 401);
  assert.equal((await post(s, sample("auth-1"), "wrong")).status, 401);
});

test("推一包会落进队列，字段被清洗过", async (t) => {
  const s = await boot(t);
  const r = await post(s, {
    ...sample("clean-1"),
    turns: [...sample().turns, { role: "system", text: "不该收" }, { role: "user", text: "   " }],
    evil: "x",
  });
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.accepted, 2);

  const files = readdirSync(INBOX_DIR);
  const stored = files
    .map((f) => JSON.parse(readFileSync(join(INBOX_DIR, f), "utf8")))
    .find((p) => p.session_id === "clean-1");
  assert.ok(stored, "队列里应该有这一条");
  assert.equal(stored.machine, "mac");
  assert.equal(stored.turns.length, 2);
  assert.equal(stored.evil, undefined, "外部字段不该被透传");
});

test("同一包重复推不会堆副本", async (t) => {
  const s = await boot(t);
  const before = pending().length;
  const a = await (await post(s, sample("dup-1"))).json();
  const b = await (await post(s, sample("dup-1"))).json();
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(pending().length, before + 1);
});

test("缺 machine 的包被拒", async (t) => {
  const s = await boot(t);
  assert.equal((await post(s, { ...sample("nomac"), machine: "" })).status, 400);
});

test("超过上限的包返回 413", async (t) => {
  const s = await boot(t, { maxBytes: 512 });
  const r = await post(s, { ...sample("big-1"), turns: [{ role: "user", text: "x".repeat(4096) }] });
  assert.equal(r.status, 413);
});

test("非回环地址 + 空 token 直接拒绝启动", () => {
  assert.throws(() => startIngest({ port: 0, bind: "0.0.0.0", token: "" }), /拒绝启动/);
});

test("幂等键只看内容，不看时间", () => {
  const a = ingestKey(sample());
  const b = ingestKey({ ...sample(), date: "2020-01-01" });
  const c = ingestKey({ ...sample(), turns: [{ role: "user", text: "别的" }] });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("按字符切块，单条超大不切开", () => {
  const turns = [
    { role: "user", text: "a".repeat(600) },
    { role: "assistant", text: "b".repeat(600) },
    { role: "user", text: "c".repeat(1500) },
  ];
  const chunks = splitTurns(turns, 1000);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[2][0].text.length, 1500);
  assert.equal(chunks.flat().length, 3, "切块不能丢轮次");
});
