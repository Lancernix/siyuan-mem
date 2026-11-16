/**
 * 推送进度必须自己一份，不能借用抽取进度。
 *
 * 2026-11-16 的事故：serve 抽完会推进 offsets.json，push 拿同一份判断
 * 「推没推过」，于是 serve 处理过的会话 push 永远认为已推。本机库里有 125 条，
 * 中心一条没有——其中一场 944 轮的会话彻底没到过中心。
 *
 * 这里钉住两件事：push 只看 push-offsets.json；它写进度时不碰 offsets.json。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "mem-push-offsets-"));
process.env.HOME = HOME;

const dir = join(HOME, ".workbuddy/projects/demo");
mkdirSync(dir, { recursive: true });
const file = join(dir, "s1.jsonl");
const line = (role, text, ts) =>
  JSON.stringify({ type: "message", sessionId: "s1", role, timestamp: ts, content: [{ type: role === "user" ? "input_text" : "output_text", text }] });
writeFileSync(
  file,
  [
    line("user", "推送游标和抽取游标为什么要分开？", 1),
    line("assistant", "因为一个记读到第几轮，一个记发到第几轮，共用一个谁先跑谁把另一个的活儿吃掉。", 2),
  ].join("\n") + "\n"
);

const { pushOnce } = await import("../src/cli/push.mjs");
const { listSessions } = await import("../src/util/harness.mjs");
const { saveOffsets, loadOffsets, OFFSET_PATH, machineId } = await import("../src/util/config.mjs");

function fakeCenter() {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, duplicate: false, accepted: 1, queue: 1 }));
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, got, to: `http://127.0.0.1:${srv.address().port}` })));
}

test("抽取进度已经推到最新，push 仍然要推——它只看自己的游标", async (t) => {
  const { srv, got, to } = await fakeCenter();
  t.after(() => srv.close());

  // 模拟 serve：把 offsets.json 写到「这个会话已经处理完」。
  const all = loadOffsets();
  const size = readFileSync(file).length;
  const st = (await import("node:fs")).statSync(file);
  all.machines ??= {};
  all.machines[machineId()] = { [file]: { bytes: size, mtimeMs: st.mtimeMs, turns: 2 } };
  saveOffsets(all);

  const before = readFileSync(OFFSET_PATH, "utf8");
  const r = await pushOnce({ to, token: "", sessions: listSessions(), quietSeconds: 0, limit: 5 });

  assert.equal(r.sessions, 1, "抽取进度不该把推送挡住");
  assert.ok(got.some((g) => g.url === "/api/ingest"), "必须真的发出去");
  assert.equal(readFileSync(OFFSET_PATH, "utf8"), before, "push 不许改抽取的 offsets.json");

  const pushPath = join(HOME, ".siyuan-mem/push-offsets.json");
  assert.ok(existsSync(pushPath), "push 要自己记一份");
  const pushOffsets = JSON.parse(readFileSync(pushPath, "utf8"));
  assert.ok(pushOffsets.machines[machineId()][file], "自己的游标里要有这条记录");
});
