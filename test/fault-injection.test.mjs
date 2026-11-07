/**
 * 故障注入：故意把东西弄坏，看会不会丢数据。
 *
 * 这两条是"坏了就永久丢"的路径，平时跑不到——只有真出事才触发，而真出事时
 * 没人盯着日志。所以用桩把失败造出来。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function run(code) {
  const home = mkdtempSync(join(tmpdir(), "mem-fault-"));
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: ROOT,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return JSON.parse(out.trim());
}

test("原文传到第 2 段时挂了：重试只补缺的那几段，不重传、不出现重叠", () => {
  const out = run(`
    import { readFileSync } from "node:fs";
    import { archive } from "./src/shared/raw.mjs";

    const cfg = { raw: { dir: "mem-raw", forcePartBytes: 60, enabled: true } };
    const turns = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      text: "第 " + (i + 1) + " 轮的内容，写长一点点让每轮各自成一段",
    }));
    const payload = { session_id: "s-raw-fault", harness: "dsh", machine: "Mac", cwd: "", date: "2026-10-31", turnFrom: 1, turns };

    let n = 0;
    const sy = {
      uploadAsset: async (dir, name) => {
        n++;
        if (n === 2) throw new Error("模拟上传失败");
        return dir + name;
      },
    };

    let firstError = "";
    try { await archive({ sy, cfg, ids: {}, payload, log: () => {} }); }
    catch (e) { firstError = e.message; }

    const readIdx = () => {
      const idx = JSON.parse(readFileSync(process.env.HOME + "/.siyuan-mem/raw-index.json", "utf8"));
      return idx[Object.keys(idx)[0]] ?? [];
    };
    const afterFail = readIdx();

    // 上传恢复正常，再跑一遍（真实场景：下一轮重试）
    const second = [];
    sy.uploadAsset = async (dir, name) => { const p = dir + name; second.push(p); return p; };
    const retry = await archive({ sy, cfg, ids: {}, payload, log: () => {} });
    const after = readIdx();

    console.log(JSON.stringify({ firstError, afterFail, second, retry: retry.map((p) => [p.from, p.to]), after }));
  `);

  assert.ok(out.firstError, "第 2 段上传失败时，整次归档应该抛出，而不是假装成功");
  assert.equal(out.afterFail.length, 1, "失败前已传的那一段要留在索引里，重试才能续上");

  // 关键断言：重试不能把第 1 段再传一遍（那会产生两份内容重叠的附件，
  // 而且指针分不清该指哪一份）。
  const reuploaded = out.second.filter((p) => /\.p1\.jsonl$/.test(p));
  assert.equal(reuploaded.length, 0, `重试重传了第 1 段：${reuploaded.join(",")}`);

  assert.equal(out.after.length, 8, "重试之后应该是完整的 8 段");
  const ranges = out.after.map((p) => [p.from, p.to]);
  for (let i = 0; i < ranges.length; i++) {
    assert.equal(ranges[i][0], i + 1, `第 ${i + 1} 段的起点不对：${JSON.stringify(ranges)}`);
    assert.equal(ranges[i][1], i + 1, `第 ${i + 1} 段的终点不对：${JSON.stringify(ranges)}`);
  }
  const paths = new Set(out.after.map((p) => p.path));
  assert.equal(paths.size, out.after.length, "每段必须是不同的文件");
});

test("supersede 失败：账本记一笔，下一轮补上，不会留两条 current", () => {
  const out = run(`
    import { notePending, loadPending, flushPending, dropPending } from "./src/center/repair.mjs";

    const fixedCalls = [];
    const broken = {
      statusOf: async () => "current",
      supersede: async () => { throw new Error("模拟 setBlockAttrs 失败"); },
    };
    const healthy = {
      statusOf: async () => "current",
      supersede: async (a, b) => { fixedCalls.push([a, b]); },
    };

    // 模拟 jobs 里那一步：先记账，再动；动失败了就不销账。
    notePending({ old: "old1", new: "new1", entity: "mcp-adapter" });
    let writeError = "";
    try { await broken.supersede("old1", "new1"); dropPending("old1"); }
    catch (e) { writeError = e.message; }
    const afterFail = loadPending();

    // 下一轮开头会跑 flush
    const fixed1 = await flushPending(healthy, {});
    const afterFix = loadPending();
    // 再跑一次：不该重复补
    const fixed2 = await flushPending(healthy, {});

    console.log(JSON.stringify({ writeError, afterFail, fixed1, fixedCalls, afterFix, fixed2 }));
  `);

  assert.ok(out.writeError, "supersede 失败要冒出来，不能被吞掉");
  assert.equal(out.afterFail.length, 1, "失败之后账本里必须还留着这一笔");
  assert.equal(out.afterFail[0].old, "old1");

  assert.equal(out.fixed1, 1, "下一轮应该补做一次");
  assert.deepEqual(out.fixedCalls, [["old1", "new1"]], "补做要针对同一对（old → new）");
  assert.equal(out.afterFix.length, 0, "补完要销账");
  assert.equal(out.fixed2, 0, "销账之后不能再补第二遍");
});
