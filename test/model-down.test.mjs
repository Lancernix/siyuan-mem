/**
 * 模型挂了就停手，不许拿规则抽取顶上。
 *
 * 2026-11-16 发现的坑：模型订阅过期十天，抽取每批都失败，然后**静默退回规则抽取**——
 * 从对话里挑一句最像结论的话写进库，还推进覆盖点。结果是条目看着有、质量全是半句话，
 * 而且游标一过原文再也不会重抽。日志上只有一个 dedupe.failed，没人看得出来。
 *
 * 现在的规矩：
 *   1. 配了模型但调用失败 → 这一场一条都不写，原样留在队列里；
 *   2. 整轮立刻停，不挨个会话白等一次超时；
 *   3. 不记在会话头上（模型不是这一场的毛病），否则一次故障能把整队扫进 dead/。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { extractEntries } from "../src/core/extract.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/** 每次都回 401 + 订阅过期：模拟 key 失效。 */
async function withDeadModel(fn, { status = 401, body = { error: { code: "InvalidSubscription", message: "subscription has expired" } } } = {}) {
  let calls = 0;
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      calls++;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = {
    model: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "test",
      name: "dead",
      wire: "openai",
      provider: "openai",
      jsonMode: true,
      timeoutMs: 3000,
      retries: 0,
    },
    extract: { maxCharsPerCall: 1200, maxEntriesPerBatch: 8, maxEntriesPerSession: 200, entityShotList: 0 },
  };
  try {
    return await fn({ cfg, calls: () => calls });
  } finally {
    server.close();
  }
}

/** 造 n 轮问答，长到能拆成好几批（maxCharsPerCall 设得很小）。 */
function exchanges(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      from: i * 2 + 1,
      to: i * 2 + 2,
      turns: [
        { role: "user", text: `第 ${i + 1} 个问题：这一块到底该怎么配，要注意什么` },
        {
          role: "assistant",
          text: `第 ${i + 1} 个回答：这里要按 ${1000 + i} 这个值改，改完重启容器，否则跑的还是旧配置。这段话要足够长，短了会被当成寒暄丢掉。`,
        },
      ],
    });
  }
  return out;
}

test("模型调用失败：一条都不写，也不退回规则抽取", async () => {
  await withDeadModel(async ({ cfg, calls }) => {
    const r = await extractEntries(cfg, exchanges(6), { fallbackEntity: "proj", useModel: true });
    assert.deepEqual(r.entries, [], "规则抽取的半句话不能顶上来");
    assert.equal(r.mode, "failed", "模式要说明是失败，不是 partial / heuristic");
    assert.ok(r.error, "错误要带出来，调用方据此停手");
    assert.equal(r.fatal, true, "401 属于配置/账号问题，标成 fatal");
    assert.equal(r.coveredThrough, null, "覆盖点不能推进，否则这几轮原文再也回不来");
    assert.equal(calls(), 1, "第一批失败就停，不该按批数把墙撞一遍");
  });
});

test("400 里的订阅过期 / 模型不存在也算 fatal，普通 400 不算", async () => {
  await withDeadModel(
    async ({ cfg }) => {
      const r = await extractEntries(cfg, exchanges(2), { useModel: true });
      assert.equal(r.fatal, true);
    },
    { status: 400, body: { error: { code: "InvalidSubscription", message: "does not have a valid AgentPlan subscription" } } }
  );
  await withDeadModel(
    async ({ cfg }) => {
      const r = await extractEntries(cfg, exchanges(2), { useModel: true });
      assert.notEqual(r.fatal, true, "其他 400 是请求内容的问题，不该判成配置问题");
    },
    { status: 400, body: { error: { code: "BadRequest", message: "messages 太长" } } }
  );
});

/** 在临时 HOME 里跑一段脚本（队列、attempts 都按 HOME 定位）。 */
function run(code) {
  const home = mkdtempSync(join(tmpdir(), "mem-modeldown-"));
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
  return JSON.stringify({ session_id: tag, harness: "dsh", machine: "Mac", cwd: "/tmp/proj", date: "2026-11-16", turnFrom: 1, turns });
}

test("一轮里模型挂了：整轮停手，不写库、不进死信、不记会话失败", () => {
  const out = run(`
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR } from "./src/util/config.mjs";

    writeFileSync(join(INBOX_DIR, "sess-a.json"), ${JSON.stringify(sessionJson(6, "a"))});
    writeFileSync(join(INBOX_DIR, "sess-b.json"), ${JSON.stringify(sessionJson(6, "b"))});

    const store = {
      listCurrent: async () => [],
      docIds: async () => ({ notebook: "box", months: {}, entries: "e", entities: "n", pending: "p" }),
      ensureGroupAnchor: async () => "",
      supersede: async () => {},
      writeEntry: async () => { globalThis.__writes = (globalThis.__writes ?? 0) + 1; return { id: "x" }; },
    };
    const cfg = { raw: { enabled: false }, model: { apiKey: "k", baseUrl: "http://127.0.0.1:1/v1", name: "dead", provider: "openai", wire: "openai" }, extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 } };
    // 抽取层已经改成「失败就返回空 + error」，这里直接给它这个样子。
    let extractCalls = 0;
    const extract = async () => { extractCalls++; return { entries: [], mode: "failed", batches: 3, usage: { prompt: 0, completion: 0 }, error: "401 InvalidSubscription", fatal: true }; };
    const sum = await processQueue({ useModel: true, deps: { cfg, sy: {}, store, extract }, maxSessionMs: 60_000, maxMs: 60_000 });
    console.log(JSON.stringify({
      written: sum.written,
      dead: sum.dead,
      failed: sum.failed,
      left: sum.left,
      modelDown: Boolean(sum.modelDown),
      fatal: Boolean(sum.modelDown?.fatal),
      extractCalls,
    }));
  `);

  assert.equal(out.written, 0, "模型挂了不能写任何条目");
  assert.equal(out.dead, 0, "模型不是这一场会话的毛病，不许进死信");
  assert.equal(out.failed, 0, "也不许记成会话失败");
  assert.equal(out.modelDown, true, "要把「模型不可用」报给上层");
  assert.equal(out.fatal, true, "401 是配置问题，要提示人去看");
  assert.equal(out.extractCalls, 1, "第一场撞上就整轮停，第二场不该再白等一次");
  assert.equal(out.left, 1, "剩下那场原样留在队列里");
  assert.equal(readdirSync(join(out.home, ".siyuan-mem", "inbox")).filter((f) => f.endsWith(".json")).length, 2, "两场都还在队列里");
  assert.equal(existsSync(join(out.home, ".siyuan-mem", "attempts.json")), false, "不许往 attempts 里记账");
});
