/**
 * 提示词可覆盖：能改、能退、版本会变。
 *
 * 这几条不是"功能测试"，是防"悄悄坏"：提示词改坏了从来不报错，
 * 只会让随后几周的条目悄悄变差，而且日志上看不出提示词换过。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "mem-prompt-"));

const { checkPrompt, resolvePrompt, savePrompt, resetPrompt, history, PROMPT_PATH } = await import("../src/prompt.mjs");

const BUILTIN = `你是记忆整理器。只输出 JSON。字段：entries[].text / brief / entity。
一条记忆 2-4 句，话题用名词短语。`.padEnd(500, "　");

test("没有覆盖时用内置，来源标 builtin", () => {
  const r = resolvePrompt(BUILTIN, "");
  assert.equal(r.source, "builtin");
  assert.equal(r.text, BUILTIN);
});

test("保存之后来源变 user，版本号跟着变", () => {
  const before = resolvePrompt(BUILTIN, "").version;
  const custom = `${BUILTIN}\n额外要求：条目不超过 200 字。`;
  const r = savePrompt(custom);
  assert.equal(r.backup, "", "第一次保存没有旧版可备份");
  const after = resolvePrompt(BUILTIN, "");
  assert.equal(after.source, "user");
  assert.match(after.text, /不超过 200 字/);
  assert.notEqual(after.version, before, "改了提示词，版本号必须变");
});

test("第二次保存会备份旧版，历史里能看到", () => {
  savePrompt(`${BUILTIN}\n第二版`);
  const list = history();
  assert.ok(list.length >= 1, `应该有备份：${list.join(",")}`);
  const first = readFileSync(join(PROMPT_PATH, "..", list.at(-1)), "utf8");
  assert.match(first, /不超过 200 字/, "备份的应该是上一版");
});

test("reset 回到内置，且覆盖文件被删掉（备份留着）", () => {
  const r = resetPrompt();
  assert.equal(r.removed, true);
  assert.ok(r.backup);
  assert.equal(resolvePrompt(BUILTIN, "").source, "builtin");
  assert.equal(readdirSync(join(PROMPT_PATH, "..")).some((f) => f === "entries.md"), false);
});

test("体检：缺 json 字样会被点出来（火山会直接 400）", () => {
  const w = checkPrompt("你是整理器，请输出结构化内容，字段 entries。".padEnd(500, "　"));
  assert.ok(w.some((x) => /json/.test(x)), w.join("；"));
});

test("体检：太短、缺字段也会提醒", () => {
  const w = checkPrompt("只输出 JSON");
  assert.ok(w.some((x) => /字/.test(x)), "太短应该提醒");
  assert.ok(w.some((x) => /entity/.test(x)), "缺字段应该提醒");
});

test("空提示词不许存——想恢复内置得用 reset", () => {
  assert.throws(() => savePrompt("   "), /空/);
});
