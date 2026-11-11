/**
 * 判重哨兵：验证「链路通不通」这件事本身是可信的。
 *
 * 这里要验两件事：
 *   1. 链路通的时候，哨兵说通（别误报）；
 *   2. 链路坏的时候，哨兵说坏（别像 2026-11-10 那样静默）。
 *
 * 第 2 条用假模型返 500 来造——真实调用失败和程序错误都要能被抓到。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

process.env.HOME = mkdtempSync(join(tmpdir(), "mem-selfcheck-"));

const { checkDedupe, dedupeHealthToday } = await import("../src/core/selfcheck.mjs");
const { dedupeStats, resetDedupeStats } = await import("../src/core/dedupe.mjs");

function cfgFor(port, over = {}) {
  return {
    model: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "test",
      name: "fake",
      wire: "openai",
      provider: "openai",
      jsonMode: true,
      timeoutMs: 5000,
      retries: 0,
      ...over,
    },
  };
}

/** 假模型：status=200 时回一条 replace 裁决，否则回错误码。 */
async function withModel(status, fn, action = "replace", body = null) {
  let hits = 0;
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      hits++;
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "boom" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(body ?? { decisions: [{ new: 1, match: 1, action }] }) } }],
          usage: { prompt_tokens: 80, completion_tokens: 10 },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn({ cfg: cfgFor(server.address().port), hits: () => hits });
  } finally {
    server.close();
  }
}

test("链路通：哨兵说通，而且真的发出了一次调用", async () => {
  resetDedupeStats();
  await withModel(200, async ({ cfg, hits }) => {
    const r = await checkDedupe(cfg);
    assert.equal(r.ok, true, `不该误报：${r.reason}`);
    assert.equal(hits(), 1, "哨兵必须真打一次模型——它验的是链路，不是常量");
    assert.equal(r.action, "replace");
  });
});

test("调用一进来就失败：哨兵必须报出来，不能当成「没有重复」", async () => {
  resetDedupeStats();
  await withModel(500, async ({ cfg }) => {
    const r = await checkDedupe(cfg);
    assert.equal(r.ok, false, "500 就是不通，不能静默");
    assert.match(r.reason, /失败|错误/);
  });
});

test("计数能把「程序错误」和「模型失败」分开", async () => {
  // 这是这次事故的核心：ReferenceError 被当成「模型这次没成」，混在 dedupe.failed 里。
  // 两条计数分开之后，自检和 mem status 才能把「代码写错了」单独拎出来。
  resetDedupeStats();
  await withModel(200, async ({ cfg }) => {
    await checkDedupe(cfg);
    const s = dedupeStats();
    assert.equal(s.calls, 1, "调了一次");
    assert.equal(s.crashed, 0);
    assert.equal(s.failed, 0);
    assert.equal(s.decisions, 1, "replace 也是一条裁决");
    assert.ok(s.replace >= 1);
  });
});

test("模型判 keep 也算通：哨兵验的是链路，不是判断力", async () => {
  // 判 keep 是完全合法的结果（这对样本确实可以被判成两条不同的事）。
  // 要是把 keep 当成"坏了"，哨兵天天误报，最后没人看它。
  resetDedupeStats();
  await withModel(
    200,
    async ({ cfg }) => {
      const r = await checkDedupe(cfg, { deadlineMs: 5000 });
      assert.equal(r.ok, true, `keep 不该报错：${r.reason}`);
      assert.equal(r.action, "keep");
    },
    "keep",
  );
});

test("今天的账：裁决、失败、崩溃分开数", () => {
  const day = "2099-01-02";
  const dir = join(process.env.HOME, ".siyuan-mem", "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${day}.jsonl`),
    [
      { ev: "dedupe.decision", action: "replace" },
      { ev: "dedupe.decision", action: "covered" },
      { ev: "dedupe.decision", action: "covered" },
      { ev: "dedupe.failed", error: "429 rate limited" },
      { ev: "dedupe.crash", error: "deadline is not defined" },
      { ev: "entry.write", id: "x" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  const h = dedupeHealthToday(day);
  assert.equal(h.decisions, 3);
  assert.equal(h.replace, 1);
  assert.equal(h.covered, 2);
  assert.equal(h.failed, 1);
  assert.equal(h.crashed, 1);
  assert.equal(h.lastError, "deadline is not defined", "最后一条错误留给人看");
});

test("子块失败按 depth 分流：两个视图里的数字要一致", () => {
  // dedupeStats() 里 depth>0 计 leafFailed，事件日志这边也得一样，否则同一次
  // 失败在 status 和日志里是不同数字。
  const day = "2099-01-03";
  const dir = join(process.env.HOME, ".siyuan-mem", "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${day}.jsonl`),
    [
      { ev: "dedupe.failed", depth: 1, error: "timeout" },
      { ev: "dedupe.crash", depth: 2, error: "TypeError" },
      { ev: "dedupe.crash", error: "deadline is not defined" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n"
  );
  const h = dedupeHealthToday(day);
  assert.equal(h.leafFailed, 2, "两个子块失败都算叶子");
  assert.equal(h.crashed, 1, "只有逻辑层的程序错误算崩溃");
  assert.equal(h.failed, 0);
});

test("模型返回空裁决：哨兵必须报错，这就是它要抓的「静默失效」", async () => {
  // {"decisions":[]} 是模型换了个键名、或者没按格式回的典型样子。它不抛错、
  // 不产生裁决，如果只看 failed 计数，哨兵会报「通过」——正是最该抓的那种坏。
  resetDedupeStats();
  await withModel(
    200,
    async ({ cfg }) => {
      const r = await checkDedupe(cfg, { deadlineMs: 5000 });
      assert.equal(r.ok, false, "空裁决就是链路没通，不能报通过");
      assert.match(r.reason, /判重没生效|decisions/);
    },
    "keep",
    { decisions: [] },
  );
});
