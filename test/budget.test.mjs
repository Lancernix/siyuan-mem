/**
 * 预算与熔断：2026-11-10 凌晨那次死机的两条直线。
 *
 * 那天的日志是这样的：
 *
 *     02:55  这一轮到预算了（3 个会话 / 86 分钟）
 *     05:12  写入失败：连不上思源（http://siyuan:6806/api/query/sql）：超时 5000ms
 *     10:51  第 7 轮 6152.1s … 失败 10
 *
 * 轮预算是 20 分钟，实际跑 103 分钟，因为预算只在会话之间看；而思源卡住之后
 * 每条都要等 5 秒超时，越写越慢。下面这几条就是钉住这两个洞：会话内部有闸门、
 * 写库连着失败就熔断、老过不去的会话进死信。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * 在临时 HOME 里跑一段脚本。
 *
 * 队列、attempts.json、dead/ 全都是按 HOME 定位的，所以换 HOME 就是换一套干净环境；
 * 顺带也就验了这些路径没写死。
 */
function run(code) {
  const home = mkdtempSync(join(tmpdir(), "mem-budget-"));
  mkdirSync(join(home, ".siyuan-mem", "inbox"), { recursive: true });
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: ROOT,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return { ...JSON.parse(out.trim()), home };
}

/** 造一个会话包：n 轮问答，heuristic 抽取会按轮出条目。 */
function sessionJson(n, tag = "s1") {
  // 每轮的话都要不一样：规则抽取会按文本去重，同一句话重复十遍只会出一条，
  // 那就测不出"写到一半到点收手"了。
  const turns = [];
  for (let i = 0; i < n; i++) {
    turns.push({ role: "user", text: `第 ${i + 1} 个问题：${["端口映射", "卷挂载", "内存上限", "反向代理", "证书续期", "备份策略", "索引重建", "日志切割", "健康检查", "网络模式", "时区设置", "权限模型"][i % 12]}这一块到底该怎么配` });
    turns.push({
      role: "assistant",
      text: `第 ${i + 1} 个回答：${["nginx", "compose", "cgroup", "edgeone", "acme", "restic", "sqlite", "logrotate", "healthcheck", "bridge", "tzdata", "rls"][i % 12]} 这层要按 ${1000 + i} 这个值改，改完记得重启容器，否则跑的还是旧配置。这段话要足够长，短了会被当成寒暄丢掉。`,
    });
  }
  return JSON.stringify({ session_id: tag, harness: "dsh", machine: "Mac", cwd: "/tmp/proj", date: "2026-11-10", turnFrom: 1, turns });
}

/** 假 store：可选写库是否失败、是否慢。 */
function fakeStore({ failWrites = false, writeDelayMs = 0, onWrite = () => {} } = {}) {
  return `
    const store = {
      listCurrent: async () => [],
      docIds: async () => ({ notebook: "box", months: {}, entries: "e", entities: "n", pending: "p" }),
      ensureGroupAnchor: async () => "",
      supersede: async () => {},
      writeEntry: async (entry) => {
        ${writeDelayMs ? `await new Promise((r) => setTimeout(r, ${writeDelayMs}));` : ""}
        ${failWrites ? 'throw new Error("连不上思源（http://siyuan:6806/api/block/appendBlock）：超时 5000ms");' : ""}
        globalThis.__writes = (globalThis.__writes ?? 0) + 1;
        return { id: "blk-" + globalThis.__writes };
      },
    };
  `;
}

test("写库连着失败就熔断本轮：不再一条条撞 5 秒超时", () => {
  const out = run(`
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR } from "./src/util/config.mjs";

    writeFileSync(join(INBOX_DIR, "sess-a.json"), ${JSON.stringify(sessionJson(8))});
    writeFileSync(join(INBOX_DIR, "sess-b.json"), ${JSON.stringify(sessionJson(8, "s2"))});
    ${fakeStore({ failWrites: true })}
    const cfg = { raw: { enabled: false }, extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 } };
    const extract = async () => ({ entries: Array.from({ length: 10 }, (_, i) => ({ text: "第 " + (i + 1) + " 条结论，内容各不相同免得被合并", entity: "proj", type: "fact", confidence: 2, from: i * 2, to: i * 2 + 1 })), mode: "model", batches: 1 });
    const sum = await processQueue({ useModel: false, deps: { cfg, sy: {}, store, extract }, maxConsecutiveFailures: 3, maxSessionMs: 60_000 });
    console.log(JSON.stringify({ broken: sum.broken, left: sum.left, failed: sum.failed, dead: sum.dead }));
  `);
  assert.equal(out.broken, true, "连着失败三次必须熔断");
  // 熔断之后另一场会话不能再碰：碰了就是又一轮 5 秒超时。
  assert.equal(out.left, 1, "熔断时整轮停下：第二场根本没碰");
  assert.equal(out.failed, 3, "只试了 3 条就停手，不是把 8 条全撞一遍");
  assert.equal(out.dead, 0, "写库失败不算这个会话的错，不能进死信");
  assert.equal(readdirSync(join(out.home, ".siyuan-mem", "inbox")).filter((f) => f.endsWith(".json")).length, 2, "队列原样保留");
  const deadDir = join(out.home, ".siyuan-mem", "dead");
  assert.deepEqual(existsSync(deadDir) ? readdirSync(deadDir) : [], [], "没有死信");
});

test("单会话到点收手：不归档、不丢已写的条目、下轮接着来", () => {
  const out = run(`
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR } from "./src/util/config.mjs";

    writeFileSync(join(INBOX_DIR, "sess-slow.json"), ${JSON.stringify(sessionJson(12))});
    ${fakeStore({ writeDelayMs: 25 })}
    const cfg = { raw: { enabled: false }, extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 } };
    const extract = async () => ({ entries: Array.from({ length: 10 }, (_, i) => ({ text: "第 " + (i + 1) + " 条结论，内容各不相同免得被合并", entity: "proj", type: "fact", confidence: 2, from: i * 2, to: i * 2 + 1 })), mode: "model", batches: 1 });
    const sum = await processQueue({ useModel: false, deps: { cfg, sy: {}, store, extract }, maxSessionMs: 120, maxMs: 60_000 });
    console.log(JSON.stringify({ written: sum.written, unfinished: sum.unfinished, left: sum.left, dead: sum.dead }));
  `);
  assert.ok(out.written >= 1, "已经写进去的留着");
  assert.ok(out.written < 10, "没写完就到点了");
  assert.equal(out.unfinished, 1, "这一场算没做完，要单独报出来");
  assert.equal(out.dead, 0, "第一次超预算不进死信，只是留到下一轮");
  assert.equal(readdirSync(join(out.home, ".siyuan-mem", "inbox")).filter((f) => f.endsWith(".json")).length, 1, "原文还在队列里");
});

test("同一个会话老过不去：到上限进 dead/，旁边留一份为什么", () => {
  const out = run(`
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR, DEAD_DIR } from "./src/util/config.mjs";

    writeFileSync(join(INBOX_DIR, "sess-poison.json"), ${JSON.stringify(sessionJson(12))});
    ${fakeStore({ writeDelayMs: 25 })}
    const cfg = { raw: { enabled: false }, extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 } };
    const extract = async () => ({ entries: Array.from({ length: 10 }, (_, i) => ({ text: "第 " + (i + 1) + " 条结论，内容各不相同免得被合并", entity: "proj", type: "fact", confidence: 2, from: i * 2, to: i * 2 + 1 })), mode: "model", batches: 1 });
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const s = await processQueue({ useModel: false, deps: { cfg, sy: {}, store, extract }, maxSessionMs: 60, maxMs: 60_000 });
      runs.push({ dead: s.dead, failed: s.failed });
    }
    console.log(JSON.stringify({ runs, inbox: 0 }));
  `);
  assert.equal(out.runs[0].dead, 0);
  assert.equal(out.runs[1].dead, 0);
  assert.equal(out.runs[2].dead, 1, "第三次还过不去就该挪走：它压着队头，后面的永远轮不到");
  assert.equal(readdirSync(join(out.home, ".siyuan-mem", "inbox")).filter((f) => f.endsWith(".json")).length, 0, "从 inbox 里挪走了");
  const dead = readdirSync(join(out.home, ".siyuan-mem", "dead"));
  assert.ok(dead.includes("sess-poison.json"), "原文件整个保留，能手动挪回去重跑");
  assert.ok(dead.some((f) => f.endsWith(".why")), "留一份原因，不然 dead/ 里只有一堆看不懂的 json");
});

test("这轮成功过：失败次数清零，别把偶发失败攒成死信", () => {
  const out = run(`
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR } from "./src/util/config.mjs";

    writeFileSync(join(INBOX_DIR, "sess-one.json"), ${JSON.stringify(sessionJson(2))});
    ${fakeStore()}
    const cfg = { raw: { enabled: false }, extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 } };
    const extract = async () => ({ entries: Array.from({ length: 10 }, (_, i) => ({ text: "第 " + (i + 1) + " 条结论，内容各不相同免得被合并", entity: "proj", type: "fact", confidence: 2, from: i * 2, to: i * 2 + 1 })), mode: "model", batches: 1 });
    const s = await processQueue({ useModel: false, deps: { cfg, sy: {}, store, extract }, maxSessionMs: 60_000 });
    console.log(JSON.stringify({ written: s.written, dead: s.dead }));
  `);
  assert.ok(out.written >= 1, "正常写完");
  assert.equal(out.dead, 0);
  assert.equal(readdirSync(join(out.home, ".siyuan-mem", "inbox")).filter((f) => f.endsWith(".json")).length, 0, "处理完的进 done/");
});

test("抽到预算就收手：抽过的那几轮从队列摘掉，下轮接着抽后半段", () => {
  const out = run(`
    import { readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR } from "./src/util/config.mjs";

    writeFileSync(join(INBOX_DIR, "sess-long.json"), ${JSON.stringify(sessionJson(6))});
    ${fakeStore()}
    const cfg = { raw: { enabled: false }, extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 } };
    // 抽完前两轮就到点了：报 stoppedEarly，覆盖到第 3 个 turn（0 基）。
    const extract = async () => ({ entries: [
      { text: "前半段的第一条结论", entity: "proj", type: "fact", confidence: 2, from: 0, to: 1 },
      { text: "前半段的第二条结论", entity: "proj", type: "fact", confidence: 2, from: 2, to: 3 },
    ], mode: "model", batches: 4, stoppedEarly: true, coveredThrough: 3, remainingBatches: 3 });
    const sum = await processQueue({ useModel: false, deps: { cfg, sy: {}, store, extract }, maxSessionMs: 60_000 });
    const rest = JSON.parse(readFileSync(join(INBOX_DIR, "sess-long.json"), "utf8"));
    console.log(JSON.stringify({ written: sum.written, trimmed: sum.trimmed, left: rest.turns.length, turnFrom: rest.turnFrom, unfinished: sum.unfinished }));
  `);
  assert.equal(out.written, 2, "抽出来的必须先写进库");
  assert.equal(out.trimmed, 1, "这一场算「摘过」，不是「没做完」");
  assert.equal(out.unfinished, 0, "摘过是有进展，不能记成失败");
  assert.equal(out.turnFrom, 5, "起始轮次要往后挪 4 轮（第 1 轮从 1 开始）");
  assert.equal(out.left, 8, "6 轮问答共 12 条 turn，摘掉 4 条还剩 8 条");
  assert.equal(readdirSync(join(out.home, ".siyuan-mem", "inbox")).filter((f) => f.endsWith(".json")).length, 1, "剩下的还在队列里");
});

test("时间全花在抽取上、一条还没写：不许收手，先把这批写进去", () => {
  const out = run(`
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR } from "./src/util/config.mjs";

    writeFileSync(join(INBOX_DIR, "sess-slow-extract.json"), ${JSON.stringify(sessionJson(6))});
    ${fakeStore()}
    const cfg = { raw: { enabled: false }, extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 } };
    // 抽取慢到把预算全花掉：模拟一趟十几分钟的模型调用。
    const extract = async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { entries: Array.from({ length: 4 }, (_, i) => ({ text: "第 " + (i + 1) + " 条结论", entity: "proj", type: "fact", confidence: 2, from: 0, to: 1 })), mode: "model", batches: 2 };
    };
    const sum = await processQueue({ useModel: false, deps: { cfg, sy: {}, store, extract }, maxSessionMs: 50, maxMs: 60_000 });
    console.log(JSON.stringify({ written: sum.written, unfinished: sum.unfinished }));
  `);
  // 到点收手的话这里会是 0 条，等于白抽一场，下轮从头再来；三趟之后还会被当成老赖。
  assert.equal(out.written, 4, "一条都还没写的时候不能收手");
  assert.equal(out.unfinished, 0);
});
