/** 来源归一：白名单、大小写、伪造值、缺省值。 */
import test from "node:test";
import assert from "node:assert/strict";
const { normalizeSource, RECALL_SOURCES } = await import("../src/util/source.mjs");

test("四个真实入口原样保留，大小写与空白归一", () => {
  assert.deepEqual([...RECALL_SOURCES], ["mcp", "cli", "ui", "api"]);
  for (const s of RECALL_SOURCES) {
    assert.equal(normalizeSource(s), s);
    assert.equal(normalizeSource(` ${s.toUpperCase()} `), s);
  }
});

test("伪造、过长、拼错的来源并到 fallback，不新造桶", () => {
  assert.equal(normalizeSource("forged", "api"), "api");
  assert.equal(normalizeSource("x".repeat(500), "api"), "api");
  assert.equal(normalizeSource(null, "api"), "api");
  assert.equal(normalizeSource(undefined), "unknown");
  assert.equal(normalizeSource("unknown", "api"), "api", "显式 unknown 不特殊，按缺省算");
});

test("fallback 自己也要合法，否则退回 unknown", () => {
  assert.equal(normalizeSource("forged", "also-forged"), "unknown");
});
