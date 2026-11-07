/**
 * 一轮只能有一个在跑。
 *
 * 这条不是洁癖：面板上点「跑一轮」走的是和定时轮完全不同的入口，两条流各跑各的
 * `processQueue`，会同时往同一批块上 append、同时改 supersede 标记。思源没有行级
 * 合并，撞上去不报错，只表现为"偶尔有条目写了一半"或"旧条目永远停在 current"。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { beginRound, roundStatus } from "../src/center/serve.mjs";
import { startUi } from "../src/center/ui.mjs";
import { willUseModel } from "../src/center/extract.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("同时起两轮：第二个被明确拒掉，不是排队也不是静默叠加", async () => {
  assert.equal(roundStatus().running, false);

  const slow = beginRound("定时", async () => {
    await sleep(120);
    return { written: 1 };
  });

  // 在跑的时候状态要能看出来：面板靠它把按钮灰掉。
  assert.equal(roundStatus().running, true);
  assert.equal(roundStatus().kind, "定时");

  assert.throws(() => beginRound("面板", async () => ({})), /有一轮正在跑/);

  assert.deepEqual(await slow, { written: 1 });
  // 跑完要放行，否则一次点击就能把服务永久卡住。
  assert.equal(roundStatus().running, false);

  const again = await beginRound("面板", async () => "ok");
  assert.equal(again, "ok");
});

test("一轮抛异常也要放行，不能把单飞锁死在里面", async () => {
  await assert.rejects(() => beginRound("定时", async () => { throw new Error("炸了"); }), /炸了/);
  assert.equal(roundStatus().running, false);
});

test("面板的「跑一轮」撞上正在跑的那一轮，返回 409 而不是 500", async () => {
  const ui = startUi({
    port: 0,
    runRound: () => beginRound("定时", async () => {
      await sleep(150);
      return { written: 3 };
    }),
  });
  for (let i = 0; i < 100 && !ui.listening; i++) await sleep(10);
  assert.ok(ui.port > 0, "应该选到一个空闲端口");

  const post = (u) => fetch(u + "/api/run", { method: "POST" });
  const first = post(ui.url);
  await sleep(30); // 让第一个请求真的进到 beginRound 里
  const second = await post(ui.url);

  assert.equal(second.status, 409, "同时第二轮应是 409（现在不能跑），不是 500");
  const body = await second.json();
  assert.match(body.error, /有一轮正在跑/);

  const ok = await first;
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).written, 3);

  await ui.close();
});

test("key 来自环境变量或 keyless provider 时，必须走模型，不能悄悄退回规则抽取", () => {
  // 这条是回归：旧实现判的是 Boolean(cfg.model.apiKey)，只认写在 config 里的 key。
  // 于是 keyless（本机 ollama）和"key 在环境变量里"两种情况都会静默降级成规则抽取，
  // 写进库里全是半句话，而启动时 assertModel 用的是 hasModel，说"模型没问题"。
  const keyless = { model: { provider: "ollama", name: "qwen2.5:14b" } };
  assert.equal(willUseModel(keyless, true), true);
  assert.equal(willUseModel(keyless, undefined), true);

  // 显式 --no-model 仍然要能关掉。
  assert.equal(willUseModel(keyless, false), false);

  // 环境变量 key：models.dev 目录里给的那种。
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-for-unit-test";
  try {
    const viaEnv = { model: { provider: "openai", name: "gpt-5-mini" } };
    assert.equal(willUseModel(viaEnv, true), true);
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }

  // 真没配：useModel 为真时应当为 false（上层 assertModel 会拦住，这里只是不假装有）。
  const none = { model: { provider: "custom", baseUrl: "", name: "" } };
  assert.equal(willUseModel(none, true), false);
});
