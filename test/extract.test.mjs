import { test } from "node:test";
import assert from "node:assert/strict";
import { clampText, parseEntries } from "../src/extract.mjs";

test("短条目原样返回", () => {
  assert.equal(clampText("MiniWMS 用 TS 6.0.3。"), "MiniWMS 用 TS 6.0.3。");
});

test("超长在句末截断，不劈词", () => {
  const s = `${"甲".repeat(200)}。${"乙".repeat(200)}。`;
  const out = clampText(s, 300);
  assert.equal(out, `${"甲".repeat(200)}。`);
});

test("没有句号时退到分号", () => {
  const s = `${"甲".repeat(150)}；${"乙".repeat(200)}`;
  const out = clampText(s, 300);
  assert.ok(out.endsWith("；"));
  assert.ok(out.length <= 300);
});

test("连标点都没有时硬切并补句号", () => {
  const out = clampText("甲".repeat(400), 300);
  assert.equal(out.length, 301);
  assert.ok(out.endsWith("。"));
});

test("坏 JSON 要报 ok:false，不能和「合法空结果」混为一谈", () => {
  // 这两种在旧实现里都是 []，于是模型吐了半截 JSON 会被当成
  // "这场对话没什么可记的"，零条、不重试、正常归档——记忆静默丢掉。
  const bad = parseEntries("抱歉，我无法完成");
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.entries, []);

  const truncated = parseEntries('{"entries":[{"text":"半截');
  assert.equal(truncated.ok, false);

  const empty = parseEntries('{"entries":[]}');
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.entries, []);

  const ok = parseEntries('{"entries":[{"text":"MiniWMS 的接口统一成扁平 REST","brief":"扁平 REST"}]}');
  assert.equal(ok.ok, true);
  assert.equal(ok.entries.length, 1);
});
