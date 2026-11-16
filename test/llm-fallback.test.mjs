/**
 * 多模型 fallback：主力挂了自动换备用。
 *
 * 2026-11-16 那次事故的教训——订阅过期十天，谁都没发现，因为单点配置没有备份，
 * 抽取只能整轮停。链式配置的意义不是「多花钱」，是「一家挂的时候不至于全线停摆」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 不给临时 HOME 的话，这里每跑一次都往真实的 ~/.siyuan-mem/usage.jsonl 里
// 写一条 model:"fake"——2026-11-16 查出来时那里已经堆了 2400 多条假记录，
// mem status 的「今日调用/失败」全被带偏了。
process.env.HOME = mkdtempSync(join(tmpdir(), "mem-llm-fallback-"));

const { chat, resolveChain, hasModel } = await import("../src/util/llm.mjs");

/** 起一个假端点：ok=true 正常回，否则按 status 报错。 */
async function fakeModel({ ok = true, status = 401, body = { error: { message: "subscription has expired" } }, reply = '{"ok":true}' } = {}) {
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls++;
      if (!ok) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: reply } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, calls: () => calls, close: () => server.close() };
}

const ask = (cfg) =>
  chat(cfg, {
    messages: [{ role: "user", content: "说点什么" }],
    tag: "test",
  });

test("主力 401 时自动换备用，结果来自备用那家", async () => {
  const dead = await fakeModel({ ok: false, status: 401 });
  const alive = await fakeModel({ ok: true, reply: "备用家的回答" });
  try {
    const cfg = {
      model: {
        provider: "openai",
        baseUrl: dead.url,
        apiKey: "k",
        name: "primary",
        wire: "openai",
        retries: 0,
        timeoutMs: 3000,
        fallback: [{ baseUrl: alive.url, name: "backup" }],
      },
    };
    assert.equal(resolveChain(cfg).length, 2, "两家都要在链上");
    const r = await ask(cfg);
    assert.equal(r.text, "备用家的回答");
    assert.equal(r.model, "backup");
    assert.equal(r.switched, true, "要能看出来是换过家的");
    assert.equal(dead.calls(), 1);
    assert.equal(alive.calls(), 1);
  } finally {
    dead.close();
    alive.close();
  }
});

test("全挂时把每家为什么挂都写进错误里，且都算配置问题才判 fatal", async () => {
  const a = await fakeModel({ ok: false, status: 401 });
  const b = await fakeModel({ ok: false, status: 401, body: { error: { message: "model not found" } } });
  try {
    const cfg = {
      model: {
        provider: "openai",
        baseUrl: a.url,
        apiKey: "k",
        name: "primary",
        wire: "openai",
        retries: 0,
        timeoutMs: 3000,
        fallback: [{ baseUrl: b.url, name: "backup" }],
      },
    };
    await assert.rejects(
      () => ask(cfg),
      (e) => {
        assert.match(e.message, /openai\/primary/);
        assert.match(e.message, /openai\/backup/);
        assert.equal(e.fatal, true, "两家都是配置问题，上层该整轮停");
        return true;
      }
    );
  } finally {
    a.close();
    b.close();
  }
});

test("备用项继承主配置：只写 apiKey 就是「同一家换把 key」", () => {
  const cfg = {
    model: {
      provider: "openai",
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      name: "primary",
      wire: "openai",
      fallback: [{ apiKey: "another-key" }, { baseUrl: "https://b.example.com/v1", apiKey: "k2", name: "other" }],
    },
  };
  const chain = resolveChain(cfg);
  assert.equal(chain.length, 3, "主 + 两个备用");
  // 只写了 key 的那条，baseUrl 和模型名都从主力继承——不然「换把 key」得抄一堆字段。
  assert.equal(chain[1].baseUrl, "https://api.example.com/v1");
  assert.equal(chain[1].model, "primary");
  assert.equal(chain[1].apiKey, "another-key");
  assert.equal(chain[2].baseUrl, "https://b.example.com/v1");
  assert.equal(chain[2].model, "other");
  assert.equal(hasModel(cfg), true);
});

test("配不全的备用项不占位：主配置本身没 key 时，缺 key 的备用也要跳过", () => {
  const cfg = {
    model: {
      provider: "openai",
      baseUrl: "https://api.example.com/v1",
      name: "primary",
      wire: "openai",
      fallback: [{ name: "没 key" }, { apiKey: "k4", name: "有 key" }],
    },
  };
  const chain = resolveChain(cfg);
  assert.equal(chain.length, 1, "只有那条带 key 的能进链");
  assert.equal(chain[0].model, "有 key");
  assert.equal(hasModel(cfg), true);
});

test("只有备用项齐全时也算配好了模型（不至于退回规则抽取）", () => {
  const cfg = {
    model: {
      provider: "openai",
      baseUrl: "https://api.example.com/v1",
      name: "primary",
      wire: "openai",
      fallback: [{ apiKey: "k3" }],
    },
  };
  assert.equal(resolveChain(cfg).length, 1);
  assert.equal(hasModel(cfg), true);
});
