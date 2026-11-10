/**
 * 一次逻辑调用要有总预算，不只是"每次尝试"的超时。
 *
 * 2026-11-10 那轮里出现过单次 converge 688 秒。算一下就明白：timeoutMs=180s，
 * retries=3，端点挂住时是 180 × 4 次尝试 + 退避等待 = 十二分钟。会话闸门拦不住它，
 * 因为闸门只能在两次调用之间看表，而它一次调用就跨了半个预算。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "mem-llm-budget-"));

const { chat } = await import("../src/util/llm.mjs");

/** 一个永远慢半拍的端点：每次请求都要 delay 才回，用来把超时造出来。 */
async function withSlowServer(delayMs, fn) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    req.resume();
    // 不回包，只等：模拟"端点挂住"。连接被客户端 abort 时这里会安静结束。
    setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }, delayMs);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = {
    model: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "test",
      name: "fake",
      wire: "openai",
      provider: "openai",
      timeoutMs: 120,
      retries: 3,
      jsonMode: false,
    },
  };
  try {
    return await fn({ cfg, hits: () => hits });
  } finally {
    server.close();
  }
}

test("有总预算时：到点就放弃，不把超时乘上重试次数", async () => {
  await withSlowServer(2000, async ({ cfg, hits }) => {
    const t0 = Date.now();
    await assert.rejects(() => chat(cfg, { messages: [{ role: "user", content: "hi" }], deadline: Date.now() + 400 }), /./);
    const ms = Date.now() - t0;
    // 断言看次数而不是看毫秒：机器忙的时候毫秒会飘，但"打了几次"是确定的。
    // 没有这道预算的话是 4 次尝试 + 800/1600/3200 退避，实测 6 秒。
    assert.ok(hits() <= 2, `不该重试到第四次，实际打了 ${hits()} 次`);
    assert.ok(ms < 4500, `应在预算附近放弃，实际耗了 ${ms}ms`);
  });
});

test("没有总预算时行为不变：仍然按 retries 重试", async () => {
  await withSlowServer(2000, async ({ cfg, hits }) => {
    const t0 = Date.now();
    await assert.rejects(() => chat(cfg, { messages: [{ role: "user", content: "hi" }] }), /./);
    const ms = Date.now() - t0;
    assert.ok(hits() >= 2, `应该重试，实际只打了 ${hits()} 次`);
    assert.ok(ms > 600, `默认路径要真的重试（含退避），实际 ${ms}ms`);
  });
});
