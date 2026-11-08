/**
 * MCP server（stdio）：把召回做成 harness 能直接调的工具。
 *
 * 之前只有两条召回通道，都只能活在同一台机器上：`mem search`（直连思源跑 SQL）
 * 和 DSH 插件（hook 注入，也是直连思源）。公司那台机器上，Claude Code 既没有
 * 思源也没有这个仓库的配置，所以记忆对它是不可见的。
 *
 * 这里只做一层皮：工具调用 → 检索 → 拼成人读的文本。检索本身走 search.mjs，
 * 本机自己就是中心时直连，边缘机器上走 /api/search。
 *
 * 两个约束值得写在这里：
 *
 * 1. **stdout 只能有协议消息。** 任何调试输出都得走 stderr，否则客户端解析到
 *    一行非 JSON 就断开，表现是「插件装上了但不生效」，而且不报错。
 * 2. **返回给人读的文本，不返回 JSON。** 工具结果会被塞进模型上下文，
 *    `{"entity":"…","score":3.2}` 这种结构既费 token 又不帮它判断；条目本来
 *    就是一句人话，原样给就好。
 */
import { createInterface } from "node:readline";

const PROTOCOL = "2024-11-05";
const SERVER = { name: "siyuan-mem", version: "0.1.0" };

export const TOOL = {
  name: "memory_search",
  description:
    "检索本机积累的长期记忆（跨会话、跨项目的历史结论）。适合在「之前这个是怎么定的」" +
    "「上次踩过什么坑」「这个项目用过哪些方案」这类问题之前先查一次。" +
    "返回条目正文、话题、日期和原文指针；没有命中就是真的没记过。",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "关键词，空格分隔。中文不用分词，直接写词；多个词是「都要出现」。",
      },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "最多返回几条，默认 8。" },
      topic: { type: "string", description: "只查某个话题（实体名）下的条目。" },
      project: { type: "string", description: "只查某个项目下的条目（按会话的工作目录归的）。" },
      days: { type: "integer", description: "只看最近 N 天。" },
      include_superseded: {
        type: "boolean",
        description: "连已被新结论取代的旧条目一起看。查「当初为什么改」时用。",
      },
    },
    required: ["query"],
  },
};

/** 工具结果：条目原文 + 话题/日期/原文指针。截断是为了别把上下文塞满。 */
export function formatHits(hits, terms = []) {
  if (!hits?.length) {
    return `没找到相关记忆${terms.length ? `（检索词：${terms.join(" / ")}）` : ""}。`;
  }
  const lines = [`找到 ${hits.length} 条` + (terms.length ? `（检索词：${terms.join(" / ")}）` : "") + "："];
  hits.forEach((h, i) => {
    // 话题和项目经常是同一个词（「订货系统」既当话题又当目录），重复写两遍很吵。
    const head = [h.entity || "未归类", h.project && h.project !== h.entity ? `@${h.project}` : "", h.date || "", h.type || ""]
      .filter(Boolean)
      .join(" · ");
    lines.push("");
    lines.push(`${i + 1}. ${head}`);
    if (h.brief) lines.push(`   摘要：${h.brief}`);
    const text = String(h.text ?? "");
    if (text && text !== h.brief) {
      lines.push(`   ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`);
    }
    if (h.raw) lines.push(`   原文：${h.raw}`);
  });
  return lines.join("\n");
}

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * 处理一条消息。通知（没有 id）返回 null——不能回，回了客户端会当成孤儿响应。
 *
 * @param {object} msg
 * @param {{search:(o:object)=>Promise<{hits:any[],terms:string[]}>}} io
 */
export async function handleMessage(msg, { search } = {}) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return err(msg?.id ?? null, -32600, "不是 JSON-RPC 2.0");
  }
  const { id, method, params } = msg;
  const notify = id === undefined || id === null;

  if (typeof method !== "string") return notify ? null : err(id, -32600, "缺 method");

  if (method === "initialize") {
    return ok(id, {
      // 回**我们支持的**版本，不是客户端说的那个。原来无脑回显客户端给的字符串，
      // 等于承诺"你这个版本的语义我也懂"——而实际只实现了 2024-11-05。客户端
      // 会据此用新版本的字段发消息，然后我们解析不了，表现是"连上了但不响应"。
      // 规范允许服务端回一个较低版本，客户端不支持就自己断开，那是明确失败。
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
  }
  if (method.startsWith("notifications/")) return null;
  if (method === "ping") return ok(id, {});

  if (method === "tools/list") return ok(id, { tools: [TOOL] });

  if (method === "tools/call") {
    const name = params?.name;
    if (name !== TOOL.name) return err(id, -32602, `没有这个工具：${name}`);
    const a = params?.arguments ?? {};
    const q = String(a.query ?? "").trim();
    if (!q) {
      return ok(id, { content: [{ type: "text", text: "缺 query：要查什么？" }], isError: true });
    }
    if (typeof search !== "function") {
      return ok(id, { content: [{ type: "text", text: "检索层没接上（内部错误）。" }], isError: true });
    }
    try {
      const r = await search({
        q,
        limit: a.limit,
        topic: a.topic || undefined,
        project: a.project || undefined,
        days: a.days,
        // include_superseded → status=""（过时的也要）；否则交给默认的 current。
        status: a.include_superseded ? "" : undefined,
      });
      return ok(id, { content: [{ type: "text", text: formatHits(r.hits, r.terms) }] });
    } catch (e) {
      // 错误也走 result + isError：MCP 的 error 字段是协议层错误，
      // 检索失败属于工具执行失败，模型看到原因还能换个词再试。
      return ok(id, { content: [{ type: "text", text: `检索失败：${e.message}` }], isError: true });
    }
  }

  return notify ? null : err(id, -32601, `没有这个方法：${method}`);
}

/**
 * 从 stdin 逐行读，逐行回。写完要 flush，否则客户端等在那里。
 *
 * 串行处理：请求之间没有依赖，但并发写 stdout 会让两条 JSON 交错成一行。
 */
export function startMcp({ search, input = process.stdin, output = process.stdout, log = () => {} } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let chain = Promise.resolve();

  const send = (obj) => {
    if (obj) output.write(`${JSON.stringify(obj)}\n`);
  };

  rl.on("line", (line) => {
    const s = line.trim();
    if (!s) return;
    chain = chain.then(async () => {
      let msg;
      try {
        msg = JSON.parse(s);
      } catch {
        send(err(null, -32700, "JSON 解不开"));
        return;
      }
      try {
        send(await handleMessage(msg, { search }));
      } catch (e) {
        log(`处理 ${msg?.method ?? "?"} 出错：${e.stack ?? e.message}`);
        send(err(msg?.id ?? null, -32603, `内部错误：${e.message}`));
      }
    });
  });

  rl.on("close", () => {
    // 客户端关掉 stdin 就是「我走了」。等手上的请求回完再退，不然最后一条会丢。
    chain.then(() => log("客户端断开，退出"));
  });

  return { close: () => rl.close() };
}
