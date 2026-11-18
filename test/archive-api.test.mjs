/**
 * 中心的归档接口 + 边缘客户端。
 *
 * 归档是边缘唯一的写通道，所以边界和 /api/ingest 一样：必须 POST、必须带 token、
 * 参数缺了要 400 而不是「归档 0 条算成功」。另外它必须能把「后端挂了」和「这些
 * 条目不存在」分开——前者 5xx，后者 200 带 ok:false。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "mem-archive-api-"));
process.env.HOME = HOME;

const { startIngest } = await import("../src/core/ingest.mjs");
const { CONFIG_PATH } = await import("../src/util/config.mjs");
const { remoteArchive } = await import("../src/util/remote.mjs");

const TOKEN = "test-token-0123456789abcdef";

async function boot(t, impl) {
  const calls = [];
  const s = startIngest({
    port: 0,
    bind: "127.0.0.1",
    token: TOKEN,
    log: () => {},
    archive: async (o) => (calls.push(o), impl(o)),
  });
  t.after(() => s.close());
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${s.url}/api/ping`, { headers: { authorization: `Bearer ${TOKEN}` } });
      return { s, calls };
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

test("归档接口要 token，且只收 POST", async (t) => {
  const { s } = await boot(t, async () => ({ ok: true, mode: "archive", count: 1, items: [] }));
  assert.equal((await post(s, "/api/archive", { topic: "x" }, "")).status, 401);
  assert.equal((await post(s, "/api/archive", { topic: "x" }, "wrong")).status, 401);
  const get = await fetch(`${s.url}/api/archive`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(get.status, 405);
});

test("没有范围：400，不能变成「归档了 0 条」", async (t) => {
  const { s, calls } = await boot(t, async () => ({ ok: true, mode: "archive", count: 0, items: [] }));
  const r = await post(s, "/api/archive", {});
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0, "不该调到实现");
});

test("参数翻译：ids / topic / session / reason / confirm / undo / list 都到位", async (t) => {
  const { s, calls } = await boot(t, async () => ({ ok: true, mode: "archive", count: 2, items: [] }));
  await post(s, "/api/archive", {
    ids: ["abc1234"],
    topic: "小账本",
    session: "sess-1",
    reason: "试用",
    confirm: true,
    undo: true,
    source: "mcp",
  });
  assert.deepEqual(calls[0].ids, ["abc1234"]);
  assert.equal(calls[0].topic, "小账本");
  assert.equal(calls[0].session, "sess-1");
  assert.equal(calls[0].reason, "试用");
  assert.equal(calls[0].confirm, true);
  assert.equal(calls[0].undo, true);
  // 来源不能被中心覆盖成 api：MCP 的调用要计入 mcp 那一栏。
  assert.equal(calls[0].source, "mcp");

  await post(s, "/api/archive", { list: true });
  assert.equal(calls[1].list, true, "list 单独也能走");
});

test("后端挂了回 503 带原因：边缘要能说「归档没成功」而不是「条目不存在」", async (t) => {
  const { s } = await boot(t, async () => ({ failed: true, reason: "backend-error", detail: "连不上思源" }));
  const r = await post(s, "/api/archive", { topic: "x" });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.match(j.error, /归档失败/);
});

test("预览是 200：它不是错误，只是还没动手", async (t) => {
  const { s } = await boot(t, async () => ({
    ok: true,
    mode: "preview",
    count: 12,
    needsConfirm: true,
    items: [],
    note: "先没动",
  }));
  const r = await post(s, "/api/archive", { topic: "小账本" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.mode, "preview");
  assert.equal(j.needsConfirm, true);
});

test("边缘客户端：remoteArchive 带超时和来源，错误信息说「归档」不是「检索」", async (t) => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ push: { to: "", token: "" } }, null, 2));
  const { s } = await boot(t, async () => ({ ok: true, mode: "archive", count: 1, items: [] }));
  const r = await remoteArchive({ ids: ["abc1234"], source: "mcp", to: s.url, token: TOKEN });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "archive");

  await assert.rejects(
    () => remoteArchive({ topic: "x", to: s.url, token: "wrong" }),
    /中心拒绝了归档（HTTP 401）/
  );
});
