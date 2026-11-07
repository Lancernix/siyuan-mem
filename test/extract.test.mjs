import { test } from "node:test";
import assert from "node:assert/strict";
import { clampText, parseEntries, draftedSection } from "../src/core/extract.mjs";

test("短条目原样返回", () => {
  assert.equal(clampText("订货系统 用 TS 6.0.3。"), "订货系统 用 TS 6.0.3。");
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

  const ok = parseEntries('{"entries":[{"text":"订货系统 的接口统一成扁平 REST","brief":"扁平 REST"}]}');
  assert.equal(ok.ok, true);
  assert.equal(ok.entries.length, 1);
});

/* ---------- 跨批传递「已记录条目」 ---------- */

test("没有已记条目时，拼出来的段落是空的", () => {
  // 第一批不该被这段拖长：它本来就没有「前面」。
  assert.equal(draftedSection([]), "");
  assert.equal(draftedSection(undefined), "");
});

test("已记条目带 brief 和正文前 40 字", () => {
  const block = draftedSection([
    {
      entity: "siyuan-mem",
      brief: "静默阈值改成 30 分钟",
      text: "判断会话结束的静默阈值从 3 分钟改成 30 分钟，否则正在进行的聊天会被当成已结束会话切片。改动下一轮生效。",
    },
  ]);
  assert.ok(block.includes("静默阈值改成 30 分钟"));
  // 40 字之后的部分不该出现：那是正文，不是提示。
  assert.ok(!block.includes("改动下一轮生效"));
});

test("已记条目按时间正序喂，不按取用顺序", () => {
  // 从新往旧取是预算控制的方便做法，但喂给模型必须是正序——
  // 倒序进去，它判断「哪条更完整」时会拿后面的当基线。
  const block = draftedSection([
    { entity: "A", brief: "第一件事", text: "第一件事的正文" },
    { entity: "B", brief: "第二件事", text: "第二件事的正文" },
    { entity: "C", brief: "第三件事", text: "第三件事的正文" },
  ]);
  assert.ok(block.indexOf("第一件事") < block.indexOf("第三件事"));
});

test("超出预算时丢掉最早的，保留最近的", () => {
  // 离得越近越可能被重复讲；早些的还有 converge 兜底。
  const many = Array.from({ length: 200 }, (_, i) => ({
    entity: `话题${i}`,
    brief: `${"短".repeat(20)}${i}`,
    text: `${"正文".repeat(20)}${i}`,
  }));
  const block = draftedSection(many);
  assert.ok(block.length < 6000, `预算没兜住：${block.length} 字`);
  assert.ok(block.includes("话题199"));
  assert.ok(!block.includes("话题0｜"));
});
