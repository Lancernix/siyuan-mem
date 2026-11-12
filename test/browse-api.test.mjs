/**
 * 中心两个导航接口 + 边缘对应的远端客户端。
 *
 * 重点不是「能不能通」，是三条和 /api/search 一致的边界：
 * 鉴权、status 白名单（这个字段会拼进 SQL）、后端故障回 5xx 带原因。
 * 少一条，边缘那边又会把「中心坏了」当成「这个话题没内容」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "mem-browse-api-"));
process.env.HOME = HOME;

const { startIngest } = await import("../src/core/ingest.mjs");
const { CONFIG_PATH } = await import("../src/util/config.mjs");
const { remoteTopics, remoteEntries, remoteSearch } = await import("../src/util/remote.mjs");

const TOKEN = "test-token-0123456789abcdef";

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

const post = (s, path, body, token = TOKEN) =>
  fetch(`${s.url}${path}`, {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("两个导航接口都要 token，和 /api/search 一套鉴权", async (t) => {
  const s = await boot(t, {
    topics: async () => ({ topics: [], total: 0, shown: 0, truncated: false, degraded: false, hint: "", q: "" }),
    entries: async () => ({ hits: [], total: 0, topic: "", canonical: "", hint: "" }),
  });
  for (const path of ["/api/topics", "/api/entries"]) {
    assert.equal((await post(s, path, {}, "")).status, 401, path);
    assert.equal((await post(s, path, {}, "wrong")).status, 401, path);
  }
});

test("参数翻译与来源：q/topic/limit/days/status 都传到实现，source 不被覆盖成 api", async (t) => {
  const calls = [];
  const s = await boot(t, {
    topics: async (o) => (calls.push(["topics", o]), { topics: [], total: 0, shown: 0, truncated: false, degraded: false, hint: "", q: o.q, ok: true }),
    entries: async (o) => (calls.push(["entries", o]), { hits: [], total: 0, topic: o.topic, canonical: "", hint: "", ok: true }),
  });
  const r1 = await post(s, "/api/topics", { q: "骑行", limit: 7, source: "mcp" });
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json().then((d) => d.q), "骑行");
  assert.equal(calls[0][1].q, "骑行");
  assert.equal(calls[0][1].limit, 7);
  assert.equal(calls[0][1].source, "mcp", "边缘 agent 的调用不能被记成中心 api");

  const r2 = await post(s, "/api/entries", { topic: "通勤骑行", limit: 3, days: 30, source: "mcp" });
  assert.equal(r2.status, 200);
  assert.equal(calls[1][1].topic, "通勤骑行");
  assert.equal(calls[1][1].days, 30);
  assert.equal(calls[1][1].source, "mcp");
});

test("P2-2：边缘 MCP 的三个工具来源一致，search 不再被记成 api", async (t) => {
  const seen = [];
  const s = await boot(t, {
    search: async (o) => (seen.push(["search", o.source]), { hits: [], terms: [], count: 0 }),
    topics: async (o) => (seen.push(["topics", o.source]), { topics: [], total: 0, shown: 0, truncated: false, degraded: false, hint: "", q: "" }),
    entries: async (o) => (seen.push(["entries", o.source]), { hits: [], total: 0, topic: o.topic, canonical: "", hint: "" }),
  });
  // 直接打中心，模拟边缘带 source 的三个请求
  for (const [path, body] of [
    ["/api/search", { q: "x", source: "mcp" }],
    ["/api/topics", { source: "mcp" }],
    ["/api/entries", { topic: "x", source: "mcp" }],
  ]) {
    const r = await post(s, path, body);
    assert.equal(r.status, 200, path);
  }
  assert.deepEqual(seen.map((x) => x[1]), ["mcp", "mcp", "mcp"], "同一串调用不能拆成两种来源");
});

test("P2-2：外部伪造的 source 并到 fallback，不新造 bySource 桶", async (t) => {
  const seen = [];
  const s = await boot(t, {
    search: async (o) => (seen.push(o.source), { hits: [], terms: [], count: 0 }),
  });
  await post(s, "/api/search", { q: "x", source: "forged-" + "x".repeat(200) });
  assert.equal(seen[0], "api", "不认识的来源并到缺省 api");
});

test("缺 topic / status 非法值在中心就拒掉，不打实现", async (t) => {
  let n = 0;
  const s = await boot(t, { entries: async (o) => (n++, { hits: [], total: 0, topic: o.topic, canonical: "", hint: "" }) });
  const missing = await post(s, "/api/entries", {});
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /缺 topic/);
  for (const path of ["/api/topics", "/api/entries"]) {
    const bad = await post(s, path, { topic: "x", status: "x' OR 1=1 --" });
    assert.equal(bad.status, 400, path);
  }
  assert.equal(n, 0);
});

test("后端故障回 503 带原因，不是 200 + 空结果", async (t) => {
  const s = await boot(t, {
    topics: async () => ({ failed: true, reason: "sql-not-array" }),
    entries: async () => ({ failed: true, reason: "backend-error", detail: "database is locked" }),
  });
  const r1 = await post(s, "/api/topics", {});
  assert.equal(r1.status, 503);
  assert.match((await r1.json()).error, /检索失败/);
  const r2 = await post(s, "/api/entries", { topic: "x" });
  assert.equal(r2.status, 503);
  assert.match((await r2.json()).error, /database is locked/);
});

test("远端客户端打到对应路径，中心报错要抛，不能变成空结果", async (t) => {
  const seen = [];
  const fake = (await import("node:http")).createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/entries" && seen.length === 2) {
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: "检索失败：后端不可用" }));
      }
      res.end(JSON.stringify({ ok: true, topics: [], hits: [] }));
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  t.after(() => fake.close());
  const to = `http://127.0.0.1:${fake.address().port}`;
  const token = "edge-token-abcdefghijkl";

  const a = await remoteTopics({ to, token, q: "骑行", limit: 5 });
  assert.equal(a.ok, true);
  assert.equal(seen[0].path, "/api/topics");
  assert.equal(seen[0].body.q, "骑行");
  assert.equal(seen[0].auth, `Bearer ${token}`);

  await assert.rejects(
    () => remoteEntries({ to, token, topic: "x" }),
    /中心拒绝了检索（HTTP 503）/
  );
  assert.equal(seen[1].path, "/api/entries");
});

test("remoteSearch 重构后行为不变：仍是 /api/search 且透传全部字段", async (t) => {
  const seen = [];
  const fake = (await import("node:http")).createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ path: req.url, body: JSON.parse(raw || "{}") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, hits: [], count: 0, terms: [] }));
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  t.after(() => fake.close());
  const r = await remoteSearch({
    to: `http://127.0.0.1:${fake.address().port}`,
    token: "edge-token-abcdefghijkl",
    q: "部署", topic: "部署沙箱", project: "siyuan-mem", limit: 3, days: 7, status: "",
    source: "mcp",
  });
  assert.equal(seen[0].path, "/api/search");
  assert.equal(seen[0].body.q, "部署");
  assert.equal(seen[0].body.topic, "部署沙箱");
  assert.equal(seen[0].body.status, "");
  assert.equal(seen[0].body.source, "mcp", "P2-2：远端 search 必须透传来源");
  assert.equal(r.remote, `http://127.0.0.1:${fake.address().port}`);
});

test("远端地址没配时三个接口都明确报错，连思源都不碰", async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ siyuan: { baseUrl: "http://127.0.0.1:1", notebook: "Mem" }, push: {} }));
  for (const fn of [remoteTopics, remoteEntries, remoteSearch]) {
    await assert.rejects(() => fn({ q: "x", topic: "x" }), /没配中心地址/);
  }
});
