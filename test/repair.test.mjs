/**
 * 补偿账本与参数解析。
 *
 * 账本这条链只在"写新条目成功、标旧条目失败"时才会走，平时看不见；
 * 一旦它本身坏了，库里就是两条 current 并存，而且没有任何报错。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "../src/args.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/** 在家目录被换掉的环境里跑一段脚本，返回它的 JSON 输出。 */
function runWithHome(code) {
  const home = mkdtempSync(join(tmpdir(), "mem-repair-"));
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: ROOT,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return { home, out: JSON.parse(out.trim()) };
}

test("记一笔欠账、补完、销账", () => {
  const { home, out } = runWithHome(`
    import { notePending, loadPending, flushPending } from "./src/repair.mjs";
    notePending({ old: "aaa", new: "bbb", entity: "mcp-adapter" });
    notePending({ old: "aaa", new: "ccc", entity: "mcp-adapter" }); // 同一个 old 只留最后一次
    const before = loadPending();
    const calls = [];
    const store = {
      statusOf: async (id) => (id === "aaa" ? "current" : ""),
      supersede: async (a, b) => { calls.push([a, b]); },
    };
    const fixed = await flushPending(store, {});
    console.log(JSON.stringify({ before, fixed, calls, after: loadPending() }));
  `);
  assert.equal(out.before.length, 1, "同一个 old 不能记两条");
  assert.equal(out.before[0].new, "ccc", "后记的应该覆盖先记的");
  assert.equal(out.fixed, 1);
  assert.deepEqual(out.calls, [["aaa", "ccc"]]);
  assert.equal(out.after.length, 0, "补完要销账，否则每轮都会重试同一笔");
  assert.ok(existsSync(join(home, ".siyuan-mem")), "应该自己把目录建出来");
});

test("旧块已经不在了、或者已经是 superseded，就销账不再重试", () => {
  const { out } = runWithHome(`
    import { notePending, loadPending, flushPending } from "./src/repair.mjs";
    notePending({ old: "gone", new: "n1" });
    notePending({ old: "done", new: "n2" });
    const calls = [];
    const store = {
      statusOf: async (id) => (id === "gone" ? "" : "superseded"),
      supersede: async (a, b) => { calls.push([a, b]); },
    };
    const fixed = await flushPending(store, {});
    console.log(JSON.stringify({ fixed, calls, after: loadPending().length }));
  `);
  assert.equal(out.fixed, 0);
  assert.deepEqual(out.calls, [], "这两种情况都不该再写一次");
  assert.equal(out.after, 0);
});

test("账本写坏时不能静默当空：挪到旁边留证", () => {
  const { home } = runWithHome(`
    import { notePending, loadPending } from "./src/repair.mjs";
    notePending({ old: "x", new: "y" });
    console.log(JSON.stringify({ n: loadPending().length }));
  `);
  const dir = join(home, ".siyuan-mem");
  writeFileSync(join(dir, "pending-supersede.json"), '{"old":"半截');

  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { loadPending } from "./src/repair.mjs";
    console.log(JSON.stringify({ n: loadPending().length }));
  `], { cwd: ROOT, env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(JSON.parse(out.trim()).n, 0, "读不出来只能返回空");
  const broken = readdirSync(dir).filter((f) => f.includes(".broken-"));
  assert.equal(broken.length, 1, "坏文件要留一份，不能悄悄覆盖掉");
});

test("--limit=5 和 --limit 5 必须等价", () => {
  // 只认分离写法时，`--limit=5` 会变成一个叫 "limit=5" 的布尔开关：
  // 命令照跑，但限制和过滤全都没生效，而且不报错。
  const eq = parseArgs(["索引", "--limit=5", "--topic=精简WMS设计", "--days=30"]);
  const sp = parseArgs(["索引", "--limit", "5", "--topic", "精简WMS设计", "--days", "30"]);
  assert.deepEqual(eq.flags.limit, "5");
  assert.deepEqual(eq.flags, sp.flags);
  assert.deepEqual(eq.rest, ["索引"]);

  // 布尔开关不能被 = 搞坏。
  assert.equal(parseArgs(["--all"]).flags.all, true);
  assert.equal(parseArgs(["--no-model"]).flags["no-model"], true);
});
