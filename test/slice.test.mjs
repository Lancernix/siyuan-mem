/**
 * 增量切片：一个文件该从第几轮开始切。
 *
 * 这函数判错不会报错，只会安静地少推一段内容——审查实测过三版 A→B→C，
 * C 版永久丢失，而且偏移被消费掉，下一轮连重试的机会都没有。
 */
import test from "node:test";
import assert from "node:assert/strict";

const { slicePlan } = await import("../src/util/config.mjs");

test("第一次见到这个文件：从 0 开始", () => {
  assert.deepEqual(slicePlan(undefined, { size: 100, mtime: 1 }, 5), { from: 0, rewritten: false });
});

test("正常追加：从上次的轮数接着切", () => {
  const prev = { bytes: 100, mtimeMs: 1000, turns: 5 };
  assert.deepEqual(slicePlan(prev, { size: 200, mtime: 2000 }, 9), { from: 5, rewritten: false });
});

test("同尺寸重写：整份重读", () => {
  const prev = { bytes: 100, mtimeMs: 1000, turns: 5 };
  assert.deepEqual(slicePlan(prev, { size: 100, mtime: 2000 }, 5), { from: 0, rewritten: true });
});

test("变长但轮数没涨（改了回答内容）：也要整份重读", () => {
  // 这是审查实测丢内容的那条：体积大了，旧判断认为是追加，
  // slice(5) 是空的，随后把新偏移写回去，C 版就再也推不上来了。
  const prev = { bytes: 100, mtimeMs: 1000, turns: 5 };
  assert.deepEqual(slicePlan(prev, { size: 180, mtime: 2000 }, 5), { from: 0, rewritten: true });
});

test("老记录没 mtimeMs：退回只比体积和轮数，别把「不知道」当成「变了」", () => {
  const prev = { bytes: 100, turns: 5 };
  assert.deepEqual(slicePlan(prev, { size: 100, mtime: 9999 }, 5), { from: 5, rewritten: false });
  assert.deepEqual(slicePlan(prev, { size: 90, mtime: 9999 }, 5), { from: 0, rewritten: false });
});
