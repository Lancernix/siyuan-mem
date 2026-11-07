/**
 * 一个本地面板：看状态、看条目、看队列，点一下跑一轮。
 *
 * 刻意不用框架、不装依赖：总共一个 HTML 字符串 + 五个只读接口 + 一个动作接口，
 * 全部代码比一个前端脚手架的配置还短。面板的意义是"不用开终端就知道它在不在干活"，
 * 不是做一个管理系统——真管理应该去思源里改，那边有编辑器。
 *
 * 只绑 127.0.0.1。不绑 0.0.0.0 是因为它没有鉴权：局域网上任何设备都能读你的记忆库。
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { LOG_PATH } from "../shared/config.mjs";
import { open } from "./jobs.mjs";
import { pending } from "./inbox.mjs";
import { usageToday, resolveModel, hasModel } from "../shared/llm.mjs";
import { lockInfo, roundStatus } from "./serve.mjs";
import { searchEntries } from "./search.mjs";

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
    store.stats().catch(() => ({ current: 0, superseded: 0, total: 0 })),
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

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mem · 思源记忆</title>
<style>
  :root{--bg:#0e1013;--panel:#161a20;--line:#252b34;--txt:#dfe4ea;--dim:#8b95a3;--accent:#6ee7b7;--warn:#f5b46b}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.6 ui-sans-serif,-apple-system,"PingFang SC",system-ui,sans-serif}
  header{padding:18px 22px 12px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:14px;align-items:baseline}
  h1{font-size:15px;margin:0;letter-spacing:.5px;font-weight:600}
  h1 span{color:var(--dim);font-weight:400;margin-left:8px;font-size:12px}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-left:auto}
  .chip{border:1px solid var(--line);border-radius:99px;padding:3px 10px;font-size:12px;color:var(--dim)}
  .chip b{color:var(--txt);font-weight:600;font-variant-numeric:tabular-nums}
  .chip.ok{border-color:#24503f}.chip.ok b{color:var(--accent)}
  .chip.bad{border-color:#5a3232}.chip.bad b{color:#f88}
  main{padding:16px 22px 40px;display:grid;gap:16px;grid-template-columns:1.4fr 1fr;align-items:start}
  @media(max-width:820px){main{grid-template-columns:1fr}}
  section{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  section h2{font-size:12px;margin:0;padding:10px 14px;border-bottom:1px solid var(--line);color:var(--dim);font-weight:500;letter-spacing:.4px}
  ul{list-style:none;margin:0;padding:0;max-height:52vh;overflow:auto}
  li{padding:9px 14px;border-bottom:1px solid #1c2128;display:flex;gap:10px;align-items:flex-start}
  li:last-child{border-bottom:0}
  .tag{font-size:11px;color:var(--accent);border:1px solid #24503f;border-radius:5px;padding:0 6px;white-space:nowrap;margin-top:2px}
  .tag.sup{color:var(--warn);border-color:#5a4a2a}
  .txt{flex:1;min-width:0}
  .meta{color:var(--dim);font-size:11px;margin-top:2px;font-variant-numeric:tabular-nums}
  .empty{color:var(--dim);padding:16px 14px;font-size:13px}
  .bar{display:flex;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);align-items:center}
  input,button{font:inherit;color:var(--txt);background:#0f1318;border:1px solid var(--line);border-radius:7px;padding:6px 10px}
  input{flex:1;min-width:0}
  button{cursor:pointer}
  button:hover{border-color:#3a4553}
  button.primary{border-color:#24503f;color:var(--accent)}
  button:disabled{opacity:.5;cursor:default}
  pre{margin:0;padding:10px 14px 16px;font:11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);max-height:32vh;overflow:auto;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<header>
  <h1>mem<span>思源记忆 · 本地面板</span></h1>
  <div class="chips" id="chips"></div>
</header>
<main>
  <section>
    <div class="bar">
      <input id="q" placeholder="搜记忆（回车，留空回到最近条目）">
      <button id="run" class="primary">跑一轮</button>
    </div>
    <ul id="list"><li class="empty">加载中…</li></ul>
  </section>
  <div style="display:grid;gap:16px">
    <section><h2>队列</h2><ul id="queue"><li class="empty">—</li></ul></section>
    <section><h2>日志</h2><pre id="log">—</pre></section>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function chip(label, value, cls = "") {
  return '<span class="chip ' + cls + '">' + label + " <b>" + esc(value) + "</b></span>";
}

function draw(s) {
  const online = s.siyuan.version !== "离线";
  const busy = s.busy && s.busy.running;
  $("chips").innerHTML = [
    chip("思源", online ? "v" + s.siyuan.version : "离线", online ? "ok" : "bad"),
    chip("条目", s.stats.current + " 在用 / " + s.stats.superseded + " 过时"),
    chip("队列", s.queue.length + " 个会话", s.queue.length ? "bad" : "ok"),
    chip("模型", s.model.configured ? s.model.provider + " / " + s.model.model : "未配置", s.model.configured ? "ok" : "bad"),
    chip("今日", s.usage.calls ? s.usage.calls + " 次 · " + (s.usage.prompt + s.usage.completion) + " tok" : "无调用"),
    busy
      ? chip("正在跑", s.busy.kind + " " + s.busy.seconds + "s", "ok")
      : chip("调度", s.service?.running ? "第 " + (s.service.round ?? 0) + " 轮" : "单次面板", s.service?.running ? "ok" : ""),
  ].join("");

  // 有一轮在跑就把按钮灰掉：面板和定时是同一进程里的两条流，同时写会互相踩。
  const btn = $("run");
  if (btn && !btn.dataset.busy) {
    btn.disabled = Boolean(busy);
    btn.title = busy ? "有一轮正在跑，等它跑完" : "";
  }

  const rows = s._hits ?? s.entries;
  $("list").innerHTML = rows.length
    ? rows.map((e) => '<li><span class="tag ' + (e.status === "superseded" ? "sup" : "") + '">' + esc(e.entity || e.type || "-") +
        '</span><div class="txt">' + esc(e.text) + '<div class="meta">' + esc([e.type, e.status, e.date, e.source, e.id].filter(Boolean).join(" · ")) + "</div></div></li>").join("")
    : '<li class="empty">' + (s._hits ? "没有命中" : "还没有条目") + "</li>";

  $("queue").innerHTML = s.queue.length
    ? s.queue.map((q) => '<li><div class="txt">' + esc(q.session || q.file) + '<div class="meta">' + esc([q.harness, q.turns ? q.turns + " 轮" : "", q.file].filter(Boolean).join(" · ")) + "</div></div></li>").join("")
    : '<li class="empty">空</li>';

  $("log").textContent = s.log.length ? s.log.join("\n") : "还没有日志";
}

let last = null;
async function refresh() {
  try {
    const r = await fetch("/api/state");
    last = await r.json();
    if (!document.activeElement || document.activeElement.id !== "q") draw(last);
    else $("chips") && draw(last);
  } catch (e) {
    $("chips").innerHTML = '<span class="chip bad">面板连不上 <b>' + esc(e.message) + "</b></span>";
  }
}

$("run").onclick = async () => {
  const btn = $("run");
  btn.disabled = true;
  btn.dataset.busy = "1";
  btn.textContent = "跑着…";
  try {
    const r = await fetch("/api/run", { method: "POST" });
    const j = await r.json();
    if (r.status === 409) btn.textContent = "有轮在跑";
    else btn.textContent = r.ok ? "写完 " + (j.written ?? 0) + " 条" : "失败";
  } catch {
    btn.textContent = "失败";
  } finally {
    delete btn.dataset.busy;
  }
  await refresh();
  setTimeout(() => { btn.disabled = false; btn.textContent = "跑一轮"; }, 2500);
};

$("q").onkeydown = async (ev) => {
  if (ev.key !== "Enter") return;
  const q = $("q").value.trim();
  if (!q) { delete last._hits; return draw(last); }
  const r = await fetch("/api/search?q=" + encodeURIComponent(q));
  const j = await r.json();
  // 要写回 last：refresh() 每 5 秒用 /api/state 整体覆盖一次，只放在临时对象里
  // 的话，搜索结果活不到 5 秒就被"最近条目"顶掉。
  last = { ...last, _hits: j.hits ?? [] };
  draw(last);
};

refresh();
setInterval(refresh, 5000);
</script>
</body></html>`;

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {(log:Function)=>Promise<any>} [opts.runRound] 传了就显示"跑一轮"；不传也能点，走独立跑法
 */

/**
 * 这个请求是不是面板自己发的。
 *
 * 没有 Origin 的是非浏览器客户端（curl、脚本），放行——它们要伪造也拦不住，
 * 而这个服务只绑 127.0.0.1。有 Origin 的就必须是 loopback：跨站页面 POST localhost
 * 是能打进来的（响应读不到，但"跑一轮"这个副作用照样发生）。
 */
function fromThisPage(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

export function startUi({ port = 7787, host = "127.0.0.1", runRound } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    };

    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(PAGE);
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        return json(200, await state());
      }
      if (req.method === "GET" && url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        // 和 CLI 走同一个函数：面板搜到的跟 `mem search` 搜到的必须是一回事，
        // 而且命中要记进 memory.hit，那是「这条记忆还活着」的唯一真实信号。
        return json(200, await searchEntries({ q, limit: 30 }));
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
