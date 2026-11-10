/**
 * 抽取的闸门：一场大会话不能把一轮拖到天亮。
 *
 * 2026-11-10 那几轮「3 个会话 / 86 分钟」跟思源卡不卡没关系——光抽取就跑了四十分钟：
 * 一场 384 轮的会话拆出十几批，一批一次模型调用，实测单次 113 秒、254 秒都有过。
 * 所以抽取要在**批与批之间**看表：到点就不再发下一批，已经抽出来的照常写库，
 * 剩下的轮次从队列里摘掉、下轮接着抽。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { extractEntries, planBatches } from "../src/core/extract.mjs";

async function withFakeModel(fn, { delay = 60 } = {}) {
  let calls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls++;
      const n = calls;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    entries: [
                      { brief: `第 ${n} 批结论`, text: `第 ${n} 批抽出来的正文，长度凑够四十字以上才能看出截断有没有生效，后面继续凑字数。`, entity: "验证项目", type: "fact", confidence: 3 },
                    ],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          }),
        );
      }, delay);
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
    extract: { maxCharsPerCall: 4000, maxEntriesPerBatch: 8, maxEntriesPerSession: 200, entityShotList: 0 },
  };
  try {
    return await fn({ cfg, calls: () => calls, delay });
  } finally {
    server.close();
  }
}

const long = (n) => `第 ${n} 段的对话内容。${"填充文字，用来把单批预算占满。".repeat(200)}`;
const exchanges = [1, 2, 3, 4].map((n) => ({ q: long(n), a: "好的", from: n * 2, to: n * 2 + 1 }));

test("到点就不发下一批：抽过的留着，剩下的报出来让调用方去摘", async () => {
  await withFakeModel(async ({ cfg, calls }) => {
    const total = planBatches(exchanges, 4000).length;
    assert.ok(total >= 3, `前提：应该切成三批以上，实际 ${total}`);

    // 死线设成"立刻就过"：第一批照跑（保证每轮都有进展），第二批开始前收手。
    const r = await extractEntries(cfg, exchanges, { useModel: true, entityShot: [], deadline: Date.now() });

    assert.equal(calls(), 1, `只该调用一次，实际 ${calls()}`);
    assert.equal(r.stoppedEarly, true, "要报出「到点了」，调用方才知道去摘队列");
    assert.equal(r.batches, total, "总批数照报，日志里才看得出还剩多少");
    assert.ok(r.remainingBatches >= 1, "剩下的批数要能算出来");
    assert.equal(r.coveredThrough, exchanges[0].to, "覆盖到第一批的最后一轮");
    assert.ok(r.entries.length >= 1, "已经抽出来的条目要带回去写库");
  });
});

test("没设死线时一批都不少：默认行为不变", async () => {
  await withFakeModel(async ({ cfg, calls }) => {
    const total = planBatches(exchanges, 4000).length;
    const r = await extractEntries(cfg, exchanges, { useModel: true, entityShot: [] });
    assert.equal(r.stoppedEarly, false);
    assert.equal(calls(), total, `应该把 ${total} 批全跑完`);
    assert.equal(r.coveredThrough, exchanges[exchanges.length - 1].to, "覆盖到最后一轮");
  });
});

test("时间在调用中途到点：算收手，不算失败——不能把整场判成「抽取不完整」", async () => {
  // 这条挡的是一个很贵的坑：预算到点掐断的那一批如果记成失败，整场就是 partial，
  // 原文留在队列里重来，试满三次进 dead/——而那半场一行都没处理错，白丢。
  await withFakeModel(
    async ({ cfg }) => {
      const r = await extractEntries(cfg, exchanges, { useModel: true, entityShot: [], deadline: Date.now() + 700 });
      assert.equal(r.stoppedEarly, true, "要到点收手");
      assert.equal(r.mode, "model", "掐断的那一批不能算失败");
      assert.equal(r.error, undefined, "不该报「N 批失败」");
      assert.equal(r.coveredThrough, exchanges[0].to, "只覆盖真正抽出来的那批，被掐断的不算");
    },
    { delay: 400 },
  );
});

test("长问答被拆段时，只看了前几段不能把整轮算成覆盖", async () => {
  // 单条问答超过 maxCharsPerCall 会被按段落切成多段，这些段共用同一对 from/to。
  // 覆盖点按「轮」推进，只处理了第 1 段就推整轮 -> 调用方把整轮从队列摘掉，
  // 剩下几段再也没人抽，而日志上写着「前 N 轮已写进库」。
  const huge = ("这是一段用来把单批预算占满的填充内容。" + "\n\n").repeat(200);
  const one = [{ q: huge, a: "好", from: 1, to: 2 }];
  await withFakeModel(async ({ cfg }) => {
    const total = planBatches(one, 4000).length;
    assert.ok(total >= 2, `前提：这一轮要被拆成两批以上，实际 ${total}`);
    // 死线设成"立刻就过"：第一批照跑（这段长问答的前几段），之后收手。
    const r = await extractEntries(cfg, one, { useModel: true, entityShot: [], deadline: Date.now() });
    assert.equal(r.stoppedEarly, true);
    assert.equal(
      r.coveredThrough,
      null,
      "这一轮只看了前几段，整轮不能算覆盖——算成覆盖，剩下几段就永远没人抽了",
    );
  });
});
