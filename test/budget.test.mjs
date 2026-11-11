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

/** 在指定的 HOME 里跑一段脚本：多轮场景要复用同一个队列和 attempts.json。 */
function runIn(home, code) {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: ROOT,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return JSON.parse(out.trim());
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

test("写库全失败时不许摘轮次：摘了那几轮就再没人抽", () => {
  // 原来只看 stoppedEarly 就改写队列。写失败（思源抖、内容建不出块）时照样摘，
  // 于是「前 N 轮已写进库」是一句谎话，而那几轮的条目永久缺失。
  const out = run(`
    import { writeFileSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR } from "./src/util/config.mjs";

    writeFileSync(join(INBOX_DIR, "sess-fail.json"), ${JSON.stringify(sessionJson(6))});
    const store = {
      listCurrent: async () => [],
      docIds: async () => ({ notebook: "box", months: {}, entries: "e", entities: "n", pending: "p" }),
      ensureGroupAnchor: async () => "",
      supersede: async () => {},
      writeEntry: async () => {
        throw new Error("连不上思源：超时 5000ms");
      },
    };
    const cfg = { raw: { enabled: false }, extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 } };
    // 抽的时候说到点了，覆盖了前 4 轮；但一条都写不进去。
    const extract = async () => ({
      entries: [1, 2, 3].map((i) => ({ text: "第 " + i + " 条结论", entity: "proj", type: "fact", confidence: 2, from: 0, to: 1 })),
      mode: "model", batches: 3, stoppedEarly: true, coveredThrough: 3, remainingBatches: 2,
    });
    const sum = await processQueue({ useModel: false, deps: { cfg, sy: {}, store, extract }, maxSessionMs: 60_000 });
    const rest = JSON.parse(readFileSync(join(INBOX_DIR, "sess-fail.json"), "utf8"));
    console.log(JSON.stringify({ written: sum.written, trimmed: sum.trimmed, turns: rest.turns.length, unfinished: sum.unfinished }));
  `);
  assert.equal(out.written, 0, "前提：一条都没写进去");
  assert.equal(out.trimmed, 0, "一条都没写进去，就不能摘轮次");
  assert.equal(out.turns, 12, "6 轮 = 12 条 turn，一条都不该少");
  assert.ok(out.unfinished >= 1, "这场要算「没做完」，不能报成正常");
});

test("一个会话把本轮撞停、但别的会话写得进去：记它一次，别让它永远压在队头", () => {
  const out = run(`
    import { writeFileSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR, ATTEMPTS_PATH } from "./src/util/config.mjs";

    writeFileSync(join(INBOX_DIR, "sess-a-ok.json"), ${JSON.stringify(sessionJson(4, "ok"))});
    writeFileSync(join(INBOX_DIR, "sess-b-poison.json"), ${JSON.stringify(sessionJson(4, "poison"))});
    // 前 4 条（第一场）写得进去，之后的全部失败——模拟「某一场的条目内容建不出块」。
    let n = 0;
    const store = {
      listCurrent: async () => [],
      docIds: async () => ({ notebook: "box", months: {}, entries: "e", entities: "n", pending: "p" }),
      ensureGroupAnchor: async () => "",
      supersede: async () => {},
      writeEntry: async () => {
        n++;
        if (n > 4) throw new Error("在建块这一步被拒（内容级错误）");
        return { id: "blk-" + n };
      },
    };
    const cfg = { raw: { enabled: false }, extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 } };
    const extract = async () => ({
      entries: [1, 2, 3, 4].map((i) => ({ text: "第 " + i + " 条结论", entity: "proj", type: "fact", confidence: 2, from: 0, to: 1 })),
      mode: "model", batches: 1,
    });
    const sum = await processQueue({ useModel: false, deps: { cfg, sy: {}, store, extract }, maxSessionMs: 60_000 });
    const att = JSON.parse(readFileSync(ATTEMPTS_PATH, "utf8"));
    console.log(JSON.stringify({ written: sum.written, broken: sum.broken, marked: Object.keys(att) }));
  `);
  assert.ok(out.written >= 4, "第一场要写成功——这是「思源没坏」的证据");
  assert.equal(out.broken, true, "第二场连着三条失败，本轮熔断");
  assert.ok(
    out.marked.some((f) => f.includes("poison")),
    "撞停的那场要被记一次，否则它永远排在队头、后面的会话轮不到",
  );
});

test("全被判重跳过是正常，不是故障：允许摘轮次，三轮也不进死信", () => {
  // 第五轮 CR：上一版 hasRest 分支一律 park，把「内容已在库里」记成会话故障，
  // 三轮后把还剩 20 轮没抽的会话扫进 dead/，而没有任何一条写入失败。
  // 全跳过 = 这几轮已经处理完了，可以安全摘掉；只有模型零产出才该记账。
  const home = mkdtempSync(join(tmpdir(), "mem-alldup-"));
  mkdirSync(join(home, ".siyuan-mem", "inbox"), { recursive: true });
  const code = `
    import { existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR, DEAD_DIR } from "./src/util/config.mjs";

    const f = join(INBOX_DIR, "sess-alldup.json");
    if (!existsSync(f)) writeFileSync(f, ${JSON.stringify(sessionJson(6))});
    const store = {
      listCurrent: async () => [],
      docIds: async () => ({ notebook: "box", months: {}, entries: "e", entities: "n", pending: "p" }),
      ensureGroupAnchor: async () => "",
      supersede: async () => {},
      writeEntry: async () => ({ id: "dup-1", duplicate: true }),
    };
    const cfg = { raw: { enabled: false }, extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 } };
    const extract = async () => ({
      entries: [1, 2].map((i) => ({ text: "第 " + i + " 条结论", entity: "proj", type: "fact", confidence: 2, from: 0, to: 1 })),
      mode: "model", batches: 3, stoppedEarly: true, coveredThrough: 3, remainingBatches: 2,
    });
    const sum = await processQueue({ useModel: false, deps: { cfg, sy: { sql: async () => [] }, store, extract }, maxSessionMs: 60_000 });
    const rest = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { turns: [] };
    console.log(JSON.stringify({
      written: sum.written, skipped: sum.skipped, trimmed: sum.trimmed,
      turns: rest.turns.length, dead: sum.dead,
      deadFiles: existsSync(DEAD_DIR) ? readdirSync(DEAD_DIR).filter((x) => x.endsWith(".json")) : [],
    }));
  `;
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(runIn(home, code));
  assert.equal(runs[0].written, 0, "前提：一条都没写进去");
  assert.equal(runs[0].skipped, 2, "两条全被判重跳过");
  assert.equal(runs[0].trimmed, 1, "全跳过也是处理完了，可以摘轮次");
  assert.equal(runs[0].turns, 8, "12 条 turn 摘掉前 4 条，剩 8 条");
  for (const r of runs) assert.equal(r.dead, 0, "任何一轮都不该进死信");
  assert.equal(runs[2].deadFiles.length, 0, "三轮后 dead/ 里必须什么都没有");
});

test("模型正常判空 = 处理完了：摘轮次继续抽后半段，三轮也不进死信", () => {
  // 第六轮 CR：模型调用成功、判定这几轮没什么可记，这不是会话故障。
  // 上一版一律 park，三轮后把还剩 20 轮的会话扫进 dead/。
  const home = mkdtempSync(join(tmpdir(), "mem-cleanempty-"));
  mkdirSync(join(home, ".siyuan-mem", "inbox"), { recursive: true });
  const code = `
    import { existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR, DEAD_DIR } from "./src/util/config.mjs";

    const f = join(INBOX_DIR, "sess-cleanempty.json");
    if (!existsSync(f)) writeFileSync(f, ${JSON.stringify(sessionJson(6))});
    const store = {
      listCurrent: async () => [],
      docIds: async () => ({ notebook: "box", months: {}, entries: "e", entities: "n", pending: "p" }),
      ensureGroupAnchor: async () => "",
      supersede: async () => {},
      writeEntry: async () => ({ id: "blk" }),
    };
    const cfg = { raw: { enabled: false }, extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 } };
    const extract = async () => ({ entries: [], mode: "model", batches: 3, stoppedEarly: true, coveredThrough: 3, remainingBatches: 2 });
    const sum = await processQueue({ useModel: false, deps: { cfg, sy: { sql: async () => [] }, store, extract }, maxSessionMs: 60_000 });
    const rest = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { turns: [] };
    console.log(JSON.stringify({
      trimmed: sum.trimmed, dead: sum.dead, turns: rest.turns.length,
      deadFiles: existsSync(DEAD_DIR) ? readdirSync(DEAD_DIR).filter((x) => x.endsWith(".json")) : [],
    }));
  `;
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(runIn(home, code));
  assert.equal(runs[0].trimmed, 1, "正常判空也算处理完，可以摘轮次");
  assert.equal(runs[0].turns, 8, "12 条 turn 摘掉前 4 条，剩 8 条继续抽");
  for (const r of runs) assert.equal(r.dead, 0, "任何一轮都不该进死信");
  assert.equal(runs[2].deadFiles.length, 0, "三轮后 dead/ 必须空的");
});

test("抽取不完整的零产出才记账：报错或截光的会话，试满上限进死信", () => {
  // 与上面区分开：模型报错 / 条目被 dropped 截光，是真没处理完，不能摘轮次。
  const home = mkdtempSync(join(tmpdir(), "mem-dirtyempty-"));
  mkdirSync(join(home, ".siyuan-mem", "inbox"), { recursive: true });
  const code = `
    import { existsSync, writeFileSync, readdirSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR, DEAD_DIR } from "./src/util/config.mjs";

    const f = join(INBOX_DIR, "sess-dirtyempty.json");
    if (!existsSync(f)) writeFileSync(f, ${JSON.stringify(sessionJson(6))});
    const store = {
      listCurrent: async () => [],
      docIds: async () => ({ notebook: "box", months: {}, entries: "e", entities: "n", pending: "p" }),
      ensureGroupAnchor: async () => "",
      supersede: async () => {},
      writeEntry: async () => ({ id: "blk" }),
    };
    const cfg = { raw: { enabled: false }, extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 } };
    const extract = async () => ({
      entries: [], mode: "model", error: "1/3 批失败：超时", batches: 3,
      stoppedEarly: true, coveredThrough: 3, remainingBatches: 2,
    });
    const sum = await processQueue({ useModel: false, deps: { cfg, sy: { sql: async () => [] }, store, extract }, maxSessionMs: 60_000 });
    console.log(JSON.stringify({
      trimmed: sum.trimmed, dead: sum.dead,
      deadFiles: existsSync(DEAD_DIR) ? readdirSync(DEAD_DIR).filter((x) => x.endsWith(".json")) : [],
    }));
  `;
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(runIn(home, code));
  assert.equal(runs[0].trimmed, 0, "抽取报错了就不能摘轮次");
  assert.equal(runs[0].dead, 0, "第一次只记账");
  assert.equal(runs[2].dead, 1, "一直抽不完整，第三次该进死信");
  assert.equal(runs[2].deadFiles.length, 1);
});

test("毒会话排在队首：读探针正常时要累计次数，跑到上限必须进 dead/", () => {
  // 这是「用本轮统计量推断全局健康」的经典翻车：毒会话在队首时整轮 written 恒为 0，
  // 用 written>0 当判据，它永远攒不到次数、永远卡在队头。改用读探针区分。
  const home = mkdtempSync(join(tmpdir(), "mem-poison-"));
  mkdirSync(join(home, ".siyuan-mem", "inbox"), { recursive: true });
  const code = `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR } from "./src/util/config.mjs";

    writeFileSync(join(INBOX_DIR, "sess-0-poison.json"), ${JSON.stringify(sessionJson(4, "poison"))});
    const store = {
      listCurrent: async () => [],
      docIds: async () => ({ notebook: "box", months: {}, entries: "e", entities: "n", pending: "p" }),
      ensureGroupAnchor: async () => "",
      supersede: async () => {},
      writeEntry: async () => {
        throw new Error("建块被拒（内容级错误）");
      },
    };
    const cfg = { raw: { enabled: false }, extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 } };
    const extract = async () => ({
      entries: [1, 2, 3, 4].map((i) => ({ text: "第 " + i + " 条结论", entity: "proj", type: "fact", confidence: 2, from: 0, to: 1 })),
      mode: "model", batches: 1,
    });
    // 读探针能通：说明库没坏，是这一场自己的毛病。
    const sy = { sql: async () => [] };
    const sum = await processQueue({ useModel: false, deps: { cfg, sy, store, extract }, maxSessionMs: 60_000 });
    console.log(JSON.stringify({ written: sum.written, broken: sum.broken, dead: sum.dead }));
  `;
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(runIn(home, code));
  assert.equal(runs[0].broken, true, "第一轮就该熔断");
  assert.equal(runs[0].dead, 0, "第一次只记账，不直接进死信");
  assert.equal(runs[1].dead, 0, "第二次还在攒");
  assert.equal(runs[2].dead, 1, "第三次到上限，必须进死信——否则它永远压在队头");
  const deadFiles = readdirSync(join(home, ".siyuan-mem", "dead"));
  assert.ok(deadFiles.some((f) => f.endsWith(".json")), "dead/ 里要有这个会话");
  assert.ok(deadFiles.some((f) => f.endsWith(".why")), "旁边要有原因文件");
});

test("思源连读都读不动：一次故障不该把整队扫进死信", () => {
  // 第八轮 CR：读探针正常那一半有护栏，返回 false 的这一半没有。
  // 设计意图是「库整体卡住时不记在任何会话头上」，否则一次抖动能把全队扫进 dead/。
  const home = mkdtempSync(join(tmpdir(), "mem-probe-down-"));
  mkdirSync(join(home, ".siyuan-mem", "inbox"), { recursive: true });
  const code = `
    import { existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
    import { join } from "node:path";
    import { processQueue } from "./src/core/jobs.mjs";
    import { INBOX_DIR, DEAD_DIR, ATTEMPTS_PATH } from "./src/util/config.mjs";

    const f = join(INBOX_DIR, "sess-dbdown.json");
    if (!existsSync(f)) writeFileSync(f, ${JSON.stringify(sessionJson(4, "dbdown"))});
    const store = {
      listCurrent: async () => [],
      docIds: async () => ({ notebook: "box", months: {}, entries: "e", entities: "n", pending: "p" }),
      ensureGroupAnchor: async () => "",
      supersede: async () => {},
      writeEntry: async () => { throw new Error("连不上思源：超时 5000ms"); },
    };
    const cfg = { raw: { enabled: false }, extract: { minTurnChars: 10, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 } };
    const extract = async () => ({
      entries: [1, 2, 3, 4].map((i) => ({ text: "第 " + i + " 条结论", entity: "proj", type: "fact", confidence: 2, from: 0, to: 1 })),
      mode: "model", batches: 1,
    });
    // 写和读都挂：这正是「思源整体卡住」，不是某一场会话自己的毛病。
    const sy = { sql: async () => { throw new Error("SELECT timeout 5000ms"); } };
    const sum = await processQueue({ useModel: false, deps: { cfg, sy, store, extract }, maxSessionMs: 60_000 });
    console.log(JSON.stringify({
      broken: sum.broken, dead: sum.dead, inbox: existsSync(f),
      deadFiles: existsSync(DEAD_DIR) ? readdirSync(DEAD_DIR).filter((x) => x.endsWith(".json")) : [],
      attempts: existsSync(ATTEMPTS_PATH) ? JSON.parse(readFileSync(ATTEMPTS_PATH, "utf8")) : {},
    }));
  `;
  const runs = [];
  for (let i = 0; i < 4; i++) runs.push(runIn(home, code));
  for (const r of runs) {
    assert.equal(r.broken, true, "前提：本轮熔断了");
    assert.equal(r.dead, 0, "库坏了不能记在会话头上");
    assert.equal(r.inbox, true, "会话必须留在队列里等思源恢复");
    assert.equal(r.deadFiles.length, 0, "dead/ 里不该有任何文件");
  }
  assert.deepEqual(runs[3].attempts, {}, "四轮都不该产生失败计数");
});
