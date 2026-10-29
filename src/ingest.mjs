/**
 * 接收端：别的机器把解析好的会话推到这台机器上。
 *
 * 只做三件事：验 token、限大小、写进队列。抽取不在这里做——边缘机器没有模型
 * key，也不该有；prompt 只维护一份，改一次所有机器都跟着变。
 *
 * 这是写入通道，不是只读面板。没有 token 就绑 0.0.0.0 等于把记忆库的写权限
 * 摆在公网上，所以 startIngest 会直接拒绝这种组合。
 */
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { drop, ingestKey, pending } from "./inbox.mjs";

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
export function startIngest({ port, bind = "127.0.0.1", token = "", maxBytes = 24 * 1024 * 1024, log = () => {} } = {}) {
  const loopback = bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
  if (!loopback && !token) {
    throw new Error(
      `拒绝启动：监听 ${bind} 但没配 token。\n` +
        "  写入通道不能裸奔。跑一次 mem ingest setup 会自动生成 token，或把 bind 改回 127.0.0.1。"
    );
  }

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host ?? "";
    const url = new URL(req.url ?? "/", `http://${host || "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/api/ping") {
      // 不带敏感信息：只用来确认"连得到、地址对不对"。
      return json(res, 200, { ok: true, name: "siyuan-mem", queue: pending().length, auth: Boolean(token) });
    }

    if (url.pathname !== "/api/ingest") return json(res, 404, { error: "没有这个接口" });
    if (req.method !== "POST") return json(res, 405, { error: "只接 POST" });

    const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || req.headers["x-mem-token"] || "";
    if (token && !sameToken(given, token)) return json(res, 401, { error: "token 不对" });
    if (!token && !loopback) return json(res, 403, { error: "服务端没配 token，只接受本机推送" });

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
