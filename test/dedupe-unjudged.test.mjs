/**
 * 判重没跑成，就不许写。
 *
 * 2026-11-18 01:44 那轮的实况：11 批抽取跑满 10 分钟预算，接着 7 批判重全部返回
 * 「这次调用的时间预算用完了」——判重跟抽取共用一个死线，抽取把预算吃光，判重
 * 一开口就超时。于是 50 条抽取结果**没判过重就写进了库**：判重失败的那些索引不在
 * decisions 里，写入逻辑按「新条目」处理。
 *
 * 现在两条规矩：
 *   1. 判重有自己的两分钟，不跟抽取共用死线；
 *   2. 只要有一批判重没跑成，这一场一条都不写，原文留队列下轮重抽。
 *      判重失败不是「没重复」，是「没看过」——按新条目写进去就是制造一堆看着都对的重复。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;

function run(code) {
  const home = mkdtempSync(join(tmpdir(), "mem-unjudged-"));
  mkdirSync(join(home, ".siyuan-mem", "inbox"), { recursive: true });
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: ROOT,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return { ...JSON.parse(out.trim()), home };
}

function sessionJson(n, tag) {
  const turns = [];
  for (let i = 0; i < n; i++) {
    turns.push({ role: "user", text: `第 ${i + 1} 个问题：端口映射这一块到底该怎么配` });
    turns.push({ role: "assistant", text: `第 ${i + 1} 个回答：按 ${1000 + i} 改，改完重启容器，否则跑的还是旧配置。` });
  }
  return JSON.stringify({ session_id: tag, harness: "dsh", machine: "Mac", cwd: "/tmp/proj", date: "2026-11-18", turnFrom: 1, turns });
}

test("判重失败：一条都不写，覆盖点不推进，原文留队列", () => {
  const out = run(`
    import { createServer } from "node:http";
    import { writeFileSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR } from "./src/util/config.mjs";

    // 只用来把判重打回去：抽取是注入的，不经过这里。
    let modelCalls = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        modelCalls++;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "BadRequest", message: "judge down" } }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));

    writeFileSync(join(INBOX_DIR, "sess-a.json"), ${JSON.stringify(sessionJson(6, "a"))});

    let writes = 0;
    let supersedes = 0;
    const store = {
      listCurrent: async () => [
        { id: "old-1", entity: "端口映射", brief: "端口映射按 1000 改", text: "端口映射这一块按 1000 改，改完重启容器。", project: "/tmp/proj" },
      ],
      docIds: async () => ({ notebook: "box", months: {}, entries: "e", entities: "n", pending: "p" }),
      ensureGroupAnchor: async () => "",
      supersede: async () => { supersedes++; },
      writeEntry: async () => { writes++; return { id: "new-1" }; },
    };
    const cfg = {
      raw: { enabled: false },
      model: {
        apiKey: "k",
        baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
        name: "judge-dead",
        provider: "openai",
        wire: "openai",
        retries: 0,
        timeoutMs: 2000,
      },
      extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 },
    };
    // 抽取是好的，问题出在判重。entries 跟库里那条几乎一样——正常情况该被判 covered。
    const extract = async () => ({
      entries: [
        { entity: "端口映射", text: "端口映射这一块按 1000 改，改完重启容器，不然还是旧配置", brief: "端口映射按 1000 改", type: "fact", from: 1, to: 2 },
        { entity: "端口映射", text: "端口映射这一块按 1001 改，改完重启容器，否则还是旧配置", brief: "端口映射按 1001 改", type: "fact", from: 3, to: 4 },
      ],
      mode: "model",
      batches: 1,
      usage: { prompt: 0, completion: 0 },
      coveredThrough: null,
    });

    const sum = await processQueue({
      useModel: true,
      deps: { cfg, sy: {}, store, extract },
      maxSessionMs: 60_000,
      maxDedupeMs: 5_000,
      maxMs: 60_000,
    });
    server.close();

    const left = readFileSync(join(INBOX_DIR, "sess-a.json"), "utf8");
    let turnsLeft = 0;
    try { turnsLeft = (JSON.parse(left).turns || []).length; } catch {}

    console.log(JSON.stringify({
      written: sum.written,
      unjudged: sum.unjudged,
      dead: sum.dead,
      failed: sum.failed,
      unfinished: sum.unfinished,
      writes,
      supersedes,
      modelCalls,
      turnsLeft,
    }));
  `);

  assert.equal(out.writes, 0, "判重没跑成，一条都不许写进库");
  assert.equal(out.written, 0);
  assert.equal(out.unjudged, 1, "要把「这场没判重」报出来，不能静默");
  assert.equal(out.supersedes, 0, "更不许拿没判重的结论去做取代");
  assert.ok(out.modelCalls > 0, "判重确实被调过（只是被打回）");
  assert.equal(out.dead, 0, "只失败一次，还没到死信上限");
  assert.equal(out.failed, 0, "写库没过，不算条目失败");
  assert.equal(out.turnsLeft, 12, "轮次一条都不能摘：摘了下轮就不会重抽，条目永久丢");
  assert.equal(readdirSync(join(out.home, ".siyuan-mem", "inbox")).filter((f) => f.endsWith(".json")).length, 1, "原文还在队列里");
  // 记了一次尝试，攒满三次才进死信——所以这里必须记。
  const attempts = existsSync(join(out.home, ".siyuan-mem", "attempts.json"))
    ? JSON.parse(readFileSync(join(out.home, ".siyuan-mem", "attempts.json"), "utf8"))
    : {};
  assert.equal(Object.values(attempts).reduce((a, b) => a + b, 0), 1, "记一次尝试，攒到上限进死信，别无声无息地永远重试");
});

test("判重正常时不误伤：抽取的结果照写", () => {
  const out = run(`
    import { createServer } from "node:http";
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR } from "./src/util/config.mjs";

    // 判重回「保持原样」：这是正常结论，不该被当成失败。
    let judgeCalls = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        judgeCalls++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decisions: [{ new: 1, match: 1, action: "keep" }] }) } }] }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));

    writeFileSync(join(INBOX_DIR, "sess-b.json"), ${JSON.stringify(sessionJson(4, "b"))});

    let writes = 0;
    const store = {
      // 候选要跟新条目沾边，否则 pickCandidates 直接返回空、模型一次都不会被调，
      // 这条断言就成了「没跑也算过」——原来的写法正是如此。
      listCurrent: async () => [
        { id: "old-1", entity: "端口映射", brief: "端口映射按 1000 改", text: "端口映射按 1000 改，改完重启容器。", project: "/tmp/proj" },
      ],
      docIds: async () => ({ notebook: "box", months: {}, entries: "e", entities: "n", pending: "p" }),
      ensureGroupAnchor: async () => "",
      supersede: async () => {},
      writeEntry: async () => { writes++; return { id: "new-" + writes }; },
    };
    const cfg = {
      raw: { enabled: false },
      model: {
        apiKey: "k",
        baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
        name: "judge-ok",
        provider: "openai",
        wire: "openai",
        retries: 0,
        timeoutMs: 2000,
      },
      extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 },
    };
    const extract = async () => ({
      entries: [{ entity: "端口映射", text: "端口映射按 1000 改，改完重启容器", brief: "端口映射按 1000 改", type: "fact", from: 1, to: 2 }],
      mode: "model",
      batches: 1,
      usage: { prompt: 0, completion: 0 },
      coveredThrough: null,
    });

    const sum = await processQueue({ useModel: true, deps: { cfg, sy: {}, store, extract }, maxSessionMs: 60_000, maxMs: 60_000 });
    server.close();
    console.log(JSON.stringify({ written: sum.written, unjudged: sum.unjudged, writes, judgeCalls }));
  `);

  assert.equal(out.writes, 1, "判重说「都不重复」，就该照写");
  assert.equal(out.written, 1);
  assert.equal(out.unjudged, 0, "keep 是正常结论，不该被当成失败");
  assert.ok(out.judgeCalls > 0, "判重必须真的被调过——候选不沾边时这条断言会恒真");
});


test("判重回 200 但内容不是 JSON：拆半后的叶子失败也要算进 unjudged", () => {
  const out = run(`
    import { createServer } from "node:http";
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR } from "./src/util/config.mjs";

    let calls = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        calls++;
        // 200 + 一句人话：JSON.parse 失败，判重会拆半，叶子继续失败。
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "好的，我看过了" } }] }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));

    writeFileSync(join(INBOX_DIR, "sess-c.json"), JSON.stringify({
      session_id: "c", harness: "dsh", machine: "Mac", cwd: "/tmp/proj", date: "2026-11-18", turnFrom: 1,
      turns: [
        { role: "user", text: "端口映射这一块到底该怎么配才对" },
        { role: "assistant", text: "端口映射按 1000 改，改完重启容器，否则跑的还是旧配置。" },
      ],
    }));

    let writes = 0;
    const store = {
      listCurrent: async () => [
        { id: "old-1", entity: "端口映射", brief: "端口映射按 990 改", text: "端口映射按 990 改，改完重启容器。", project: "/tmp/proj" },
        { id: "old-2", entity: "端口映射", brief: "端口映射按 1000 改", text: "端口映射按 1000 改，改完要重启容器。", project: "/tmp/proj" },
      ],
      docIds: async () => ({ notebook: "box", months: {}, entries: "e", entities: "n", pending: "p" }),
      ensureGroupAnchor: async () => "",
      supersede: async () => {},
      writeEntry: async () => { writes++; return { id: "new-" + writes }; },
    };
    const cfg = {
      raw: { enabled: false },
      model: { apiKey: "k", baseUrl: "http://127.0.0.1:" + server.address().port + "/v1", name: "judge-bad", provider: "openai", wire: "openai", retries: 0, timeoutMs: 2000 },
      extract: { minTurnChars: 5, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 },
    };
    const extract = async () => ({
      entries: [
        { entity: "端口映射", text: "端口映射按 1000 改，改完重启容器", brief: "端口映射按 1000 改", type: "fact", from: 1, to: 1 },
        { entity: "端口映射", text: "改完不重启容器，跑的还是旧配置", brief: "改完要重启容器", type: "fact", from: 1, to: 1 },
      ],
      mode: "model", batches: 1, usage: { prompt: 0, completion: 0 }, coveredThrough: null,
    });
    const sum = await processQueue({ useModel: true, deps: { cfg, sy: {}, store, extract }, maxSessionMs: 60_000, maxMs: 60_000 });
    server.close();
    console.log(JSON.stringify({ writes, unjudged: sum.unjudged, calls }));
  `);

  assert.equal(out.writes, 0, "没判过重就不许写");
  assert.equal(out.unjudged, 1, "拆半叶子全失败也必须报 unjudged（failed 恒为 0 的坑）");
  assert.ok(out.calls >= 3, "父块 + 两个叶子至少三次调用");
});

test("判重池读不出来就停手：不许当空表继续写", () => {
  const out = run(`
    import { mkdtempSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR } from "./src/util/config.mjs";

    writeFileSync(join(INBOX_DIR, "sess-pool.json"), JSON.stringify({
      session_id: "pool", harness: "dsh", machine: "Mac", cwd: "/tmp/proj", date: "2026-11-18", turnFrom: 1,
      turns: [{ role: "user", text: "端口映射这一块到底该怎么配才对" }, { role: "assistant", text: "按 1000 改，改完重启容器。" }],
    }));
    const store = {
      listCurrent: async () => { throw new Error("SQL 超时"); },
      docIds: async () => ({ notebook: "box", months: {}, entries: "e", entities: "n", pending: "p" }),
      ensureGroupAnchor: async () => "",
      supersede: async () => {},
      writeEntry: async () => {},
    };
    const cfg = { raw: { enabled: false }, model: { apiKey: "k", baseUrl: "http://127.0.0.1:1/v1", name: "x", provider: "openai", wire: "openai", retries: 0 }, extract: {} };
    const extract = async () => ({ entries: [{ entity: "端口映射", text: "端口映射按 1000 改", brief: "端口映射", type: "fact", from: 1, to: 1 }], mode: "model", batches: 1, usage: {}, coveredThrough: null });
    let err = "";
    try {
      await processQueue({ useModel: true, deps: { cfg, sy: {}, store, extract }, maxSessionMs: 1000, maxMs: 1000 });
    } catch (e) { err = e.message; }
    console.log(JSON.stringify({ err }));
  `);
  assert.match(out.err, /判重池读不出来/, "要把停手原因说清楚，不能静默写库");
});
