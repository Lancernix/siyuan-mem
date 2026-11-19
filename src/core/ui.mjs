/**
 * 一个本地面板：看状态、看条目、看队列，点一下跑一轮。
 *
 * 前端在 src/ui/ 下，原生 ESM 三个文件，零依赖零构建。面板的意义是"不用开终端就知道
 * 它在不在干活，也看得见库里有什么"；改正文去思源，那边才有编辑器。
 *
 * 默认只绑 127.0.0.1。绑到别的地址（放公网域名后面）必须同时给 --auth：这个面板
 * 会显示条目正文和日志，没有鉴权就暴露，等于把记忆库摊在网上。
 */
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { LOG_PATH, DEAD_DIR, INBOX_DIR, loadConfig, saveConfig } from "../util/config.mjs";
import { open } from "./jobs.mjs";
import { pending } from "./inbox.mjs";
import {
  PROVIDERS,
  resolveModel,
  resolveChain,
  hasModel,
  probe as probeModel,
  saveModelChoice,
  maskKey,
  usageToday,
} from "../util/llm.mjs";
import { lockInfo, roundStatus } from "./serve.mjs";
import { searchEntries } from "./search.mjs";
import { failureText } from "./search-reason.mjs";
import { listTopics, listEntries } from "./browse.mjs";
import { ATTR, attrOf } from "./store.mjs";
import { stripRawLink } from "../util/raw.mjs";
import { resolveNotebookId } from "../util/siyuan.mjs";
import { archiveEntries } from "./archive.mjs";
import { promptState } from "./extract.mjs";
import { history as promptHistory, savePrompt, restore as restorePrompt } from "./prompt.mjs";

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

/**
 * 死信队列。面板要能看到「哪些包卡住了、为什么」，不然只能上服务器翻目录。
 *
 * 只读头部：完整的会话可能有几 MB，抽屉里不需要。
 */
function deadPackages(limit = 20) {
  if (!existsSync(DEAD_DIR)) return { items: [], total: 0 };
  const files = readdirSync(DEAD_DIR).filter((f) => f.endsWith(".json"));
  const items = files.slice(0, limit).map((f) => {
    let meta = {};
    try {
      const d = JSON.parse(readFileSync(join(DEAD_DIR, f), "utf8"));
      meta = { session: d.session_id ?? "", harness: d.harness ?? "", turns: (d.turns ?? []).length };
    } catch {}
    let why = "";
    try {
      why = readFileSync(join(DEAD_DIR, `${f}.why`), "utf8").trim().split("\n")[1] ?? "";
    } catch {}
    return { file: f, ...meta, why };
  });
  return { items, total: files.length };
}

/**
 * 按会话把条目聚起来。抽取天然以会话为单位，一场往往产出三五条、散在几个话题里；
 * 按会话看才能回答"那天到底聊了什么、抽成了什么"。
 *
 * 只读 ial，不取正文：一场会话的全文可能几万字，目录不需要。
 */
async function sessionSummaries(limit = 100) {
  const { sy, cfg } = open();
  const notebook = await resolveNotebookId(sy, cfg);
  const rows = await sy.sql(
    `SELECT ial FROM blocks
      WHERE type='p' AND box='${notebook}' AND ial LIKE '%${ATTR.hash}="%'
        AND ial NOT LIKE '%${ATTR.status}="archived"%'
      ORDER BY updated DESC LIMIT 5000`
  );
  if (!Array.isArray(rows)) return [];
  const groups = new Map();
  for (const r of rows) {
    const sid = attrOf(r.ial, ATTR.session);
    if (!sid) continue;
    let g = groups.get(sid);
    if (!g) {
      g = { id: sid, count: 0, last: "", project: "", machine: "" };
      groups.set(sid, g);
    }
    g.count++;
    const date = attrOf(r.ial, ATTR.date) || "";
    if (date > g.last) g.last = date;
    if (!g.project) g.project = attrOf(r.ial, ATTR.project) || "";
    if (!g.machine) g.machine = attrOf(r.ial, ATTR.machine) || "";
  }
  return [...groups.values()]
    .sort((a, b) => String(b.last).localeCompare(String(a.last)) || b.count - a.count)
    .slice(0, limit);
}

/** 一场会话抽出的条目。字段与 /api/entries 保持一致，前端能共用一套渲染。 */
async function sessionEntries(sid, limit = 100) {
  const { sy, cfg } = open();
  const notebook = await resolveNotebookId(sy, cfg);
  const rows = await sy.sql(
    `SELECT id, content, ial FROM blocks
      WHERE type='p' AND box='${notebook}' AND ial LIKE '%${ATTR.hash}="%'
        AND ial LIKE '%${ATTR.session}="${sid.replace(/[^a-zA-Z0-9_-]/g, "")}"%'
      ORDER BY updated DESC LIMIT ${limit}`
  );
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const raw = attrOf(r.ial, ATTR.raw);
    return {
      id: r.id,
      entity: attrOf(r.ial, ATTR.entity),
      brief: attrOf(r.ial, ATTR.brief),
      date: attrOf(r.ial, ATTR.date),
      type: attrOf(r.ial, ATTR.type),
      confidence: attrOf(r.ial, ATTR.confidence),
      text: stripRawLink(r.content, raw),
      raw,
      session: attrOf(r.ial, ATTR.session),
      source: attrOf(r.ial, ATTR.source),
      project: attrOf(r.ial, ATTR.project),
      status: attrOf(r.ial, ATTR.status),
    };
  });
}

/** 读 JSON 请求体。提示词可能很长，给 40 万字上限，超了直接拒。 */
async function readBody(req, max = 400000) {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > max) throw new Error("请求体太大（超过 40 万字）");
  }
  try {
    return JSON.parse(s || "{}");
  } catch {
    throw new Error("不是合法的 JSON");
  }
}

/**
 * 设置页读到的配置：只回安全的字段，key 一律打码。
 * 面板挂在公网域名后面，明文 key 绝不能从 /api/* 流出去。
 */
function settingsView() {
  const cfg = loadConfig();
  const m = resolveModel(cfg);
  const p = promptState();
  return {
    model: {
      provider: m.provider,
      model: m.model,
      wire: m.wire,
      baseUrl: m.baseUrl || "",
      key:
        m.apiKeyFrom && m.apiKeyFrom !== "config"
          ? `环境变量 ${m.apiKeyFrom}`
          : maskKey(m.apiKey),
      configured: hasModel(cfg),
      jsonMode: Boolean(m.jsonMode),
      chain: resolveChain(cfg).map((x) => ({ provider: x.provider, model: x.model })),
    },
    providers: Object.entries(PROVIDERS).map(([id, v]) => ({
      id,
      model: v.model,
      wire: v.wire,
      baseUrl: v.baseUrl,
    })),
    params: {
      extract: cfg.extract ?? {},
      jobs: cfg.jobs ?? {},
      raw: { enabled: cfg.raw?.enabled !== false, dir: cfg.raw?.dir ?? "mem-raw" },
    },
    prompt: { text: p.text, version: p.version, source: p.source, warnings: p.warnings ?? [] },
    promptHistory: promptHistory().slice(0, 10),
  };
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
    dead: deadPackages(),
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
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const limit = Number(url.searchParams.get("limit")) || 100;
        try {
          return json(200, { sessions: await sessionSummaries(limit) });
        } catch (e) {
          return json(503, { error: `列会话失败：${e.message}` });
        }
      }
      if (req.method === "GET" && url.pathname === "/api/session") {
        const sid = url.searchParams.get("id") ?? "";
        if (!sid) return json(400, { error: "要给 id" });
        try {
          return json(200, { hits: await sessionEntries(sid) });
        } catch (e) {
          return json(503, { error: `翻会话失败：${e.message}` });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/archive") {
        if (!fromThisPage(req)) return json(403, { error: "只接受面板自己发起的请求" });
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
        const reason = url.searchParams.get("reason") ?? "面板归档";
        if (!ids.length) return json(400, { error: "要给 ids" });
        const r = await archiveEntries({ ids, reason, source: "ui" });
        if (r.failed) return json(409, { error: `归档失败：${failureText(r.reason, r.detail)}` });
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
      if (req.method === "GET" && url.pathname === "/api/settings") {
        try {
          return json(200, settingsView());
        } catch (e) {
          return json(500, { error: `读设置失败：${e.message}` });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/settings/model") {
        if (!fromThisPage(req)) return json(403, { error: "只接受面板自己发起的请求" });
        const b = await readBody(req);
        const provider = String(b.provider ?? "").trim();
        if (!provider) return json(400, { error: "要选一家 provider" });
        try {
          const m = saveModelChoice(provider, {
            apiKey: b.apiKey ? String(b.apiKey).trim() : "",
            model: b.name ? String(b.name).trim() : "",
            wire: b.wire ? String(b.wire).trim() : "",
            base: b.base ? String(b.base).trim() : "",
          });
          return json(200, {
            ok: true,
            provider: m.provider,
            model: m.model,
            key: maskKey(m.apiKey),
          });
        } catch (e) {
          return json(400, { error: e.message });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/settings/model/test") {
        if (!fromThisPage(req)) return json(403, { error: "只接受面板自己发起的请求" });
        if (!hasModel(loadConfig())) return json(409, { error: "没有可用的 key" });
        try {
          const r = await probeModel(loadConfig());
          return json(200, { ok: true, result: r });
        } catch (e) {
          return json(502, { error: `探活失败：${e.message}` });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/settings/params") {
        if (!fromThisPage(req)) return json(403, { error: "只接受面板自己发起的请求" });
        const b = await readBody(req);
        // 白名单：不让面板写 siyuan.token / ingest.token / push.token 这类凭据字段。
        const patch = {};
        for (const k of [
          "minTurnChars",
          "maxCharsPerCall",
          "maxEntriesPerBatch",
          "entityShotList",
        ]) {
          if (b.extract?.[k] != null) {
            const n = Number(b.extract[k]);
            if (!Number.isFinite(n) || n < 0) return json(400, { error: `extract.${k} 要是不小于 0 的数` });
            (patch.extract ??= {})[k] = n;
          }
        }
        for (const k of [
          "maxSessionsPerRound",
          "maxMinutesPerRound",
          "maxMinutesPerSession",
          "maxConsecutiveFailures",
          "maxAttemptsPerSession",
        ]) {
          if (b.jobs?.[k] != null) {
            const n = Number(b.jobs[k]);
            if (!Number.isFinite(n) || n < 0) return json(400, { error: `jobs.${k} 要是不小于 0 的数` });
            (patch.jobs ??= {})[k] = n;
          }
        }
        if (b.raw?.enabled != null) (patch.raw ??= {}).enabled = Boolean(b.raw.enabled);
        saveConfig(patch);
        return json(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/settings/prompt") {
        if (!fromThisPage(req)) return json(403, { error: "只接受面板自己发起的请求" });
        const b = await readBody(req);
        const text = String(b.text ?? "");
        if (!text.trim()) return json(400, { error: "提示词不能为空" });
        const r = savePrompt(text);
        return json(200, { ok: true, version: promptState().version, result: r });
      }
      if (req.method === "POST" && url.pathname === "/api/settings/prompt/restore") {
        if (!fromThisPage(req)) return json(403, { error: "只接受面板自己发起的请求" });
        const b = await readBody(req);
        const name = String(b.name ?? "");
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return json(400, { error: "版本号不对" });
        restorePrompt(name);
        return json(200, { ok: true, version: promptState().version });
      }
      if (req.method === "POST" && url.pathname === "/api/retry") {
        if (!fromThisPage(req)) return json(403, { error: "只接受面板自己发起的请求" });
        const all = url.searchParams.get("all") === "1";
        const one = url.searchParams.get("file") ?? "";
        if (!all && !one) return json(400, { error: "要给 all=1 或 file=<名字>" });
        const files = existsSync(DEAD_DIR) ? readdirSync(DEAD_DIR).filter((f) => f.endsWith(".json")) : [];
        const chosen = all ? files : files.filter((f) => f === one);
        if (!chosen.length) return json(404, { error: "死信里没有这个包" });
        let moved = 0;
        for (const f of chosen) {
          try {
            renameSync(join(DEAD_DIR, f), join(INBOX_DIR, f));
            moved++;
          } catch {
            // 单个挪失败不影响其它：返回实际挪走的数量，别谎报成功。
          }
        }
        return json(200, { ok: true, moved });
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
