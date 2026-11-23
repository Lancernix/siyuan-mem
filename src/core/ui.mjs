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
import { isIP } from "node:net";
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
import { alerts as listAlerts, clear as clearAlerts } from "./alerts.mjs";
import { pathOf, dayOf } from "../util/log.mjs";
import { statSync } from "node:fs";

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
      // dates 用 Map 计数：一个 session 只跨一天就是普通会话，跨多天说明这里的
      // session 其实是个长期会话 ID（老数据的常见情况），下面按日期再切一刀。
      g = { id: sid, count: 0, last: "", project: "", machine: "", dates: new Map() };
      groups.set(sid, g);
    }
    g.count++;
    const date = attrOf(r.ial, ATTR.date) || "";
    if (date) g.dates.set(date, (g.dates.get(date) ?? 0) + 1);
    if (date > g.last) g.last = date;
    if (!g.project) g.project = attrOf(r.ial, ATTR.project) || "";
    if (!g.machine) g.machine = attrOf(r.ial, ATTR.machine) || "";
  }

  const out = [];
  for (const g of groups.values()) {
    if (g.dates.size <= 1) {
      out.push({ id: g.id, count: g.count, last: g.last, project: g.project, machine: g.machine });
      continue;
    }
    // 跨天的会话：一天一行，id 用 sid@date，取条目时按日期再过一遍。
    for (const [date, count] of g.dates) {
      out.push({ id: `${g.id}@${date}`, session: g.id, date, count, last: date, project: g.project, machine: g.machine, split: true });
    }
  }
  return out
    .sort((a, b) => String(b.last).localeCompare(String(a.last)) || b.count - a.count)
    .slice(0, limit);
}

/** 一场会话抽出的条目。字段与 /api/entries 保持一致，前端能共用一套渲染。 */
async function sessionEntries(rawSid, limit = 100) {
  const [sid, date] = String(rawSid).split("@");
  const clean = sid.replace(/[^a-zA-Z0-9_-]/g, "");
  const dayFilter = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? `AND ial LIKE '%${ATTR.date}="${date}"%'` : "";
  const { sy, cfg } = open();
  const notebook = await resolveNotebookId(sy, cfg);
  const rows = await sy.sql(
    `SELECT id, content, ial FROM blocks
      WHERE type='p' AND box='${notebook}' AND ial LIKE '%${ATTR.hash}="%'
        AND ial LIKE '%${ATTR.session}="${clean}"%'
        AND ial NOT LIKE '%${ATTR.status}="archived"%' ${dayFilter}
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
    alerts: {
      webhook: cfg.ui?.alertWebhook
        ? `${String(cfg.ui.alertWebhook).slice(0, 24)}…（已配置）`
        : "未配置",
      configured: Boolean(cfg.ui?.alertWebhook || process.env.MEM_ALERT_WEBHOOK),
    },
    params: {
      extract: cfg.extract ?? {},
      serve: cfg.serve ?? {},
      raw: { enabled: cfg.raw?.enabled !== false, dir: cfg.raw?.dir ?? "mem-raw" },
    },
    prompt: { text: p.text, version: p.version, source: p.source, warnings: p.warnings ?? [] },
    promptHistory: promptHistory().slice(0, 10),
  };
}

/** 按日期聚合：时间线视图用。同一天抽了什么，比按话题翻更接近"这些天在关心什么"。 */
async function daySummaries(limit = 120) {
  const { sy, cfg } = open();
  const notebook = await resolveNotebookId(sy, cfg);
  const rows = await sy.sql(
    `SELECT ial FROM blocks
      WHERE type='p' AND box='${notebook}' AND ial LIKE '%${ATTR.hash}="%'
        AND ial NOT LIKE '%${ATTR.status}="archived"%'
      ORDER BY updated DESC LIMIT 5000`
  );
  if (!Array.isArray(rows)) return [];
  const counts = new Map();
  for (const r of rows) {
    const d = attrOf(r.ial, ATTR.date);
    if (!d) continue;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ id: date, date, count, last: date }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, limit);
}

/** 某一天抽出的条目。 */
async function dayEntries(date, limit = 100) {
  const clean = String(date).replace(/[^0-9-]/g, "");
  const { sy, cfg } = open();
  const notebook = await resolveNotebookId(sy, cfg);
  const rows = await sy.sql(
    `SELECT id, content, ial FROM blocks
      WHERE type='p' AND box='${notebook}' AND ial LIKE '%${ATTR.hash}="%'
        AND ial LIKE '%${ATTR.date}="${clean}"%'
        AND ial NOT LIKE '%${ATTR.status}="archived"%'
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

/**
 * 今天的写入/合并计数，用来在面板上盯「合并率」。
 *
 * 合并率 = covered / (写入 + covered)：判重吃掉的候选占全部的比例。太高说明
 * 抽取在重复造同一批东西，或者判重把新信息误判成旧信息——两种都要人看一眼。
 * 按文件 mtime+size 缓存，面板每 10 秒轮询不会反复读几 MB 日志。
 */
let todayCache = { key: "", value: null };
function todayCounts() {
  const file = pathOf(dayOf());
  let st;
  try {
    st = statSync(file);
  } catch {
    return { written: 0, covered: 0, dedupeFailed: 0, mergeRate: 0 };
  }
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  if (todayCache.key === key) return todayCache.value;

  let written = 0, covered = 0, dedupeFailed = 0;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.ev === "entry.write") written++;
      else if (e.ev === "entry.skip" && e.reason === "covered") covered++;
      else if (e.ev === "dedupe.failed") dedupeFailed++;
    }
  } catch {
    // 读不动就当没数据，不要因为统计把面板带挂。
  }
  const total = written + covered;
  const value = { written, covered, dedupeFailed, mergeRate: total ? Math.round((covered / total) * 100) : 0 };
  todayCache = { key, value };
  return value;
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
    alerts: listAlerts(),
    today: todayCounts(),
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
    // 两端都归一化成 hostname 再比：反代常把 Host 写成 `MEM.EXAMPLE.COM:443` 或
    // 小写化的域名，字符串全等比会把合法的同源 POST 全判成跨站。
    const hostName = String(req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    if (u.hostname.toLowerCase() === hostName) return true;
    return ["127.0.0.1", "localhost", "::1"].includes(u.hostname.toLowerCase());
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
 * Basic 口令的失败限速。
 *
 * 面板挂在公网域名后面，Basic 没有限速就等于让人无限猜。只放内存里：重启就清零，
 * 不值得为这种小事再落一个文件。按 IP 记 5 分钟内 10 次失败，超了回 429。
 */
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
  // 用 isIP 而不是字符集正则：`beef.cafe`、`abc.de` 也全是 a-f 和点，
  // 正则放行等于给域名开了后门（实测 200）。
  if (bound === "0.0.0.0" || bound === "::") return isIP(name) !== 0 || name === "localhost";
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
const authFails = new Map();
const AUTH_WINDOW_MS = 5 * 60_000;
const AUTH_MAX_FAILS = 10;

function clientIp(req) {
  return String(req.socket?.remoteAddress ?? "unknown");
}

function authBlockedFor(req) {
  const r = authFails.get(clientIp(req));
  if (!r) return 0;
  if (Date.now() >= r.until) {
    authFails.delete(clientIp(req));
    return 0;
  }
  return r.n >= AUTH_MAX_FAILS ? Math.max(1, Math.ceil((r.until - Date.now()) / 1000)) : 0;
}

function authFailed(req) {
  const ip = clientIp(req);
  const r = authFails.get(ip);
  if (!r || Date.now() >= r.until) authFails.set(ip, { n: 1, until: Date.now() + AUTH_WINDOW_MS });
  else r.n++;
  // 极端情况下别让这张表无限长：清一遍过期的。
  if (authFails.size > 2000) {
    for (const [k, v] of authFails) if (Date.now() >= v.until) authFails.delete(k);
  }
}


  const server = http.createServer(async (req, res) => {
    // 点一下就归档、跑一轮的面板不该被别的站点套进 iframe 里点。
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "frame-ancestors 'none'; base-uri 'none'");
    const url = new URL(req.url, "http://localhost");
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    };

    try {
      if (!hostOk(req, host, allowHosts)) {
        return json(403, { error: `不认这个 Host（${String(req.headers.host ?? "")}）：用 IP 或 localhost 访问，或启动时加 --allow-host` });
      }
      const wait = auth ? authBlockedFor(req) : 0;
      if (wait) {
        res.setHeader("retry-after", String(wait));
        return json(429, { error: `口令错太多次，${wait} 秒后再试` });
      }
      if (auth && !authOk(req, auth)) {
        authFailed(req);
        res.writeHead(401, {
          "www-authenticate": 'Basic realm="siyuan-mem", charset="UTF-8"',
          "content-type": "text/plain; charset=utf-8",
        });
        return res.end("需要登录");
      }
      if (auth) authFails.delete(clientIp(req));
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
      if (req.method === "GET" && url.pathname === "/api/days") {
        try {
          return json(200, { days: await daySummaries() });
        } catch (e) {
          return json(503, { error: `列日期失败：${e.message}` });
        }
      }
      if (req.method === "GET" && url.pathname === "/api/day") {
        const date = url.searchParams.get("date") ?? "";
        if (!date) return json(400, { error: "要给 date" });
        try {
          return json(200, { hits: await dayEntries(date) });
        } catch (e) {
          return json(503, { error: `翻日期失败：${e.message}` });
        }
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
        // 保存前先看端点：探活会把现有 key 发到这个地址，允许任意 http 地址等于
        // 把 key 交给别人（也是受限 SSRF）。只放行 https，或本机/内网已知的 http。
        const base = String(b.base ?? "").trim();
        if (base) {
          try {
            const u = new URL(base);
            const local = ["127.0.0.1", "localhost", "[::1]", "::1", "magpie"].includes(u.hostname);
            if (u.protocol !== "https:" && !local) {
              return json(400, { error: "端点必须是 https；只有本机或 magpie 这类内网地址允许 http" });
            }
          } catch {
            return json(400, { error: "端点地址写错了" });
          }
        }
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
        // 上下限一起管：只有下限的话 maxMinutesPerRound: 1e9 等于把单轮预算关掉。
        const LIMITS = {
          extract: {
            minTurnChars: [1, 10000],
            maxCharsPerCall: [1, 200000],
            maxEntriesPerBatch: [1, 100],
            // 默认就是 300：抽取时带进 prompt 的已有实体数。上限压到 100 的话，
            // 用户打开设置页什么都不改、点保存就会被自己配置的默认值 400 打回。
            entityShotList: [1, 500],
          },
          serve: {
            maxSessionsPerRound: [1, 1000],
            maxMinutesPerRound: [1, 1440],
            maxMinutesPerSession: [1, 1440],
            maxConsecutiveFailures: [1, 100],
            maxAttemptsPerSession: [1, 50],
          },
        };
        const patch = {};
        for (const k of [
          "minTurnChars",
          "maxCharsPerCall",
          "maxEntriesPerBatch",
          "entityShotList",
        ]) {
          if (b.extract?.[k] != null) {
            const n = Number(b.extract[k]);
            const [lo, hi] = LIMITS.extract[k];
            if (!Number.isFinite(n) || n < lo || n > hi) return json(400, { error: `extract.${k} 要在 ${lo} 到 ${hi} 之间` });
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
          if (b.serve?.[k] != null) {
            const n = Number(b.serve[k]);
            const [lo, hi] = LIMITS.serve[k];
            if (!Number.isFinite(n) || n < lo || n > hi) return json(400, { error: `serve.${k} 要在 ${lo} 到 ${hi} 之间` });
            (patch.serve ??= {})[k] = n;
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
      if (req.method === "POST" && url.pathname === "/api/settings/alerts") {
        if (!fromThisPage(req)) return json(403, { error: "只接受面板自己发起的请求" });
        const b = await readBody(req);
        const raw = String(b.webhook ?? "").trim();
        if (raw) {
          let u;
          try {
            u = new URL(raw);
          } catch {
            return json(400, { error: "Webhook 地址写错了" });
          }
          if (u.protocol !== "https:") return json(400, { error: "Webhook 必须是 https" });
        }
        saveConfig({ ui: { alertWebhook: raw } });
        return json(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/alerts/clear") {
        if (!fromThisPage(req)) return json(403, { error: "只接受面板自己发起的请求" });
        clearAlerts(url.searchParams.get("kind") ?? "");
        return json(200, { ok: true });
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
