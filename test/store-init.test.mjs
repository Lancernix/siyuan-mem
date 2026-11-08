/**
 * Store.init 的两种处境：第一次跑（该建）和"笔记本不见了"（不该建）。
 *
 * 这里曾经有个很危险的退路：解析失败就 createNotebook(name)。改名或换库的时候
 * 它会静默建一本空库、把新 id 写回配置，旧记忆"凭空消失"，而且日志上一切正常。
 * 所以现在只允许"从没配过 id"的情况自动新建。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "mem-init-"));

const { Store } = await import("../src/core/store.mjs");

const cfgOf = (over = {}) => ({
  siyuan: {
    baseUrl: "http://fake:6806",
    token: "",
    notebook: "Harness-Mem",
    notebookId: "",
    docs: { entries: "01-条目", entities: "02-实体", pending: "03-实体待确认" },
    ...over,
  },
});

/** 够 init 跑完的最小假客户端。 */
function fakeSy({ notebooks = [], createId = "new-nb" } = {}) {
  const calls = { created: 0 };
  return {
    calls,
    listNotebooks: async () => notebooks,
    createNotebook: async () => {
      calls.created++;
      return createId;
    },
    docIdByHPath: async () => null,
    createDocWithMd: async (_nb, path) => `doc${path}`,
    sql: async () => [],
    updateBlock: async () => {},
  };
}

test("配过 notebookId 但对不上：报错，绝不偷偷建新库", async () => {
  const sy = fakeSy({ notebooks: [{ id: "other", name: "别的库" }] });
  const store = new Store(sy, cfgOf({ notebookId: "gone-but-configured" }));
  await assert.rejects(() => store.init(), /已经失效/);
  assert.equal(sy.calls.created, 0, "不许建新笔记本");
});

test("从没配过 id、名字也找不到：这才是第一次跑，建", async () => {
  const sy = fakeSy({ notebooks: [], createId: "first-run" });
  const store = new Store(sy, cfgOf());
  const ids = await store.init();
  assert.equal(ids.notebook, "first-run");
  assert.equal(sy.calls.created, 1);
});

test("id 在库里：直接用，不新建", async () => {
  const sy = fakeSy({ notebooks: [{ id: "keep", name: "Harness-Mem" }] });
  const store = new Store(sy, cfgOf({ notebookId: "keep" }));
  const ids = await store.init();
  assert.equal(ids.notebook, "keep");
  assert.equal(sy.calls.created, 0);
});

test("同名换了 id（笔记本删了重建）：必须报错，别把新 id 写回配置", async () => {
  // 这是上一版漏掉的主场景：resolveNb 在 id 失效时会退回按名字找，所以它不抛错，
  // 只靠 catch 判断的防呆就被绕过去了。
  const sy = fakeSy({ notebooks: [{ id: "brand-new", name: "Harness-Mem" }] });
  const store = new Store(sy, cfgOf({ notebookId: "old-gone" }));
  await assert.rejects(() => store.init(), /id 变了/);
});

test("--rebind 时接受新 id：这是人工确认过的换库", async () => {
  const sy = fakeSy({ notebooks: [{ id: "brand-new", name: "Harness-Mem" }] });
  const store = new Store(sy, cfgOf({ notebookId: "old-gone" }));
  const ids = await store.init({ rebind: true });
  assert.equal(ids.notebook, "brand-new");
});
