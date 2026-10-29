/**
 * 模型调用层的回归测试：全走本地假接口，不发真请求、不花钱。
 *
 * 这几条都是"静默出错"型的坑：429 不重试会让整段会话降级；response_format 被拒
 * 不回落会让抽取出空；401 反复重试只是把同一个错误写三遍。
 *
 * 跑：npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 先把 HOME 挪走：usage.jsonl 会写到 ~/.siyuan-mem 下，别污染真实用量。
process.env.HOME = mkdtempSync(join(tmpdir(), "siyuan-mem-test-"));

const { chat, usageToday } = await import("../src/llm.mjs");
const { extractEntries } = await import("../src/extract.mjs");

let hit = 0;
let scenario = "ok";
let sawJsonMode = false;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hit++;
    const parsed = JSON.parse(body || "{}");
    if (parsed.response_format) sawJsonMode = true;
    const send = (code, obj, headers = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };

    if (scenario === "auth") return send(401, { error: { message: "invalid api key" } });
    if (scenario === "retry" && hit === 1) {
      return send(429, { error: { message: "rate limited" } }, { "Retry-After": "1" });
    }
    if (scenario === "nojson" && parsed.response_format) {
      return send(400, { error: { message: "response_format is not supported by this model" } });
    }
    if (scenario === "always500") return send(503, { error: { message: "upstream down" } });

    const content =
      scenario === "extract"
        ? JSON.stringify({
            entries: [
              { text: "定下来用京东京造风盾500当通勤软壳", entity: "风盾500", type: "decision", confidence: 5 },
              { text: "冷水加洗衣凝珠可以机洗，单独装洗衣袋", entity: "清洗", type: "fact", confidence: 4 },
            ],
          })
        : JSON.stringify({ ok: true });

    send(200, {
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    });
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
test.after(() => server.close());

const cfg = {
  model: {
    provider: "custom",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-key",
    name: "mock",
    jsonMode: true,
    timeoutMs: 5000,
  },
};
const msgs = [{ role: "user", content: "hi" }];

test("429 会按 Retry-After 重试并成功", async () => {
  hit = 0;
  scenario = "retry";
  const t0 = Date.now();
  const r = await chat(cfg, { messages: msgs, tag: "retry" });
  assert.equal(hit, 2, "SDK 应该自动重试一次");
  assert.ok(Date.now() - t0 >= 900, "应该真的等过 Retry-After");
  assert.match(r.text, /ok/);
});

test("response_format 被 400 拒绝时自动回退成纯提示词", async () => {
  hit = 0;
  sawJsonMode = false;
  scenario = "nojson";
  const r = await chat(cfg, { messages: msgs, json: true, tag: "nojson" });
  assert.match(r.text, /ok/);
  assert.equal(hit, 2, "应该打了两次：一次带 json 模式，一次不带");
  assert.ok(sawJsonMode, "第一次必须真的带过 response_format");
});

test("401 一次就抛，不浪费重试", async () => {
  hit = 0;
  scenario = "auth";
  await assert.rejects(() => chat(cfg, { messages: msgs }), /HTTP 401/);
  assert.equal(hit, 1);
});

test("5xx 会重试到上限后抛错", async () => {
  hit = 0;
  scenario = "always500";
  const two = { model: { ...cfg.model, retries: 2 } };
  await assert.rejects(() => chat(two, { messages: msgs }), /模型调用失败/);
  assert.equal(hit, 3, "1 次首试 + 2 次重试");
});

test("抽取整链：JSON 对象里的 entries 能解析，usage 能累加", async () => {
  hit = 0;
  scenario = "extract";
  const ex = [{ q: "通勤十公里穿什么裤子", a: "选风盾500，里面加压缩裤。" }];
  const out = await extractEntries(cfg, ex, { useModel: true });
  assert.equal(out.mode, "model");
  assert.deepEqual(out.entries.map((e) => e.entity), ["风盾500", "清洗"]);
  assert.deepEqual(out.usage, { prompt: 120, completion: 30 });
});

test("用量按天记账，能从文件读回来", () => {
  const u = usageToday();
  assert.ok(u.calls >= 2, `记账应该有记录，实际 ${JSON.stringify(u)}`);
  assert.ok(u.prompt > 0);
});
