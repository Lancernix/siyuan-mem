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
  assert.match(html, /fetch\("api\/state"\)/);
  assert.doesNotMatch(html, /fetch\("\/api\//);
});
