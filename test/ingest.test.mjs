/**
 * 接收端的边界：鉴权、限大小、幂等、拒收不完整的包。
 *
 * 全部在临时 HOME 里跑：碰真实队列一次就够恶心了（历史上误写进正式库 33 条）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "mem-ingest-"));
process.env.HOME = HOME;

const { startIngest } = await import("../src/center/ingest.mjs");
const { ingestKey, pending } = await import("../src/center/inbox.mjs");
const { splitTurns } = await import("../src/worker/push.mjs");
const { INBOX_DIR } = await import("../src/shared/config.mjs");

const TOKEN = "test-token-0123456789abcdef";

/** 每个用例一个随机端口；t.after 保证关掉——不关的话 node 进程会一直挂着。 */
async function boot(t, extra = {}) {
  const s = startIngest({ port: 0, bind: "127.0.0.1", token: TOKEN, log: () => {}, ...extra });
  t.after(() => s.close());
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${s.url}/api/ping`, { headers: { authorization: `Bearer ${TOKEN}` } });
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

// ---- /api/search：边缘机器上的召回走这里 ----

const fakeHits = [
  { id: "b1", entity: "静默阈值", brief: "三条改三条", date: "2026-11-02", type: "decision", text: "静默阈值从 3 分钟改成 30 分钟。", raw: "assets/mem-raw/Mac/x.jsonl#3-9" },
];

function fakeSearch(calls) {
  return async (opts) => {
    calls.push(opts);
    return { terms: ["静默"], hits: fakeHits };
  };
}

test("检索要 token：没带或带错都 401", async (t) => {
  const s = await boot(t, { search: fakeSearch([]) });
  const noAuth = await fetch(`${s.url}/api/search?q=静默`);
  assert.equal(noAuth.status, 401);
  const wrong = await fetch(`${s.url}/api/search?q=静默`, { headers: { authorization: "Bearer nope" } });
  assert.equal(wrong.status, 401);
});

test("检索：GET 和 POST 都能用，返回条目和检索词", async (t) => {
  const calls = [];
  const s = await boot(t, { search: fakeSearch(calls) });

  const g = await (await fetch(`${s.url}/api/search?q=${encodeURIComponent("静默 阈值")}&limit=3`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })).json();
  assert.equal(g.ok, true);
  assert.equal(g.count, 1);
  assert.equal(g.hits[0].entity, "静默阈值");
  assert.deepEqual(g.terms, ["静默"]);

  const p = await (await fetch(`${s.url}/api/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ q: "静默", topic: "silent", project: "siyuan-mem", days: 7, all: true }),
  })).json();
  assert.equal(p.ok, true);
  assert.equal(calls.length, 2);
  // all=1 要翻成 status=""——传 undefined 的话服务端会退回 current，等于没生效。
  assert.equal(calls[1].status, "");
  assert.equal(calls[1].topic, "silent");
  assert.equal(calls[1].project, "siyuan-mem");
  assert.equal(calls[1].days, 7);
});

test("检索：缺 q 是 400，检索本身出错是 500 且带原因", async (t) => {
  const s = await boot(t, { search: fakeSearch([]) });
  const empty = await fetch(`${s.url}/api/search?q=%20`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(empty.status, 400);

  const s2 = await boot(t, {
    search: async () => {
      throw new Error("找不到笔记本「记忆」");
    },
  });
  const r = await fetch(`${s2.url}/api/search?q=x`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 500);
  const body = await r.json();
  // 原因要透出来：边缘那边只有「查不到」的话，跟「真的没记过」分不开。
  assert.match(body.error, /找不到笔记本/);
});

test("status 非法值被拒：它是拼进 SQL 的，转义挡不住", async (t) => {
  const calls = [];
  const s = await boot(t, { search: fakeSearch(calls) });
  const r = await fetch(`${s.url}/api/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    // 原样拼进去的话，`--` 会注释掉后面所有条件，绕过 box/type/hash 收口读全库。
    body: JSON.stringify({ q: "x", status: "x' OR 1=1 -- " }),
  });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0, "非法 status 不能到达检索层");
});

test("占位符或过短的 token 直接拒绝启动", () => {
  // 配置模板里那句中文说明文字非空，被当成真 token 就等于"全世界都知道的密码"。
  assert.throws(() => startIngest({ port: 0, bind: "0.0.0.0", token: "自己生成一个长串，边缘机器要用同一个" }), /非 ASCII/);
  assert.throws(() => startIngest({ port: 0, bind: "0.0.0.0", token: "root1234" }), /至少 16 位/);
});

test("没有 token 一律拒绝启动——包括绑回环", () => {
  // 试过两轮"靠来源/代理头/Host 判断是不是本机直连"，都不成立：
  // nginx 裸 proxy_pass 默认不加 X-Forwarded-For，还会把 Host 改成上游地址。
  // 所以直接砍掉这条口子，只要求配 token。
  assert.throws(() => startIngest({ port: 0, bind: "127.0.0.1", token: "" }), /必须有 token/);
  assert.throws(() => startIngest({ port: 0, bind: "0.0.0.0", token: "" }), /必须有 token/);
});

test("ping 也要 token，别当公开探针", async (t) => {
  const s = await boot(t, { search: fakeSearch([]) });
  assert.equal((await fetch(`${s.url}/api/ping`)).status, 401);
  const ok = await fetch(`${s.url}/api/ping`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200);
});
