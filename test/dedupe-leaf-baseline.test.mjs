/**
 * 判重的失败计数必须是「本轮增量」，不能是「进程累计」。
 *
 * 拆半重试的子块失败只记 leafFailed，而这个变量是进程级的：mem serve 常驻，
 * 一次模型抖动留下的 2 会一直躺在那儿。基线只取 failed 的话，之后每一轮都会
 * 算出 dedupeFailed=2 → unjudged → 全场停写，直到进程重启。
 *
 * 这条用例必须在同一个进程里跑两轮才测得到——用 execFileSync 起独立进程的话，
 * leafFailed 天然从 0 开始，永远是绿的。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

process.env.HOME = mkdtempSync(join(tmpdir(), "mem-leaf-baseline-"));
mkdirSync(join(process.env.HOME, ".siyuan-mem", "inbox"), { recursive: true });

const { processQueue } = await import("../src/core/jobs.mjs");
const { INBOX_DIR } = await import("../src/util/config.mjs");

function session(tag) {
  return JSON.stringify({
    session_id: tag,
    harness: "dsh",
    machine: "Mac",
    cwd: "/tmp/proj",
    date: "2026-11-18",
    turnFrom: 1,
    turns: [
      { role: "user", text: "端口映射这一块到底该怎么配才对" },
      { role: "assistant", text: "按 1000 改，改完重启容器，否则跑的还是旧配置。" },
      { role: "user", text: "那改完还要注意什么" },
      { role: "assistant", text: "注意别只改 compose，宿主机的映射也要一起改。" },
    ],
  });
}

test("上一轮的子块失败不能算到这一轮头上", async () => {
  // 第一轮判重回「200 + 人话」：JSON 解析失败 → 拆半 → 两个叶子继续失败。
  // 第二轮换回正常裁决。同一进程，leafFailed 会一直挂着上一轮的 2。
  let judgeMode = "broken";
  let judgeCalls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      judgeCalls++;
      res.writeHead(200, { "content-type": "application/json" });
      // 正常模式：按请求里实际有几条新条目给裁决，每条都对上第一个候选。
      // 给多了会「一条都对不上」（编号越界），那本身也算判重失败。
      let payload = "好的，我看过了";
      if (judgeMode === "ok") {
        const seen = new Set();
        for (const m of body.matchAll(/【新 (\d+)】/g)) seen.add(Number(m[1]));
        const decisions = [...seen].sort((a, b) => a - b).map((n) => ({ new: n, match: 1, action: "keep" }));
        payload = JSON.stringify({ decisions });
      }
      res.end(JSON.stringify({ choices: [{ message: { content: payload } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const cfg = {
    raw: { enabled: false },
    model: {
      apiKey: "k",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      name: "judge-baseline",
      provider: "openai",
      wire: "openai",
      retries: 0,
      timeoutMs: 2000,
    },
    extract: { minTurnChars: 5, maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 },
    // 一轮只跑一场，才能把「第一轮失败、第二轮正常」分成两次调用。
    serve: { maxSessionsPerRound: 1, maxMinutesPerRound: 60, maxMinutesPerSession: 60 },
  };

  let writes = 0;
  const store = {
    listCurrent: async () => [
      {
        id: "old-1",
        entity: "端口映射",
        brief: "端口映射按 990 改",
        text: "端口映射按 990 改，改完重启容器。",
        project: "/tmp/proj",
      },
      {
        id: "old-2",
        entity: "端口映射",
        brief: "宿主机映射一起改",
        text: "宿主机映射要跟 compose 一起改，别只改一边。",
        project: "/tmp/proj",
      },
    ],
    docIds: async () => ({ notebook: "box", months: {}, entries: "e", entities: "n", pending: "p" }),
    ensureGroupAnchor: async () => "",
    supersede: async () => {},
    writeEntry: async () => {
      writes++;
      return { id: `new-${writes}` };
    },
  };
  const extract = async () => ({
    entries: [
      { entity: "端口映射", text: "端口映射按 1000 改，改完重启容器", brief: "端口映射按 1000 改", type: "fact", from: 1, to: 2 },
      { entity: "端口映射", text: "宿主机映射也要一起改", brief: "宿主机映射一起改", type: "fact", from: 3, to: 4 },
    ],
    mode: "model",
    batches: 1,
    usage: { prompt: 0, completion: 0 },
    coveredThrough: null,
  });

  try {
    writeFileSync(join(INBOX_DIR, "sess-a.json"), session("a"));
    const first = await processQueue({
      useModel: true,
      deps: { cfg, sy: {}, store, extract },
      maxSessionMs: 60_000,
      maxDedupeMs: 5_000,
      maxMs: 60_000,
    });
    assert.equal(first.unjudged, 1, "第一轮判重坏掉，必须报没判重");
    assert.equal(writes, 0, "第一轮一条都不许写");

    // 第二轮：新的会话，判重恢复正常。
    judgeMode = "ok";
    writeFileSync(join(INBOX_DIR, "sess-b.json"), session("b"));
    const before = writes;
    const second = await processQueue({
      useModel: true,
      deps: { cfg, sy: {}, store, extract },
      maxSessionMs: 60_000,
      maxDedupeMs: 5_000,
      maxMs: 60_000,
    });

    assert.equal(second.unjudged, 0, "上一轮的子块失败不能算到这一轮：否则一次抖动之后永久停写");
    assert.ok(writes > before, "判重正常了就该写进去");
    assert.ok(judgeCalls >= 3, "第一轮拆过叶子，第二轮正常调用过");
  } finally {
    server.close();
  }
});
