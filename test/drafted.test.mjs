/**
 * 跨批传递「已抽条目」的端到端回归。
 *
 * 起一个假的模型接口把请求体记下来——纯函数测试只能验拼装，验不了
 * extractEntries 里那个 drafted 数组有没有真的被累积、有没有真的塞进 system。
 * 这条链路一断，表现是「重复条目又多起来了」，但日志上完全正常。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { extractEntries, planBatches } from "../src/core/extract.mjs";

/** 起一个假的 OpenAI 兼容接口，每批回一条不同 brief 的条目。 */
async function withFakeModel(fn) {
  const seen = [];
  let round = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      seen.push(parsed.messages?.find((m) => m.role === "system")?.content ?? "");
      round++;
      const payload = {
        entries: [
          {
            brief: `第 ${round} 批的结论摘要`,
            text: `第 ${round} 批抽出来的正文，长度足够截到四十字之后，用来确认截断点没跑偏。后面是凑字数用的尾巴。`,
            entity: "验证项目",
            type: "fact",
            confidence: 3,
          },
        ],
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(payload) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = {
    model: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "test",
      name: "fake",
      wire: "openai",
      provider: "openai",
      jsonMode: true,
      timeoutMs: 5000,
      retries: 0,
    },
    // 预算写死：这条测试验的是「跨批传递」，不是默认预算多少。
    // 跟着默认值走的话，哪天把批次放大到 38000 字，这里就只剩一批，测试自己失效了。
    extract: { maxCharsPerCall: 16000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200 },
  };
  try {
    return await fn({ cfg, seen });
  } finally {
    server.close();
  }
}

// 每批都塞过 16000 字预算，逼 planBatches 切两批。
const long = (n) => `第 ${n} 批的对话内容。${"这里是一些填充文字，用来占满单批预算。".repeat(500)}`;
const exchanges = [
  { q: long(1), a: "好的", from: 1, to: 1 },
  { q: long(2), a: "收到", from: 2, to: 2 },
];

test("第二批的 prompt 带上第一批抽出来的条目", async () => {
  await withFakeModel(async ({ cfg, seen }) => {
    assert.equal(planBatches(exchanges, 16000).length, 2, "前提：应该切成两批");
    await extractEntries(cfg, exchanges, { useModel: true, entityShot: [] });

    assert.equal(seen.length, 2, `应该调用两次，实际 ${seen.length}`);
    // 第一批前面本来就没有东西，带上这一段只会平白拉长 prompt。
    assert.ok(!seen[0].includes("前面几批"), "第一批不该带已记条目段");
    assert.ok(seen[1].includes("第 1 批的结论摘要"), "第二批没带上第一批的 brief");
    assert.ok(seen[1].includes("第 1 批抽出来的正文"), "第二批没带上第一批的正文开头");
  });
});

test("正文只截 40 字，不把整段搬进下一批", async () => {
  await withFakeModel(async ({ cfg, seen }) => {
    await extractEntries(cfg, exchanges, { useModel: true, entityShot: [] });
    assert.ok(!seen[1].includes("凑字数用的尾巴"), "正文没有按 40 字截断");
  });
});

test("已记条目段只占很小一截，不是把正文再送一遍", async () => {
  await withFakeModel(async ({ cfg, seen }) => {
    await extractEntries(cfg, exchanges, { useModel: true, entityShot: [] });
    const grow = seen[1].length - seen[0].length;
    // 一条 40 字的已记条目加规则文本，三百字上下。上千就说明截断没生效。
    assert.ok(grow > 100 && grow < 500, `system 涨了 ${grow} 字，超出预期`);
  });
});
