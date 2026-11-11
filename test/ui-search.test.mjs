/**
 * 面板的检索接口也要分清「坏了」和「没有」。
 *
 * 第十四轮复审：CLI / MCP / 中心三处都改完了，面板还是无条件 200 + 空 hits，
 * 前端只会渲染「没有命中」——第四个入口漏在同一个坑里。顺带把 source 补上：
 * 面板是真实调用来源之一，记成 unknown 会让「谁在查」失真。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createServer } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "mem-ui-search-"));
process.env.HOME = HOME;

let mode = "ok";

const rows = [
  {
    id: "ui-1",
    content: "部署沙箱的锁不可靠：acquire 放在 try 之外。",
    ial: 'custom-mem-hash="h1" custom-mem-status="current" custom-mem-entity="部署沙箱" custom-mem-brief="" custom-mem-date="2026-11-09" custom-mem-type="decision" custom-mem-confidence="0.8" custom-mem-raw=""',
  },
];

const fake = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/notebook/lsNotebooks")
      return res.end(JSON.stringify({ code: 0, data: { notebooks: [{ id: "nb1", name: "Mem" }] } }));
    if (req.url === "/api/query/sql") {
      if (mode === "error") return res.end(JSON.stringify({ code: 1, msg: "database is locked" }));
      return res.end(JSON.stringify({ code: 0, data: rows }));
    }
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

const { startUi } = await import("../src/core/ui.mjs");

const ui = startUi({ port: 0 });
await new Promise((r) => setTimeout(r, 30));

test.after(async () => {
  await ui.close();
  fake.close();
});

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: ui.port, path, method: "GET", headers: { host: `127.0.0.1:${ui.port}` } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function events() {
  const dir = join(HOME, ".siyuan-mem", "logs");
  return readdirSync(dir)
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.ev?.startsWith("memory."));
}

test("面板命中记 source=ui：第四个来源也要认得出来", async () => {
  const r = await get("/api/search?q=" + encodeURIComponent("部署沙箱"));
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.hits.length, 1);
  assert.ok(events().some((e) => e.ev === "memory.hit" && e.source === "ui"), "面板的命中要记成 ui，不是 unknown");
});

test("面板遇到后端故障回 503 带原因，不能回 200 + 空列表", async () => {
  mode = "error";
  try {
    const r = await get("/api/search?q=" + encodeURIComponent("部署沙箱"));
    assert.equal(r.status, 503);
    const body = JSON.parse(r.body);
    assert.match(body.error, /检索失败/);
    assert.match(body.error, /database is locked/);
    assert.equal(body.hits, undefined, "故障时不要给一个空 hits 让人当成「没有命中」");
  } finally {
    mode = "ok";
  }
});
