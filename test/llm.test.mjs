/**
 * 模型调用层的回归测试：三种协议全走本地假接口，不发真请求、不花钱。
 *
 * 这些是"静默出错"型的坑：429 不重试会让整段会话降级成规则抽取；JSON 模式被拒
 * 不回落会抽不出条目；协议拼错（system 放错位置、角色名不对、模型名没进路径）
 * 服务端只会回 400，而 400 在重试策略里是"立刻抛"，很容易被当成配置问题查半天。
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

const { chat, usageToday, resolveModel } = await import("../src/llm.mjs");
const { extractEntries } = await import("../src/extract.mjs");

let hit = 0;
let scenario = "ok";
const seen = {};

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    hit++;
    const path = req.url.split("?")[0];
    let parsed = {};
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {}
    seen.last = { path, headers: req.headers, body: parsed };
    seen[path] = seen.last;

    const send = (code, obj, headers = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };

    // ---- 另外两种协议的正常回包 ----
    if (path.endsWith("/messages")) {
      return send(200, {
        content: [{ type: "text", text: '{"ok":true}' }],
        usage: { input_tokens: 21, output_tokens: 7 },
      });
    }
    if (path.includes(":generateContent")) {
      return send(200, {
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
        usageMetadata: { promptTokenCount: 31, candidatesTokenCount: 9 },
      });
    }

    // ---- OpenAI 兼容那一路的故障场景 ----
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

const at = (base, extra = {}) => ({
  model: {
    provider: "custom",
    wire: "openai",
    baseUrl: `http://127.0.0.1:${port}${base}`,
    apiKey: "test-key",
    name: "mock",
    jsonMode: true,
    timeoutMs: 5000,
    retries: 3,
    ...extra,
  },
});
const openaiCfg = at("/v1");
const msgs = [
  { role: "system", content: "系统提示" },
  { role: "user", content: "hi" },
];

test("openai：429 会按 Retry-After 重试并成功", async () => {
  hit = 0;
  scenario = "retry";
  const t0 = Date.now();
  const r = await chat(openaiCfg, { messages: msgs, tag: "retry" });
  assert.equal(hit, 2, "应该重试过一次");
  assert.equal(r.attempts, 2);
  assert.ok(Date.now() - t0 >= 900, "应该真的等过 Retry-After");
  assert.match(r.text, /ok/);
});

test("openai：response_format 被 400 拒绝时回退成纯提示词", async () => {
  hit = 0;
  scenario = "nojson";
  const r = await chat(openaiCfg, { messages: msgs, json: true, tag: "nojson" });
  assert.match(r.text, /ok/);
  assert.equal(hit, 2, "应该打两次：一次带 json 模式，一次不带");
  assert.ok(r.jsonFallback, "应该标记发生过回退");
});

test("openai：401 一次就抛，不浪费重试", async () => {
  hit = 0;
  scenario = "auth";
  await assert.rejects(() => chat(openaiCfg, { messages: msgs }), /HTTP 401/);
  assert.equal(hit, 1);
});

test("openai：5xx 重试到上限后抛错", async () => {
  hit = 0;
  scenario = "always500";
  await assert.rejects(() => chat(at("/v1", { retries: 2 }), { messages: msgs }), /模型调用失败/);
  assert.equal(hit, 3, "1 次首试 + 2 次重试");
});

test("anthropic：system 提到顶层、max_tokens 必填、x-api-key 鉴权、content 数组解析", async () => {
  hit = 0;
  scenario = "ok";
  const cfg = at("/v1", { wire: "anthropic", jsonMode: false, name: "claude-test" });
  const r = await chat(cfg, { messages: msgs, json: true, tag: "anthropic" });
  const req = seen["/v1/messages"];
  assert.ok(req, "应该打到 /v1/messages");
  assert.equal(req.body.system, "系统提示");
  assert.equal(req.body.messages.length, 1, "system 不该留在 messages 里");
  assert.equal(req.body.messages[0].role, "user");
  assert.ok(req.body.max_tokens > 0, "max_tokens 必填");
  assert.equal(req.headers["x-api-key"], "test-key");
  assert.ok(req.headers["anthropic-version"], "要带 anthropic-version");
  assert.equal(req.body.response_format, undefined, "anthropic 没有这个字段");
  assert.equal(r.text, '{"ok":true}');
  assert.equal(r.usage.prompt, 21);
  assert.equal(r.usage.completion, 7);
  assert.equal(r.usage.cached, 0);
  assert.equal(r.wire, "anthropic");
});

test("gemini：模型名进路径、system 用 systemInstruction、responseMimeType 与 usageMetadata", async () => {
  hit = 0;
  scenario = "ok";
  const cfg = at("/v1beta", { wire: "gemini", name: "gemini-test" });
  const r = await chat(cfg, { messages: msgs, json: true, tag: "gemini" });
  const req = seen["/v1beta/models/gemini-test:generateContent"];
  assert.ok(req, "模型名应该在路径里");
  assert.equal(req.body.systemInstruction.parts[0].text, "系统提示");
  assert.equal(req.body.contents.length, 1);
  assert.equal(req.body.contents[0].role, "user");
  assert.equal(req.body.generationConfig.responseMimeType, "application/json");
  assert.equal(req.body.generationConfig.temperature, 1.0, "Gemini 3 建议保持 1.0");
  assert.equal(req.headers["x-goog-api-key"], "test-key");
  assert.equal(r.text, '{"ok":true}');
  assert.equal(r.usage.prompt, 31);
  assert.equal(r.usage.completion, 9);
  assert.equal(r.usage.cached, 0);
});

test("预设把 provider 映射到正确的协议与 JSON 能力", () => {
  assert.equal(resolveModel({ model: { provider: "anthropic" } }).wire, "anthropic");
  assert.equal(resolveModel({ model: { provider: "gemini" } }).wire, "gemini");
  assert.equal(resolveModel({ model: { provider: "deepseek" } }).wire, "openai");
  assert.equal(resolveModel({ model: { provider: "gemini" } }).jsonMode, true);
  assert.equal(resolveModel({ model: { provider: "anthropic" } }).jsonMode, false);
  assert.equal(resolveModel({ model: { provider: "deepseek" } }).model, "deepseek-v4-flash");
});

test("抽取整链：JSON 对象里的 entries 能解析，usage 能累加", async () => {
  hit = 0;
  scenario = "extract";
  const out = await extractEntries(openaiCfg, [{ q: "通勤十公里穿什么裤子", a: "选风盾500，里面加压缩裤。" }], {
    useModel: true,
  });
  assert.equal(out.mode, "model");
  assert.deepEqual(out.entries.map((e) => e.entity), ["风盾500", "清洗"]);
  assert.equal(out.usage.prompt, 120);
  assert.equal(out.usage.completion, 30);
});

test("用量按天记账，能从文件读回来", () => {
  const u = usageToday();
  assert.ok(u.calls >= 3, `记账应该有记录，实际 ${JSON.stringify(u)}`);
  assert.ok(u.prompt > 0);
});
