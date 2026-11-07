/**
 * 配置里的笔记本该解析成哪个 id。
 *
 * 这段逻辑以前只认名字，改一次名就得把中心和边缘的配置全改一遍；改名又是常事
 * （库里的 "90-记忆" 和"临时对照库"需要一个明确的区别）。所以现在两种都认：
 * 配了 id 优先用 id，id 失效再退回名字。
 */
import test from "node:test";
import assert from "node:assert/strict";

const { resolveNotebookId } = await import("../src/shared/siyuan.mjs");

const fake = (list) => ({ listNotebooks: async () => list });

test("配了 id 且库里存在：直接用 id，不去比名字", async () => {
  const sy = fake([{ id: "aaa", name: "改过的名字" }, { id: "bbb", name: "90-记忆" }]);
  const id = await resolveNotebookId(sy, { siyuan: { notebookId: "aaa", notebook: "90-记忆" } });
  assert.equal(id, "aaa");
});

test("配了 id 但库里没有（删了重建）：退回按名字找", async () => {
  const sy = fake([{ id: "new-id", name: "90-记忆" }]);
  const id = await resolveNotebookId(sy, { siyuan: { notebookId: "gone", notebook: "90-记忆" } });
  assert.equal(id, "new-id");
});

test("没配 id：按名字找", async () => {
  const sy = fake([{ id: "bbb", name: "90-记忆" }]);
  const id = await resolveNotebookId(sy, { siyuan: { notebook: "90-记忆" } });
  assert.equal(id, "bbb");
});

test("名字也找不到：报错里带上库里有什么，别只说找不到", async () => {
  const sy = fake([{ id: "x", name: "工作随记" }, { id: "y", name: "生活切片" }]);
  await assert.rejects(
    () => resolveNotebookId(sy, { siyuan: { notebook: "90-记忆" } }),
    /找不到笔记本「90-记忆」.*工作随记/
  );
});

test("两个都没配：明确说要配哪一个", async () => {
  await assert.rejects(() => resolveNotebookId(fake([]), { siyuan: {} }), /notebook/);
});
