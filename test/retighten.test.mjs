import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 用假思源端到端跑 `scripts/retighten.mjs --apply`。
 *
 * 第八轮 CR 的两个场景：
 *   - 归档备份里 X 的收窄产物「assets/s.jsonl#3-9」恰好等于块 Y 自己的原始指针。
 *     byNow 只按指针串做键的话，会把 X 的 old 记到 Y 头上，回滚改坏没动过的块。
 *   - 块 Z 的现值确实是某次收窄产物但没记账，且本次 updates 为空；
 *     补记必须落盘，否则日志说「补记」而备份文件根本不存在。
 */
test("retighten：byNow 不跨块串台，且空 updates 时补记也要落盘", async () => {
  const HOME = mkdtempSync(join(tmpdir(), "mem-retighten-test-"));
  mkdirSync(join(HOME, ".siyuan-mem"), { recursive: true });
  writeFileSync(
    join(HOME, ".siyuan-mem", "retighten-rolledback-test.json"),
    JSON.stringify([
      { id: "X", old: "assets/s.jsonl#0-39", now: "assets/s.jsonl#3-9" },
      { id: "Z", old: "assets/z.jsonl#0-39", now: "assets/z.jsonl#3-9" },
    ])
  );

  const BLOCKS = [
    { id: "Y", content: "结论：容器 nginx 监听 7788，端口映射写成 7789 要改回去。", ial: 'custom-mem-raw="assets/s.jsonl#3-9"' },
    { id: "Z", content: "结论：迁移前必须先 restic backup 做快照，不能先删本机副本。", ial: 'custom-mem-raw="assets/z.jsonl#3-9"' },
  ];
  const jsonl = (tag) =>
    [
      JSON.stringify({ type: "session", v: 1, from: 1, to: 40 }),
      ...Array.from({ length: 40 }, (_, i) =>
        JSON.stringify({
          i: i + 1,
          role: i % 2 ? "user" : "assistant",
          text: `${tag} 第 ${i + 1} 轮：nginx 监听 7788，端口映射 7789，restic backup 快照，迁移顺序别搞反。`,
        })
      ),
    ].join("\n");

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = req.url.split("?")[0];
      const send = (o) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (p === "/api/notebook/lsNotebooks") return send({ code: 0, data: { notebooks: [{ id: "box1", name: "Mem" }] } });
      if (p === "/api/query/sql") {
        const stmt = JSON.parse(body || "{}").stmt ?? "";
        if (stmt.includes("SELECT id, content, ial")) return send({ code: 0, data: BLOCKS });
        if (stmt.includes("WHERE id IN")) {
          const ids = [...stmt.matchAll(/'([^']+)'/g)].map((m) => m[1]);
          return send({ code: 0, data: BLOCKS.filter((b) => ids.includes(b.id)) });
        }
        return send({ code: 0, data: [] });
      }
      if (p.includes("setBlockAttrs")) return send({ code: 0, data: null });
      if (p.startsWith("/assets/")) {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end(jsonl(p.includes("/z.jsonl") ? "Z" : "S"));
      }
      return send({ code: 0, data: null });
    });
  });

  try {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    writeFileSync(
      join(HOME, ".siyuan-mem", "config.json"),
      JSON.stringify({
        siyuan: { baseUrl: `http://127.0.0.1:${server.address().port}`, token: "t", notebookId: "box1" },
        raw: { enabled: false },
      })
    );

    const { code, out } = await new Promise((resolve) => {
      const c = spawn(process.execPath, ["scripts/retighten.mjs", "--apply"], {
        cwd: ROOT,
        env: { ...process.env, HOME },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      c.stdout.on("data", (d) => (text += d));
      c.stderr.on("data", (d) => (text += d));
      c.on("exit", (n) => resolve({ code: n, out: text }));
    });
    assert.equal(code, 0, `脚本应该正常退出：${out}`);

    const backups = readdirSync(join(HOME, ".siyuan-mem")).filter(
      (f) => f.startsWith("retighten-backup-") && f.endsWith(".json")
    );
    // updates 为空时补记也必须落盘，否则「已补记」是空话、P0 映射一直吊在旧文件上。
    assert.equal(backups.length, 1, `应该生成一份活动备份，实际 ${backups.length}`);
    const rec = JSON.parse(readFileSync(join(HOME, ".siyuan-mem", backups[0]), "utf8"));

    const y = rec.find((u) => u.id === "Y");
    assert.ok(!y || y.old === "assets/s.jsonl#3-9", `Y 不能被记成 X 的 old：${JSON.stringify(y)}`);
    const z = rec.find((u) => u.id === "Z");
    assert.equal(z?.old, "assets/z.jsonl#0-39", "Z 补记要用真原始值，不能把已收窄的现值当 old");
  } finally {
    server.close();
    rmSync(HOME, { recursive: true, force: true });
  }
});
