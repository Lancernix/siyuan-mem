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

const { checkDedupe, dedupeHealthToday, recallHealthToday, browseHealthToday } = await import("../src/core/selfcheck.mjs");
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

test("召回健康度按来源分开：agent 在用还是人在调试，不能混成一个数", () => {
  // 2026-11-11 查全部日志，58 次命中里大半是排查时手敲的 CLI 命令。
  // 不区分来源，「这套东西到底有没有被用起来」永远答不了。
  const day = "2099-01-05";
  const dir = join(process.env.HOME, ".siyuan-mem", "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${day}.jsonl`),
    [
      { ev: "memory.hit", source: "mcp", n: 2 },
      { ev: "memory.hit", source: "cli", n: 1 },
      { ev: "memory.miss", source: "mcp", q: "不存在的东西", reason: "no-match" },
      { ev: "memory.miss", source: "api", q: "别的机器查的", reason: "no-match" },
      // 旧的日志没有 reason：它们都是真查过且没命中的，归 miss。
      { ev: "memory.miss", source: "api", q: "旧格式" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n"
  );
  const h = recallHealthToday(day);
  assert.equal(h.hit, 2);
  assert.equal(h.miss, 3);
  assert.equal(h.failed, 0);
  assert.equal(h.trivial, 0);
  assert.deepEqual(h.bySource.mcp, { hit: 1, miss: 1, failed: 0, trivial: 0 });
  assert.deepEqual(h.bySource.cli, { hit: 1, miss: 0, failed: 0, trivial: 0 });
  assert.deepEqual(h.bySource.api, { hit: 0, miss: 2, failed: 0, trivial: 0 });
});

test("后端故障和「没问出词」不算空手：这个指标只该反映召回准不准", () => {
  // 混进去的话，思源抖一次「空手率」就涨一次，人就会去调一个没坏的算法。
  const day = "2099-01-06";
  const dir = join(process.env.HOME, ".siyuan-mem", "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${day}.jsonl`),
    [
      { ev: "memory.miss", source: "mcp", q: "部署计划", reason: "sql-not-array" },
      { ev: "memory.miss", source: "cli", q: "部署计划", reason: "backend-error" },
      { ev: "memory.miss", source: "cli", q: "怎么样", reason: "no-meaningful-terms" },
      { ev: "memory.miss", source: "cli", q: "？？？", reason: "no-terms" },
      { ev: "memory.miss", source: "mcp", q: "真的没有", reason: "no-match" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n"
  );
  const h = recallHealthToday(day);
  assert.equal(h.miss, 1, "只有真查过没有的才算空手");
  assert.equal(h.failed, 2);
  assert.equal(h.trivial, 2);
  assert.deepEqual(h.bySource.mcp, { hit: 0, miss: 1, failed: 1, trivial: 0 });
  assert.deepEqual(h.bySource.cli, { hit: 0, miss: 0, failed: 1, trivial: 2 });
});

test("导航单独计数：不能混进召回的空手率，也要能看出 agent 有没有在用", () => {
  // 列话题/翻条目是「发现命名空间」，不是「召回准不准」。混进 recallHealthToday
  // 会让那个分母被导航灌水；完全不记，又答不了新工具到底有没有被用起来。
  const day = "2099-01-07";
  const dir = join(process.env.HOME, ".siyuan-mem", "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${day}.jsonl`),
    [
      { ev: "memory.browse", kind: "topics", source: "mcp", total: 42, shown: 20 },
      { ev: "memory.browse", kind: "entries", source: "mcp", topic: "通勤骑行", n: 8 },
      { ev: "memory.browse", kind: "topics", source: "api", total: 42, shown: 5 },
      { ev: "memory.browse", kind: "weird", source: "mcp" },
      { ev: "memory.hit", source: "mcp", n: 1 },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n"
  );
  const b = browseHealthToday(day);
  assert.equal(b.topics, 2);
  assert.equal(b.entries, 1);
  assert.deepEqual(b.bySource.mcp, { topics: 1, entries: 1 });
  assert.deepEqual(b.bySource.api, { topics: 1, entries: 0 });
  const r = recallHealthToday(day);
  assert.equal(r.hit, 1);
  assert.equal(r.miss, 0, "导航事件一次都不能算空手");
});
