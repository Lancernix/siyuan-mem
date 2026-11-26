/**
 * 思源不可用时要快速失败。
 *
 * 内核被 OOM 杀掉或正在重启时，每个调用都要等满超时；写一条条目是「查子块 →
 * 查重 → 写属性」好几个调用，叠起来一分多钟，2026-11-26 有一轮因此拖到 1887 秒。
 * 熔断后冷却期内直接失败，让上层把这批留到下一轮。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "mem-breaker-"));
const { SiYuan } = await import("../src/util/siyuan.mjs");

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test("连续两次超时后熔断，第三次不再等满超时", async () => {
  // 接了连接但永不响应：模拟内核卡死（索引重建 / swap 抖动）。
  const { server, url } = await serve(() => {});
  const sy = new SiYuan({ baseUrl: url, timeoutMs: 200, cooldownMs: 60_000 });
  try {
    // 第一次超时不熔断：一条重查询偶尔超时，后面的写本来可能成功。
    const t0 = Date.now();
    await assert.rejects(sy.version(), /连不上思源|超时/);
    assert.ok(Date.now() - t0 >= 150, "第一次应该等满超时");

    const t1 = Date.now();
    await assert.rejects(sy.version(), /连不上思源|超时/);
    assert.ok(Date.now() - t1 >= 150, "第二次也要真的试一次，不能凭一次超时就放弃");

    const t2 = Date.now();
    await assert.rejects(sy.version(), /熔断/);
    assert.ok(Date.now() - t2 < 60, `第三次应该秒失败，实际 ${Date.now() - t2}ms`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("5xx 触发熔断", async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(503);
    res.end("busy");
  });
  const sy = new SiYuan({ baseUrl: url, timeoutMs: 1000, cooldownMs: 60_000 });
  try {
    await assert.rejects(sy.version(), /HTTP 503/);
    await assert.rejects(sy.version(), /HTTP 503/);
    await assert.rejects(sy.version(), /熔断/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("业务错不熔断：code != 0 是调用方参数写错了，藏起来更难查", async () => {
  let hits = 0;
  const { server, url } = await serve((req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: -1, msg: "参数不对" }));
  });
  const sy = new SiYuan({ baseUrl: url, timeoutMs: 1000, cooldownMs: 60_000 });
  try {
    await assert.rejects(sy.sql("SELECT 1"), /参数不对/);
    const before = hits;
    await assert.rejects(sy.sql("SELECT 1"), /参数不对/);
    assert.equal(hits, before + 1, "第二次仍要真的发请求");
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("成功一次就解除熔断", async () => {
  let down = true;
  const { server, url } = await serve((req, res) => {
    if (down) {
      res.writeHead(503);
      return res.end("busy");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: "ok" }));
  });
  const sy = new SiYuan({ baseUrl: url, timeoutMs: 1000, cooldownMs: 100 });
  try {
    await assert.rejects(sy.version(), /HTTP 503/);
    await assert.rejects(sy.version(), /HTTP 503/);
    await assert.rejects(sy.version(), /熔断/);
    down = false;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await sy.version(), "ok");
    // 解除之后再请求一次，确认不是只放行一次
    assert.equal(await sy.version(), "ok");
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
