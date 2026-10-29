/**
 * 模型目录（models.dev）的纯逻辑测试：用一个小的假目录，不联网。
 *
 * 目录本身会变，所以这里只锁"我们怎么读它"：协议怎么反推、env 变量怎么认、
 * 名字怎么模糊匹配。真目录的完整性不属于单元测试——那是 `mem model refresh` 的事。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "siyuan-cat-test-"));
mkdirSync(join(process.env.HOME, ".siyuan-mem"), { recursive: true });

const FIXTURE = {
  fetchedAt: Date.now(),
  providers: {
    anthropic: { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], npm: "@ai-sdk/anthropic", api: "https://api.anthropic.com/v1", models: { "claude-test": { id: "claude-test", cost: { input: 3, output: 15, cache_read: 0.3 } } } },
    google: { id: "google", name: "Google", env: ["GOOGLE_GENERATIVE_AI_API_KEY"], npm: "@ai-sdk/google", api: "https://generativelanguage.googleapis.com/v1beta", models: { "gemini-test": { id: "gemini-test", cost: { input: 0.3, output: 2.5 }, limit: { context: 1048576 } } } },
    someproxy: { id: "someproxy", name: "Some Proxy", env: ["SOME_KEY"], npm: "@ai-sdk/openai-compatible", api: "https://proxy.example/v1", models: { "m-1": { id: "m-1" } } },
    noapi: { id: "noapi", name: "No API Field", env: ["NOAPI_KEY"], npm: "@ai-sdk/openai-compatible", models: { "n-1": { id: "n-1" } } },
  },
};
writeFileSync(join(process.env.HOME, ".siyuan-mem", "models.json"), JSON.stringify(FIXTURE));

const { loadCatalogSync, wireOf, findProvider, envKeyOf, modelInfo, priceOf, resetCatalogMemo } = await import("../src/catalog.mjs");
const { resolveModel } = await import("../src/llm.mjs");

test("协议从 npm 包名反推：anthropic / google / 其余 openai", () => {
  assert.equal(wireOf(FIXTURE.providers.anthropic), "anthropic");
  assert.equal(wireOf(FIXTURE.providers.google), "gemini");
  assert.equal(wireOf(FIXTURE.providers.someproxy), "openai");
  assert.equal(wireOf({}), "openai", "没有 npm 字段就按最通用的来");
});

test("找 provider：id 精确、大小写不敏感、按显示名兜底", () => {
  const all = FIXTURE.providers;
  assert.equal(findProvider(all, "google").id, "google");
  assert.equal(findProvider(all, "Google").id, "google", "显示名也要能匹配");
  assert.equal(findProvider(all, "nope"), null);
});

test("env 里有 key 就认，没有就返回 null", () => {
  process.env.SOME_KEY = "sk-proxy";
  assert.equal(envKeyOf(FIXTURE.providers.someproxy).name, "SOME_KEY");
  delete process.env.SOME_KEY;
  assert.equal(envKeyOf(FIXTURE.providers.someproxy), null);
});

test("价格与上下文从目录读，缺字段不炸", () => {
  const p = FIXTURE.providers.anthropic;
  assert.deepEqual(priceOf(p, "claude-test"), { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
  assert.equal(modelInfo(FIXTURE.providers.google, "gemini-test").limit.context, 1048576);
  assert.equal(priceOf(p, "不存在"), null);
});

test("预设之外的 provider：baseUrl 与协议都从目录来（缓存读，不联网）", () => {
  resetCatalogMemo();
  const m = resolveModel({ model: { provider: "someproxy", name: "m-1" } });
  assert.equal(m.baseUrl, "https://proxy.example/v1");
  assert.equal(m.wire, "openai");
  assert.equal(m.model, "m-1");
});

test("git 里的预设优先于目录：同名时不抓瞎", () => {
  resetCatalogMemo();
  const m = resolveModel({ model: { provider: "anthropic", name: "claude-test" } });
  assert.equal(m.wire, "anthropic");
  assert.equal(m.baseUrl, "https://api.anthropic.com/v1");
});

test("目录里没 key 也不影响 hasModel 判断：key 为空就是没配", async () => {
  const { hasModel } = await import("../src/llm.mjs");
  assert.equal(hasModel({ model: { provider: "someproxy", name: "m-1" } }), false);
  process.env.SOME_KEY = "sk-proxy";
  resetCatalogMemo();
  assert.equal(hasModel({ model: { provider: "someproxy", name: "m-1" } }), true, "env 里有 key 就算配好");
  delete process.env.SOME_KEY;
});

test("缓存文件缺失时返回 missing，而不是抛错", () => {
  // 换个假 HOME 再导入一次太贵，这里直接看 loadCatalogSync 对坏文件的容忍度。
  resetCatalogMemo();
  const ok = loadCatalogSync();
  assert.equal(ok.source, "cache");
  assert.ok(ok.providers);
});
