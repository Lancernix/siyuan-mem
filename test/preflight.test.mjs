/**
 * 启动自检：思源活着、笔记本还在。
 *
 * 2026-11-16 的教训：笔记本被删之后，服务照样「扫描 110 个会话、写入 0 条」，
 * 日志看着像没事，实际写了十天空库。所以这两样必须在启动时验，验不过就别起。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// serve.mjs 会读配置和日志路径，先隔离开，别碰真实目录。
process.env.HOME = mkdtempSync(join(tmpdir(), "mem-preflight-"));

const { preflightSiyuan } = await import("../src/core/serve.mjs");

/** 假思源：只实现自检要用的两个接口。 */
function fakeSiyuan({ notebooks = [{ id: "nb-1", name: "Harness-Mem" }], version = "3.8.9", rawVersion = false } = {}) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (o) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      // 真实思源返回的是 data: "3.8.9"（字符串），不是 {version}。
      if (req.url.startsWith("/api/system/version")) return send({ code: 0, data: rawVersion ? { version } : version });
      if (req.url.startsWith("/api/notebook/lsNotebooks")) return send({ code: 0, data: { notebooks } });
      return send({ code: 0, data: null });
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () =>
      resolve({ srv, baseUrl: `http://127.0.0.1:${srv.address().port}` })
    )
  );
}

test("笔记本在：自检返回版本和 id", async (t) => {
  const { srv, baseUrl } = await fakeSiyuan();
  t.after(() => srv.close());

  const r = await preflightSiyuan({
    siyuan: { baseUrl, token: "", notebook: "Harness-Mem", notebookId: "nb-1" },
  });
  assert.equal(r.version, "3.8.9");
  assert.equal(r.notebook, "nb-1");
});

test("版本号两种形状都要接住：字符串和 {version}", async (t) => {
  const a = await fakeSiyuan();
  t.after(() => a.srv.close());
  const r1 = await preflightSiyuan({ siyuan: { baseUrl: a.baseUrl, token: "", notebook: "Harness-Mem", notebookId: "nb-1" } });
  assert.equal(r1.version, "3.8.9", "data 是字符串");

  const b = await fakeSiyuan({ rawVersion: true });
  t.after(() => b.srv.close());
  const r2 = await preflightSiyuan({ siyuan: { baseUrl: b.baseUrl, token: "", notebook: "Harness-Mem", notebookId: "nb-1" } });
  assert.equal(r2.version, "3.8.9", "data 是 {version}");
});

test("笔记本不在：直接报错，并说清楚怎么办", async (t) => {
  const { srv, baseUrl } = await fakeSiyuan({ notebooks: [{ id: "other", name: "工作记录" }] });
  t.after(() => srv.close());

  await assert.rejects(
    () => preflightSiyuan({ siyuan: { baseUrl, token: "", notebook: "Harness-Mem", notebookId: "" } }),
    (e) => {
      assert.match(e.message, /找不到笔记本「Harness-Mem」/);
      assert.match(e.message, /工作记录/, "要把它看到的笔记本名列出来，不然没法排查");
      return true;
    }
  );
});

test("配了 notebookId 但库里没有、名字也换了：报错而不是默默换一本", async (t) => {
  const { srv, baseUrl } = await fakeSiyuan({ notebooks: [{ id: "new-id", name: "另一个名字" }] });
  t.after(() => srv.close());

  await assert.rejects(
    () => preflightSiyuan({ siyuan: { baseUrl, token: "", notebook: "Harness-Mem", notebookId: "old-id" } }),
    /找不到笔记本/
  );
});

test("思源连不上：报错，不假装通过", async () => {
  // 没人监听的端口
  await assert.rejects(() =>
    preflightSiyuan({ siyuan: { baseUrl: "http://127.0.0.1:1", token: "", notebook: "Harness-Mem", notebookId: "" } })
  );
});
