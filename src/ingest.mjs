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
 */
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { drop, ingestKey, pending } from "./inbox.mjs";
import { searchEntries } from "./search.mjs";

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
  // 检索实现可替换：测试里不该为了验鉴权去连一个真的思源。
  search = searchEntries,
  log = () => {},
} = {}) {
  const loopback = bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
  if (!loopback && !token) {
    throw new Error(
      `拒绝启动：监听 ${bind} 但没配 token。\n` +
        "  写入通道不能裸奔。跑一次 mem ingest setup 会自动生成 token，或把 bind 改回 127.0.0.1。"
    );
  }
  if (token) {
    // 模板里的那句中文占位符（「自己生成一个长串…」）非空，startIngest 原来只判空，
    // 于是复制一份模板就等于"鉴权已开启"，而那个 token 全世界都知道。
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
    if (!token) {
      // 没配 token 时只认真正的本机直连。有两条都得查：
      //
      //   1. socket 来源是回环；
      //   2. Host 也是回环名。
      //
      // 只看 bind 是不够的：反向代理转发进来的请求 socket 本来就是 127.0.0.1。
      // 只看代理头也不够：那些头是客户端可以不给的，nginx 裸 proxy_pass 默认也不加
      // （实测：不带任何代理头、Host 写 mem.example.com，原来能直接写进队列）。
      // Host 是 HTTP/1.1 必带的，代理转发时一般会保留外部域名，所以它是这里最可靠的
      // 一个信号。三者任一不对就要求 token。
      const proxied = Boolean(
        req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers.forwarded
      );
      const remote = req.socket?.remoteAddress ?? "";
      const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
      const hostLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
      if (local && !proxied && hostLocal) return { ok: true };
      return { ok: false, code: 403, error: "服务端没配 token，只接受本机直连（来源、代理头、Host 任一不对就拒）" };
    }
    return sameToken(given, token) ? { ok: true } : { ok: false, code: 401, error: "token 不对" };
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
    if (status && status !== "current" && status !== "superseded") {
      return json(res, 400, { error: "status 只能是 current / superseded / 空" });
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
      });
      log(`  检索 ${JSON.stringify(q).slice(0, 40)} → ${r.hits.length} 条`);
      return json(res, 200, { ok: true, q, terms: r.terms, count: r.hits.length, hits: r.hits });
    } catch (e) {
      // 500 但带原因：边缘那边要能分清「中心坏了」和「确实没有这条」。
      log(`  检索失败：${e.message}`);
      return json(res, 500, { error: `检索失败：${e.message}` });
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
      // 配了 token 就要求带上：否则这个接口会白告出「auth:false + 队列长度」，
      // 等于给扫描器一个确认"这台机器有记忆库且没设密码"的探针。
      if (token) {
        const gate = auth(req);
        if (!gate.ok) return json(res, gate.code, { error: gate.error });
        return json(res, 200, { ok: true, name: "siyuan-mem", queue: pending().length });
      }
      return json(res, 200, { ok: true, name: "siyuan-mem" });
    }

    if (url.pathname === "/api/search") return handleSearch(req, res, url);

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
