/**
 * 一个本地面板：看状态、看条目、看队列，点一下跑一轮。
 *
 * 刻意不用框架、不装依赖：总共一个 HTML 字符串 + 五个只读接口 + 一个动作接口，
 * 全部代码比一个前端脚手架的配置还短。面板的意义是"不用开终端就知道它在不在干活"，
 * 不是做一个管理系统——真管理应该去思源里改，那边有编辑器。
 *
 * 默认只绑 127.0.0.1。绑到别的地址（放公网域名后面）必须同时给 --auth：这个面板
 * 会显示条目正文和日志，没有鉴权就暴露，等于把记忆库摊在网上。
 */
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { LOG_PATH } from "../util/config.mjs";
import { open } from "./jobs.mjs";
import { pending } from "./inbox.mjs";
import { usageToday, resolveModel, hasModel } from "../util/llm.mjs";
import { lockInfo, roundStatus } from "./serve.mjs";
import { searchEntries } from "./search.mjs";
import { failureText } from "./search-reason.mjs";
import { listTopics, listEntries } from "./browse.mjs";

/** 队列项只读头部：完整会话可能有几 MB，面板不需要。 */
function queueItem(file) {
  let meta = {};
  try {
    const raw = readFileSync(file, "utf8");
    const obj = raw.trim().startsWith("{") ? JSON.parse(raw) : null;
    if (obj) meta = { session: obj.session_id ?? "", harness: obj.harness ?? "", turns: (obj.turns ?? []).length };
  } catch {}
  return { file: file.split("/").pop(), ...meta };
}

function tailLog(lines = 30) {
  if (!existsSync(LOG_PATH)) return [];
  const all = readFileSync(LOG_PATH, "utf8").trimEnd().split("\n");
  return all.slice(-lines);
}

async function state() {
  const { cfg, sy, store } = open();
  const [version, stats, entries] = await Promise.all([
    sy.version().catch(() => "离线"),
    store.stats().catch(() => ({ current: 0, superseded: 0, archived: 0, total: 0 })),
    store.review(30).catch(() => []),
  ]);
  const m = resolveModel(cfg);
  return {
    siyuan: { baseUrl: cfg.siyuan.baseUrl, version, notebook: cfg.siyuan.notebook },
    stats,
    queue: pending().map(queueItem),
    entries,
    model: { provider: m.provider, wire: m.wire, model: m.model, configured: hasModel(cfg) },
    usage: usageToday(),
    log: tailLog(40),
    service: lockInfo(),
    // 有一轮在跑的时候按钮要灰掉：面板和定时是同一进程里的两条流，撞一起会互相踩写。
    busy: roundStatus(),
    now: Date.now(),
  };
}

/** 前端在 src/ui/：三个静态文件，改完刷新就生效，不用重启。 */
const UI_DIR = new URL("../ui/", import.meta.url);

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/tokens.css": ["tokens.css", "text/css; charset=utf-8"],
};

/**
 * 吐静态文件。每次请求都读盘——面板是自用的，省一次重启比省一次 IO 值。
 * 没命中返回 false，交给路由继续往下走。
 */
function serveStatic(pathname, res) {
  const hit = STATIC[pathname];
  if (!hit) return false;
  let buf;
  try {
    buf = readFileSync(new URL(hit[0], UI_DIR));
  } catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`前端文件缺失：src/ui/${hit[0]}`);
    return true;
  }
  res.writeHead(200, {
    "content-type": hit[1],
    // 自用面板不让浏览器缓存：改完前端刷新就该看到新的。
    "cache-control": "no-store",
  });
  res.end(buf);
  return true;
}

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {(log:Function)=>Promise<any>} [opts.runRound] 传了就显示"跑一轮"；不传也能点，走独立跑法
 */

/**
 * 这个请求是不是面板自己发的。
 *
 * 没有 Origin 的是非浏览器客户端（curl、脚本），放行——它们要伪造也拦不住，
 * 真有鉴权要求时它们照样得过 Basic。有 Origin 的必须是同源（或 loopback）：
 * 跨站页面 POST 过来是能打进来的（响应读不到，但「跑一轮」这个副作用照样发生）。
 * 放公网域名后面时，Origin 是那个域名，不能只认 loopback。
 */
function fromThisPage(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.host === String(req.headers.host ?? "")) return true;
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * Basic 认证。账号密码从启动参数/环境变量来，不落盘。
 *
 * 用摘要再比，长度一致、也不泄露前缀匹配的长度差。没配 auth 时直接放行——
 * 那种情况只允许绑回环（见 startUi 里的守卫）。
 */
function authOk(req, expected) {
  const m = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
  if (!m) return false;
  let given = "";
  try {
    given = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

/**
 * Host 头是不是本机的。
 *
 * 防的是 DNS rebinding：攻击者把 `evil.com` 解析到 127.0.0.1，你打开那个页面，
 * 页面里的脚本 fetch('http://evil.com:7787/api/search') 就到了这里——浏览器认为
 * 是同源，响应读得到。Origin 校验挡不住这条路（同源请求根本没有 Origin/跨站标记），
 * 只有 Host 会老老实实写着 `evil.com`。所以 GET 也要查。
 */
function hostOk(req, boundHost, allowHosts = []) {
  const raw = String(req.headers.host ?? "");
  // 去掉端口，IPv6 去掉方括号。
  const name = raw.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!name) return false;
  if (name === "127.0.0.1" || name === "localhost" || name === "::1") return true;
  // 放在反向代理后面时，浏览器敲的是域名，DNS rebinding 那套前提就不成立了，
  // 由调用方显式列出允许的名字。列进来的名字一律要过鉴权才能读到数据。
  if (allowHosts.map((x) => String(x).toLowerCase()).includes(name)) return true;
  const bound = String(boundHost ?? "").toLowerCase();
  // 显式绑到别的地址（--host 192.168.x.x）时，浏览器里敲的就是那个地址。
  if (name === bound) return true;
  // 绑到通配地址时没法预知会被用哪个名字访问，只放行 IP 字面量和 localhost：
  // 局域网里敲 192.168.x.x 照常用，而 evil.com 这种域名一律拒掉。
  if (bound === "0.0.0.0" || bound === "::") return /^[0-9a-f.]+$/.test(name) || name === "localhost";
  return false;
}

export function startUi({ port = 7787, host = "127.0.0.1", allowHosts = [], auth = "", runRound } = {}) {
  // 绑到非回环地址又不给密码：面板会把条目正文和日志摊在网上。宁可起不来。
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(String(host));
  if (!loopback && !auth) {
    throw new Error(
      `拒绝启动：面板显示的是记忆库正文，绑到 ${host} 必须同时给账号密码（--auth user:密码，或 MEM_PANEL_AUTH）`
    );
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    };

    try {
      if (!hostOk(req, host, allowHosts)) {
        return json(403, { error: `不认这个 Host（${String(req.headers.host ?? "")}）：用 IP 或 localhost 访问，或启动时加 --allow-host` });
      }
      if (auth && !authOk(req, auth)) {
        res.writeHead(401, {
          "www-authenticate": 'Basic realm="siyuan-mem", charset="UTF-8"',
          "content-type": "text/plain; charset=utf-8",
        });
        return res.end("需要登录");
      }
      if (req.method === "GET" && serveStatic(url.pathname, res)) return;
      if (req.method === "GET" && url.pathname === "/api/state") {
        return json(200, await state());
      }
      if (req.method === "GET" && url.pathname === "/api/topics") {
        const q = url.searchParams.get("q") ?? "";
        const limit = Number(url.searchParams.get("limit")) || 200;
        const r = await listTopics({ q, limit, source: "ui" });
        if (r.failed) {
          return json(503, { error: `列话题失败：${failureText(r.reason, r.detail)}`, reason: r.reason });
        }
        return json(200, r);
      }
      if (req.method === "GET" && url.pathname === "/api/entries") {
        const topic = url.searchParams.get("topic") ?? "";
        if (!topic) return json(400, { error: "要给 topic" });
        const limit = Number(url.searchParams.get("limit")) || 100;
        const r = await listEntries({ topic, limit, source: "ui" });
        if (r.failed) {
          return json(503, { error: `翻条目失败：${failureText(r.reason, r.detail)}`, reason: r.reason });
        }
        return json(200, r);
      }
      if (req.method === "GET" && url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        // source 必须写 ui：面板是第四个真实来源，混进 unknown 会让「谁在查」失真。
        const r = await searchEntries({ q, limit: 30, source: "ui" });
        // 后端故障不能回 200 + 空 hits：前端只会渲染「没有命中」，又把坏了说成没有。
        if (r.failed)
          return json(503, { error: `检索失败：${failureText(r.reason, r.detail)}`, reason: r.reason });
        return json(200, r);
      }
      if (req.method === "POST" && url.pathname === "/api/run") {
        if (!fromThisPage(req)) {
          // 跨站请求：浏览器会带着别家的 Origin 打过来，响应它读不到，但副作用已经发生了。
          // 服务只绑 127.0.0.1，挡不住"你正在浏览的网页顺手 POST 一下 localhost"。
          return json(403, { error: "只接受面板自己发起的请求" });
        }
        if (!runRound) return json(409, { error: "这个面板没接运行器，用 mem serve 起来的那份" });
        return json(200, await runRound(() => {}));
      }
      return json(404, { error: "没有这个接口" });
    } catch (e) {
      // 抢不到锁、或者有一轮正在跑：都不是服务器内部错误，是"现在不能跑"，
      // 给 409 让前端能说人话，而不是显示一个"失败"让人以为坏了。
      return json(/锁|lock|有一轮正在跑/i.test(e.message) ? 409 : 500, { error: e.message });
    }
  });

  // 端口被占是 EADDRINUSE 的**异步事件**，同步 try/catch 捕不到，
  // 不监听的话进程会直接退出——在 launchd 下表现成"服务反复重启，日志里什么都没有"。
  server.on("error", (e) => {
    console.error(`面板起不来：${e.code === "EADDRINUSE" ? `端口 ${port} 被占用` : e.message}`);
  });
  server.listen(port, host);
  const actualPort = () => server.address()?.port ?? port;
  return {
    // 用 getter：传 port=0 时由内核选空闲端口，测试要先知道真实端口才能请求。
    get url() {
      return `http://${host}:${actualPort()}`;
    },
    get port() {
      return actualPort();
    },
    close: () => new Promise((r) => server.close(r)),
    get listening() {
      return server.listening;
    },
  };
}
