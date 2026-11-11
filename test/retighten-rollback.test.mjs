import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 回滚路径的端到端假思源（第九轮 CR：这条路径之前零覆盖）。
 *
 * 主快照只返回 A；B 真实存在但落在快照外，靠定向补查找回来。
 * probeFails=true 时补查返回 `code:-1 database is locked`，用来验证
 * 「验证失败」不会被当成「确认块不存在」而归档掉备份。
 */
async function runRollback({ probeFails = false } = {}) {
  const HOME = mkdtempSync(join(tmpdir(), "mem-rollback-test-"));
  mkdirSync(join(HOME, ".siyuan-mem"), { recursive: true });
  writeFileSync(
    join(HOME, ".siyuan-mem", "retighten-backup-2026-01-01T00-00-00-000Z.json"),
    JSON.stringify([
      { id: "A", old: "assets/a.jsonl#0-39", now: "assets/a.jsonl#3-9" },
      { id: "B", old: "assets/b.jsonl#0-39", now: "assets/b.jsonl#5-10" },
    ])
  );

  const A = { id: "A", content: "A 的结论", ial: 'custom-mem-raw="assets/a.jsonl#3-9"' };
  const B = { id: "B", content: "B 的结论", ial: 'custom-mem-raw="assets/b.jsonl#5-10"' };
  const writes = [];

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = req.url.split("?")[0];
      const send = (o) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (p === "/api/notebook/lsNotebooks")
        return send({ code: 0, data: { notebooks: [{ id: "box1", name: "Mem" }] } });
      if (p === "/api/query/sql") {
        const stmt = JSON.parse(body || "{}").stmt ?? "";
        if (stmt.includes("SELECT id, content, ial")) return send({ code: 0, data: [A] });
        if (stmt.includes("WHERE id IN")) {
          if (probeFails) return send({ code: -1, msg: "database is locked" });
          return send({ code: 0, data: [B] });
        }
        return send({ code: 0, data: [] });
      }
      if (p.toLowerCase().includes("setblockattrs")) {
        writes.push(JSON.parse(body || "{}"));
        return send({ code: 0, data: null });
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
      const c = spawn(process.execPath, ["scripts/retighten.mjs", "--rollback"], {
        cwd: ROOT,
        env: { ...process.env, HOME },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      c.stdout.on("data", (d) => (text += d));
      c.stderr.on("data", (d) => (text += d));
      c.on("exit", (n) => resolve({ code: n, out: text }));
    });

    const files = readdirSync(join(HOME, ".siyuan-mem"));
    return {
      code,
      out,
      writes,
      activeBackups: files.filter((f) => f.startsWith("retighten-backup-") && f.endsWith(".json")),
      archived: files.filter((f) => f.startsWith("retighten-rolledback-")),
    };
  } finally {
    server.close();
    rmSync(HOME, { recursive: true, force: true });
  }
}

// 必须逐块精确比对。整批序列化后查两个互不相关的子串时，把 A/B 的 old 对调
// 也能全绿——正是 byNow 那一串修复要防的跨块写错值。
const wroteOld = (writes, id, old) =>
  writes.some((w) =>
    (w.blockAttrs ?? []).some((pair) => pair.id === id && pair.attrs?.["custom-mem-raw"] === old)
  );

test("--rollback：快照外的块靠定向补查找回来，写回真原始值", async () => {
  const r = await runRollback();
  assert.equal(r.code, 0, `正常路径应退出 0：${r.out}`);
  assert.match(r.out, /回滚 2 条/);
  assert.match(r.out, /块已不存在 0 条/);
  assert.ok(wroteOld(r.writes, "B", "assets/b.jsonl#0-39"), "B 要回到真原始指针");
  assert.equal(r.activeBackups.length, 0, "成功后活动备份应归档");
  assert.equal(r.archived.length, 1);
});

test("--rollback：定向补查失败时不能当成「块不存在」，要阻止归档并报错", async () => {
  const r = await runRollback({ probeFails: true });
  assert.notEqual(r.code, 0, `补查失败必须非零退出：${r.out}`);
  assert.match(r.out, /补查失败未验证 1 条/);
  assert.equal(r.activeBackups.length, 1, "备份必须留着，否则这个块再也回滚不了");
  assert.equal(r.archived.length, 0, "不许归档");
  assert.ok(!wroteOld(r.writes, "B", "assets/b.jsonl#0-39"), "未验证的块不该被写回");
});
