/**
 * 接收端：别的机器把解析好的会话推到这台机器上。
 *
 * 只做三件事：验 token、限大小、写进队列。抽取不在这里做——边缘机器没有模型
 * key，也不该有；prompt 只维护一份，改一次所有机器都跟着变。
 *
 * 这是写入通道，不是只读面板。没有 token 就绑 0.0.0.0 等于把记忆库的写权限
 * 摆在公网上，所以 startIngest 会直接拒绝这种组合。
 *
 * 除了写，这里还挂了 `/api/search`：边缘机器的 harness 够不着思源，检索也得
 * 从中心走。它复用同一个端口和同一个 token——一台机器对中心只有一个地址，
 * 配两套只会多一个配错的地方。检索失败不回 5xx 的默认页面，必须带原因，
 * 否则边缘那边只看到「查不到」，和「真的没有这条记忆」分不开。
 *
 * 另外两个只读接口 `/api/topics` 和 `/api/entries` 是导航层（列话题 / 按话题翻
 * 条目），和检索共用同一套鉴权与失败语义。它们不是「换个姿势搜索」：边缘机器上
 * 的 agent 需要能先发现命名空间，才知道该拿哪些词去 `/api/search`。
 */
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { drop, ingestKey, pending } from "./inbox.mjs";
import { searchEntries } from "./search.mjs";
import { listTopics, listEntries } from "./browse.mjs";
import { archiveEntries } from "./archive.mjs";
import { STATUSES } from "./store.mjs";
import { failureText } from "./search-reason.mjs";
import { normalizeSource } from "../util/source.mjs";

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function sameToken(a, b) {
  // 先各自摘要再比，长度就一致了，也不需要担心比较耗时泄露前缀长度。
  const ha = createHash("sha256").update(String(a ?? "")).digest();
  const hb = createHash("sha256").update(String(b ?? "")).digest();
  return timingSafeEqual(ha, hb);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return; // 已经拒了，剩下的丢掉（不占内存，但也别让 socket 卡住）
      size += c.length;
      if (size > maxBytes) {
        tooBig = true;
        chunks.length = 0;
        reject(
          Object.assign(new Error(`请求超过 ${Math.round(maxBytes / 1048576)}MB`), {
            status: 413,
            // 413 之后这条连接不能复用：请求体没读干净。
            close: true,
          })
        );
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 把收到的包整理成队列项；字段不认识就丢掉，不让外部决定内部形状。 */
function normalize(body, fallbackMachine = "") {
  const turns = Array.isArray(body?.turns) ? body.turns : [];
  const clean = [];
  for (const t of turns) {
    const role = t?.role === "assistant" ? "assistant" : t?.role === "user" ? "user" : null;
    const text = typeof t?.text === "string" ? t.text : "";
    if (!role || !text.trim()) continue;
    clean.push({ role, text });
  }
  return {
    payload: {
      session_id: String(body?.session_id ?? "").slice(0, 200) || `remote-${Date.now()}`,
      harness: String(body?.harness ?? "").slice(0, 40),
      machine: String(body?.machine ?? fallbackMachine).slice(0, 60),
      cwd: String(body?.cwd ?? "").slice(0, 500),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(body?.date ?? "")) ? body.date : new Date().toISOString().slice(0, 10),
      // 推送方给的 [from, to) 是 0-based 下标，换算成 1-based 的起始轮次。
      // 少了这个，增量推过来的每一包都会被当成「从第 1 轮开始」，原文指针全错位。
      turnFrom: Array.isArray(body?.range) && Number.isFinite(Number(body.range[0])) ? Number(body.range[0]) + 1 : 1,
      // 会话里调用过几次 mem 自己的 MCP 工具。旧版本边缘不会推这个字段，缺省按 0。
      memTools: Math.max(0, Math.min(9999, Number(body?.mem_tools) || 0)),
      turns: clean,
    },
    chars: clean.reduce((n, t) => n + t.text.length, 0),
  };
}

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.bind
 * @param {string} opts.token          空则只允许绑 loopback
 * @param {number} opts.maxBytes
 * @param {(line:string)=>void} opts.log
 */
export function startIngest({
  port,
  bind = "127.0.0.1",
  token = "",
  maxBytes = 24 * 1024 * 1024,
  // 检索/导航实现可替换：测试里不该为了验鉴权去连一个真的思源。
  search = searchEntries,
  topics = listTopics,
  entries = listEntries,
  // 归档也是写操作，和抽取一样只能由中心执行：边缘机器没有思源，也不该有。
  archive = archiveEntries,
  log = () => {},
} = {}) {
  // 没有 token 一律不启动，绑回环也一样。靠 socket 来源 + 代理头 + Host 判断是不是
  // 本机直连不成立：nginx 裸 proxy_pass 默认不加 X-Forwarded-For、还把 Host 改成
  // 127.0.0.1——而「反代 + 回环」正是部署文档推荐的姿势。
  if (!token) {
    throw new Error(
      "拒绝启动：接收端必须有 token（绑回环也一样）。\n" +
        "  生成一个：mem center setup --rotate，或 openssl rand -base64 24 写进 config.ingest.token"
    );
  }
  {
    // 模板里的中文占位符非空，只判空的话「复制一份模板」就等于「鉴权已开启」，
    // 而那个 token 全世界都知道。
    if (/[^\x20-\x7e]/.test(token)) {
      throw new Error(
        "拒绝启动：token 里含非 ASCII 字符，看着像配置模板里的说明文字。\n" +
          "  生成一个真的：mem center setup --rotate（或 openssl rand -base64 24）"
      );
    }
    if (token.length < 16) {
      throw new Error(`拒绝启动：token 只有 ${token.length} 个字符，公网上一分钟就能撞开。至少 16 位。`);
    }
  }

  /** 两条接口共用一套鉴权：写能写就能读，反过来不成立。 */
  function auth(req) {
    const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || req.headers["x-mem-token"] || "";
    // token 是必须的（启动时已经强制），这里只比对。
    return sameToken(given, token) ? { ok: true } : { ok: false, code: 401, error: "token 不对" };
  }

  /** GET / POST 的参数，三个只读接口共用。 */
  async function readParams(req, res, url) {
    if (req.method === "GET") return { ok: true, p: Object.fromEntries(url.searchParams) };
    if (req.method === "POST") {
      try {
        return { ok: true, p: JSON.parse(await readBody(req, 64 * 1024)) ?? {} };
      } catch (e) {
        if (e.close) res.setHeader("connection", "close");
        return { ok: false, error: e.status ? e.message : `JSON 读不出来：${e.message}`, status: e.status ?? 400 };
      }
    }
    return { ok: false, error: "只读接口用 GET 或 POST", status: 405 };
  }

  /**
   * 导航接口：/api/topics 列目录、/api/entries 按话题翻条目。
   *
   * 和 handleSearch 共用鉴权、status 白名单、以及「后端坏了回 5xx 带原因」——
   * 边缘那边必须能分清「中心坏了」和「这个话题真的没内容」，这两句长得一样。
   */
  async function handleBrowse(req, res, url, kind) {
    const a = auth(req);
    if (!a.ok) return json(res, a.code, { error: a.error });
    const params = await readParams(req, res, url);
    if (!params.ok) return json(res, params.status, { error: params.error });
    const p = params.p;

    if (kind === "entries" && !String(p.topic ?? "").trim()) {
      return json(res, 400, { error: "缺 topic：先用 /api/topics 看有哪些话题" });
    }
    const all = p.all === 1 || p.all === true || p.all === "1" || p.all === "true" || p.status === "";
    const status = all ? "" : p.status || undefined;
    if (status && !STATUSES.has(status)) {
      return json(res, 400, { error: `status 只能是 ${[...STATUSES].join(" / ")} / 空` });
    }
    const days = Number(p.days);
    const impl = kind === "topics" ? topics : entries;
    try {
      const r = await impl({
        q: p.q ?? p.query ?? "",
        topic: p.topic || undefined,
        limit: p.limit,
        days: Number.isFinite(days) && days > 0 ? days : undefined,
        status,
        // 透传来源并归一：边缘 agent 用的是 MCP，不能记成 api；任意外部字符串
        // 也不能造出无限个 bySource 桶。缺省时按 HTTP 调用算 api。
        source: normalizeSource(p.source, "api"),
      });
      if (r.failed) {
        log(`  导航失败 ${kind}：${r.reason}${r.detail ? `（${String(r.detail).slice(0, 80)}）` : ""}`);
        return json(res, 503, { error: `检索失败：${failureText(r.reason, r.detail)}` });
      }
      log(`  导航 ${kind} ${kind === "topics" ? `q=${String(r.q ?? "").slice(0, 24)}` : `topic=${String(r.topic ?? "").slice(0, 24)}`} → ${r.shown ?? 0} 项`);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      log(`  导航失败 ${kind}：${e.message}`);
      return json(res, 500, { error: `检索失败：${e.message}` });
    }
  }

  /** @returns {Promise<boolean>} 处理完返回 true */
  async function handleSearch(req, res, url) {
    const a = auth(req);
    if (!a.ok) return json(res, a.code, { error: a.error });

    let p = {};
    if (req.method === "GET") {
      p = Object.fromEntries(url.searchParams);
    } else if (req.method === "POST") {
      try {
        p = JSON.parse(await readBody(req, 64 * 1024)) ?? {};
      } catch (e) {
        if (e.close) res.setHeader("connection", "close");
        return json(res, e.status ?? 400, { error: e.status ? e.message : `JSON 读不出来：${e.message}` });
      }
    } else {
      return json(res, 405, { error: "检索用 GET 或 POST" });
    }

    const q = String(p.q ?? p.query ?? "").trim();
    if (!q) return json(res, 400, { error: "缺 q：要查什么" });
    const days = Number(p.days);
    // all=1 / status="" 表示连过时的一起看；其它情况交给 searchEntries 默认。
    const all = p.all === 1 || p.all === true || p.all === "1" || p.all === "true" || p.status === "";
    const status = all ? "" : p.status || undefined;
    // 先拦一道：status 会被拼进 SQL，非法值不能等到 searchEntries 里才炸。
    if (status && !STATUSES.has(status)) {
      return json(res, 400, { error: `status 只能是 ${[...STATUSES].join(" / ")} / 空` });
    }

    try {
      const r = await search({
        q,
        limit: p.limit,
        topic: p.topic || undefined,
        project: p.project || undefined,
        type: p.type || undefined,
        days: Number.isFinite(days) && days > 0 ? days : undefined,
        status,
        // mcp，否则同一串调用被拆成两种来源。
        source: normalizeSource(p.source, "api"),
      });
      // 后端故障必须回 5xx：边缘那边才会显示「检索失败」并重试，而不是把
      // 「中心坏了」当成「确实没有这条记忆」。
      if (r.failed) {
        log(`  检索失败：${r.reason}${r.detail ? `（${String(r.detail).slice(0, 80)}）` : ""}`);
        return json(res, 503, { error: `检索失败：${failureText(r.reason, r.detail)}` });
      }
      log(`  检索 ${JSON.stringify(q).slice(0, 40)} → ${r.hits.length} 条${r.hint ? "（话题没对上）" : ""}`);
      return json(res, 200, { ok: true, q, terms: r.terms, count: r.hits.length, hits: r.hits, hint: r.hint ?? "" });
    } catch (e) {
      // 500 但带原因：边缘那边要能分清「中心坏了」和「确实没有这条」。
      log(`  检索失败：${e.message}`);
      return json(res, 500, { error: `检索失败：${e.message}` });
    }
  }

  /**
   * 归档：写操作，和 /api/ingest 一样只收 POST、必须带 token。
   *
   * 边缘的 MCP 只能从这里改状态——它那台机器上没有思源。参数原样交给
   * archiveEntries，结果也原样回去：CLI 和 MCP 的渲染各写各的，判断逻辑只有一份。
   */
  async function handleArchive(req, res) {
    const a = auth(req);
    if (!a.ok) return json(res, a.code, { error: a.error });
    if (req.method !== "POST") return json(res, 405, { error: "归档用 POST" });

    let p;
    try {
      p = JSON.parse(await readBody(req, 64 * 1024)) ?? {};
    } catch (e) {
      if (e.close) res.setHeader("connection", "close");
      return json(res, e.status ?? 400, { error: e.status ? e.message : `JSON 读不出来：${e.message}` });
    }

    const bool = (v) => v === true || v === 1 || v === "1" || v === "true";
    const ids = Array.isArray(p.ids) ? p.ids : p.id ? [p.id] : [];
    const list = bool(p.list);
    if (!ids.length && !p.topic && !p.session && !list) {
      return json(res, 400, { error: "要给 ids / topic / session 之一，或 list=true" });
    }

    try {
      const r = await archive({
        ids,
        topic: p.topic,
        session: p.session,
        reason: p.reason,
        confirm: bool(p.confirm),
        undo: bool(p.undo),
        list,
        limit: p.limit,
        source: normalizeSource(p.source, "api"),
      });
      // 后端坏了回 5xx：边缘那边要能说「归档没成功」，不是「这些条目不存在」。
      if (r.failed) {
        log(`  归档失败：${r.reason}${r.detail ? `（${String(r.detail).slice(0, 80)}）` : ""}`);
        return json(res, 503, { error: `归档失败：${failureText(r.reason, r.detail)}` });
      }
      log(`  归档 ${r.mode}${r.scope ? ` ${r.scope}` : ""} → ${r.count} 条${r.needsConfirm ? "（待确认）" : ""}`);
      return json(res, 200, r);
    } catch (e) {
      log(`  归档失败：${e.message}`);
      return json(res, 500, { error: `归档失败：${e.message}` });
    }
  }

  const server = http.createServer(async (req, res) => {
    // Host 可能是畸形值。`new URL()` 在 try 外面抛，就是一个没人接的异常，
    // 常驻进程会直接死——而这是写入通道，死了等于整个中心停止收数据。
    let url;
    try {
      const host = req.headers.host ?? "";
      url = new URL(req.url ?? "/", `http://${host || "127.0.0.1"}`);
    } catch {
      return json(res, 400, { error: "请求头不合法" });
    }

    if (req.method === "GET" && url.pathname === "/api/ping") {
      // 也要求带 token：否则这个接口会白告出队列长度，等于给扫描器一个
      // 确认"这台机器有记忆库"的探针。
      const gate = auth(req);
      if (!gate.ok) return json(res, gate.code, { error: gate.error });
      return json(res, 200, { ok: true, name: "siyuan-mem", queue: pending().length });
    }

    if (url.pathname === "/api/search") return handleSearch(req, res, url);
    if (url.pathname === "/api/topics") return handleBrowse(req, res, url, "topics");
    if (url.pathname === "/api/entries") return handleBrowse(req, res, url, "entries");
    if (url.pathname === "/api/archive") return handleArchive(req, res);

    if (url.pathname !== "/api/ingest") return json(res, 404, { error: "没有这个接口" });
    if (req.method !== "POST") return json(res, 405, { error: "只接 POST" });

    const gate = auth(req);
    if (!gate.ok) return json(res, gate.code, { error: gate.error });

    // 探针：只验地址和 token，不需要构造一个假会话。`mem push --test` 用它。
    if (url.searchParams.get("probe")) {
      return json(res, 200, { ok: true, probe: true, queue: pending().length });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req, maxBytes));
    } catch (e) {
      if (e.close) res.setHeader("connection", "close");
      return json(res, e.status ?? 400, { error: e.status ? e.message : `JSON 读不出来：${e.message}` });
    }

    const { payload, chars } = normalize(body, "");
    if (!payload.turns.length) return json(res, 400, { error: "turns 里没有有效的问答" });
    if (!payload.machine) return json(res, 400, { error: "缺 machine：推过来必须能分清是哪台机器" });

    const r = drop(payload, { key: ingestKey(payload) });
    if (!r.duplicate) {
      log(`  收到 ${payload.machine}/${payload.harness || "?"}  ${payload.turns.length} 轮 ${chars} 字  ${payload.session_id}`);
    }
    return json(res, 200, {
      ok: true,
      duplicate: r.duplicate,
      session_id: payload.session_id,
      accepted: r.duplicate ? 0 : payload.turns.length,
      chars: r.duplicate ? 0 : chars,
      queue: pending().length,
    });
  });

  server.on("error", (e) => {
    log(`  接收端起不来：${e.code === "EADDRINUSE" ? `端口 ${port} 被占用` : e.message}`);
    if (e.code === "EADDRINUSE") process.exitCode = 1;
  });
  server.listen(port, bind);
  // port 传 0 时真实端口要等 listening 之后才知道，所以 url 用 getter。
  const addr = () => {
    const a = server.address();
    return a && typeof a === "object" ? `${a.address}:${a.port}` : `${bind}:${port}`;
  };
  return {
    get url() {
      return `http://${addr()}`;
    },
    close: () => new Promise((r) => server.close(r)),
    get listening() {
      return server.listening;
    },
  };
}
