/**
 * 面板放到公网域名后面：Host 校验、Basic 鉴权、路径前缀。
 *
 * 这三件事任一漏掉都很难看：Host 不认就打不开（或者随便哪个域名解析过来都能读），
 * 没鉴权等于把记忆库正文摊在网上，路径写死绝对路径则挂到 /panel/ 下就全是 404。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "mem-ui-panel-"));

const { startUi } = await import("../src/core/ui.mjs");

const AUTH = "me:s3cret-pass";

async function boot(t, opts = {}) {
  const ui = startUi({ port: 0, host: "127.0.0.1", ...opts });
  t.after(() => ui.close());
  // listen 是异步的：端口要等 listening 之后才知道，早了会 fetch 到 :0。
  for (let i = 0; i < 100 && (!ui.listening || !ui.port); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return ui;
}

const get = (ui, path = "/", headers = {}) => fetch(`${ui.url}${path}`, { headers, redirect: "manual" });
const basic = (s) => ({ authorization: `Basic ${Buffer.from(s).toString("base64")}` });

/**
 * fetch 不能改 Host（规范里的 forbidden header），验 Host 校验必须自己发请求。
 * 返回 [状态码, 响应体]。
 */
const rawGet = (ui, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: ui.port, path, method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve([res.statusCode, body]));
      }
    );
    req.on("error", reject);
    req.end();
  });

test("绑非回环又没给密码：拒绝启动，别把正文摊在网上", () => {
  assert.throws(() => startUi({ port: 0, host: "0.0.0.0" }), /必须同时给账号密码/);
  // 给了密码就放行（这里只验不抛，端口用 0）。
  const ui = startUi({ port: 0, host: "127.0.0.1", auth: AUTH });
  return ui.close();
});

test("配了 auth：没带 / 带错都 401，带对了给页面", async (t) => {
  const ui = await boot(t, { auth: AUTH });
  const no = await get(ui);
  assert.equal(no.status, 401);
  assert.match(no.headers.get("www-authenticate") ?? "", /Basic/);

  assert.equal((await get(ui, "/", basic("me:wrong"))).status, 401);
  assert.equal((await get(ui, "/", basic("other:s3cret-pass"))).status, 401);

  const ok = await get(ui, "/", basic(AUTH));
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /<!doctype html>/i);
});

test("Host 白名单：域名能进、陌生域名一律 403", async (t) => {
  const ui = await boot(t, { auth: AUTH, allowHosts: ["mem.lancernix.space"] });
  const auth = basic(AUTH);
  assert.equal((await rawGet(ui, "/", { ...auth, host: "mem.lancernix.space" }))[0], 200);
  assert.equal((await rawGet(ui, "/", { ...auth, host: "evil.com" }))[0], 403);
  // 白名单只放行名字，不放行「不用登录」：没带密码照样 401。
  assert.equal((await rawGet(ui, "/", { host: "mem.lancernix.space" }))[0], 401);
});

test("没配 auth 时只认本机 Host，行为不变", async (t) => {
  const ui = await boot(t);
  assert.equal((await get(ui, "/")).status, 200);
  assert.equal((await rawGet(ui, "/", { host: "evil.com" }))[0], 403);
  assert.equal((await rawGet(ui, "/", { host: "127.0.0.1" }))[0], 200);
});

test("页面里的请求用相对路径：挂在 /panel/ 下才不会打到站根", async (t) => {
  const ui = await boot(t);
  const html = await (await get(ui, "/")).text();
  // 页面本身只引相对路径的三个静态文件——写死 /app.css 的话，挂到 /panel/ 下会 404。
  assert.match(html, /href="tokens\.css"/);
  assert.match(html, /src="app\.js"/);
  // 取数在 app.js 里，同样必须是相对路径：站根是中心接口，不是面板。
  const js = await (await get(ui, "/app.js")).text();
  assert.match(js, /"api\/state"/);
  assert.doesNotMatch(js, /"\/api\//);
});

test("静态文件带 no-store，改完刷新就是新的", async (t) => {
  const ui = await boot(t);
  const res = await get(ui, "/app.css");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/css/);
  assert.equal(res.headers.get("cache-control"), "no-store");
});


test("参数不接受 0：空输入框会让抽取死循环、一轮什么都不做", async (t) => {
  const ui = await boot(t);
  const post = (body) =>
    fetch(`${ui.url}/api/settings/params`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ui.url },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ extract: { maxCharsPerCall: 0 } })).status, 400);
  assert.equal((await post({ serve: { maxSessionsPerRound: 0 } })).status, 400);
  // 正常值仍然放行
  assert.equal((await post({ extract: { maxCharsPerCall: 20000 } })).status, 200);
});

test("写操作的同源判断能容忍大小写与端口差异", async (t) => {
  const ui = await boot(t);
  const upper = `http://LOCALHOST:${ui.port}`;
  const res = await fetch(`${ui.url}/api/settings/params`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: upper },
    body: JSON.stringify({ extract: { maxCharsPerCall: 20000 } }),
  });
  // localhost 与 127.0.0.1 都算回环，大小写不同不该被判成跨站。
  // 断言 200 而不是「不等于 403」：500/429 也能过后者，等于没测。
  assert.equal(res.status, 200);
});

test("Basic 口令连续猜错会被限速", async (t) => {
  const ui = await boot(t, { auth: AUTH });
  const wrong = { authorization: "Basic " + Buffer.from("me:wrong").toString("base64") };
  for (let i = 0; i < 10; i++) assert.equal((await get(ui, "/", wrong)).status, 401);
  const r = await get(ui, "/", wrong);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) > 0, "要告诉客户端等多久");
  const ok = await get(ui, "/", { authorization: "Basic " + Buffer.from(AUTH).toString("base64") });
  assert.equal(ok.status, 429, "封禁期内即使口令对了也先挡住");
});


test("参数有上限：把单轮预算调到 1e9 要拒掉", async (t) => {
  const ui = await boot(t);
  const post = (body) =>
    fetch(`${ui.url}/api/settings/params`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ui.url },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ serve: { maxMinutesPerRound: 1e9 } })).status, 400);
  assert.equal((await post({ extract: { maxCharsPerCall: 1e7 } })).status, 400);
  assert.equal((await post({ serve: { maxMinutesPerRound: 60 } })).status, 200);
});
