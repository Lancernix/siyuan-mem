/**
 * 评测脚本遇到后端故障必须中止，不能产出一张 0% 的基线表。
 *
 * 第十四轮复审：脚本只看 hits，不看 failed。思源抖一次，每条查询都空手，
 * 跑出来就是一张「算法全面回归」的表——而这张表正是判断「要不要继续调召回」
 * 的唯一依据。这和上一轮 CLI 那个 P2 是同一个错误，只是发生在最要紧的地方。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const HOME = mkdtempSync(join(tmpdir(), "mem-eval-"));
const fake = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/notebook/lsNotebooks")
      return res.end(JSON.stringify({ code: 0, data: { notebooks: [{ id: "nb1", name: "Mem" }] } }));
    if (req.url === "/api/query/sql") return res.end(JSON.stringify({ code: 1, msg: "database is locked" }));
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));

mkdirSync(join(HOME, ".siyuan-mem"), { recursive: true });
writeFileSync(
  join(HOME, ".siyuan-mem", "config.json"),
  JSON.stringify({ siyuan: { baseUrl: `http://127.0.0.1:${fake.address().port}`, notebook: "Mem" } })
);
const qfile = join(HOME, "pairs.json");
writeFileSync(
  qfile,
  JSON.stringify([{ q: "部署沙箱的锁", expect: ["x"], kind: "easy", qk: "部署 锁" }])
);

test.after(() => fake.close());

const run = () =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, ["scripts/eval-recall.mjs", "--file", qfile, "--limit", "5"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, HOME },
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });

test("后端故障：非零退出、不给基线表", async () => {
  const r = await run();
  assert.equal(r.code, 2, `退出码要能区分「跑完了」和「中止」，实际 ${r.code}\nstdout=${r.stdout}`);
  assert.match(r.stderr, /评测中止/);
  assert.match(r.stderr, /database is locked/);
  assert.doesNotMatch(r.stdout, /整句|关键词|正例合计/, "中止时不能打出任何百分比表");
});
