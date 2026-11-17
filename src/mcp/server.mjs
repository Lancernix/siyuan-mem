/**
 * MCP server（stdio）：把召回做成 harness 能直接调的工具。
 *
 * 这里只做一层皮：工具调用 → 检索/导航 → 拼成人读的文本。本机自己就是中心时直连，
 * 边缘机器上走中心接口。
 *
 * 三条约束：
 *
 * 1. **stdout 只能有协议消息。** 调试输出一律走 stderr，否则客户端解析到一行非 JSON
 *    就断开，表现是「装上了但不生效」，而且不报错。
 * 2. **返回人读文本，不返回 JSON。** 工具结果会进模型上下文，结构化字段既费 token
 *    又不帮它判断。
 * 3. **路由写进工具 description。** 三个工具各自说清什么时候用我、什么时候换别人，
 *    空结果给可操作的兜底——不依赖客户端的系统提示词。
 */
import { createInterface } from "node:readline";
import { emptyText, failureText } from "../core/search-reason.mjs";

const PROTOCOL = "2024-11-05";

/**
 * 给客户端注入的用法说明。
 *
 * 关键是「触发条件」而不是功能描述：模型不缺一个叫 memory_search 的函数，
 * 缺的是「这种问法该去查」的判断。所以按用户的原话举例子，越具体越容易被认出来。
 */
const INSTRUCTIONS = `这个 MCP 提供一套跨会话的长期记忆（历史结论、决定、踩过的坑）。遇到下面这些情况，先查再答，别凭印象：
- 用户说「之前 / 上次 / 以前 / 当初 / 我们说好」「不是定过吗」「记不记得」
- 问某个决定、方案、配置为什么是这样，而这个项目之前讨论过
- 要给具体值（版本、端口、路径、参数），而你手上没有当前来源
用法：memory_search 是默认入口，有关键词就直接搜；没命中或不知道话题叫什么，先 memory_topics 看目录，再用 memory_entries 翻该话题下的条目。引用记忆时带上它的日期和话题，方便核对。查不到就说没记过，别编。`;
const SERVER = { name: "siyuan-mem", version: "0.1.0" };

/**
 * 三个工具都只读本机记忆库，annotation 逐项写死，不吃规范默认值：
 * `destructiveHint` 默认是 true、`openWorldHint` 默认是 true，不声明就会被当成
 * 「可能删数据、可能访问开放世界」，客户端每次都弹确认，目录审核也会退回。
 *
 * 审计日志不计入「修改环境」：三个工具都只在 ~/.siyuan-mem/logs 追加一行使用记录
 * （查了什么、命中几条，不含正文），且是 try/catch 包住的旁路——写失败不影响结果，
 * 也不碰思源里的任何数据。所以 readOnlyHint 仍是 true。
 *
 * annotations 是 2025-03-26 才进的规范。这里不顺手把 protocolVersion 也提上去：
 * 那个版本还要求处理 JSON-RPC 批量（数组）请求，我们没实现，报了就是假承诺。
 * 老客户端解析时忽略不认识的字段，新客户端照读——加在这里是纯增量，不破坏任何人。
 */
const readOnly = (title) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

/**
 * 工具清单：一个主入口 + 两个导航工具。
 *
 * 描述里必须写清互相的路由，否则多给工具等于没给：模型不知道什么时候该换一个，
 * 就会一直用最眼熟的那个。
 */
export const SEARCH_TOOL = {
  name: "memory_search",
  annotations: readOnly("搜索记忆"),
  description:
    "【默认入口】检索本机积累的长期记忆（跨会话、跨项目的历史结论）。知道要找什么词时直接用这个：" +
    "「之前这个是怎么定的」「上次踩过什么坑」「这个项目用过哪些方案」。" +
    "返回条目正文、话题、日期和原文指针。\n" +
    "什么时候换工具：不确定话题叫什么、或这里没命中 → 先用 memory_topics 看目录；" +
    "已经知道话题名、想把这个话题下记过的东西整整齐齐翻一遍 → 用 memory_entries。" +
    "拿到话题名后也可以把它填进本工具的 topic 参数缩小范围。",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        // 不能再说「多个词都要出现」：查询理解改成 OR 粗筛 + 强词门槛之后，
        // 多写几个词是「越多越容易命中、相关性由排序决定」，不是 AND。
        // 描述写错会让 agent 只敢写一个词，白白丢掉区分度。
        description:
          "关键词，空格分隔。中文不用分词，直接写词；多写几个词更容易命中，相关性由排序决定。" +
          "型号、文件名、参数名这类标识符照原样写（NO.2 / burn_tokens），会被当成硬约束。",
      },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "最多返回几条，默认 8。" },
      topic: {
        type: "string",
        description: "只查某个话题（实体名）下的条目。名字拿不准就先用 memory_topics 查；支持别名和已合并的旧名。",
      },
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

export const TOPICS_TOOL = {
  name: "memory_topics",
  annotations: readOnly("列出话题"),
  description:
    "列出记忆库里有哪些话题（实体名）、别名、每个话题下有多少条、最近什么时候更新。" +
    "用于**发现命名空间**：不确定话题叫什么、memory_search 没命中或结果不对、" +
    "或者用户问的是「这套记忆都记了些什么」时先看这里。\n" +
    "下一步：把话题名填进 memory_search 的 topic 参数，或用 memory_entries(topic=…) " +
    "把这个话题下的条目全翻出来。找具体某一条结论请回到 memory_search——目录里没有正文。\n" +
    "q 是可选的过滤提示，不是精确匹配：没匹配上会返回最活跃的话题作为兜底浏览，不会空手。",
  inputSchema: {
    type: "object",
    properties: {
      q: { type: "string", description: "可选。话题名/别名里包含这段就列出；不填就按活跃度列最前面的。" },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "最多列几个话题，默认 20，上限 50。" },
      include_superseded: {
        type: "boolean",
        description: "连只挂在已过时条目上的话题一起统计。默认只看当前有效的条目。",
      },
    },
  },
};

export const ENTRIES_TOOL = {
  name: "memory_entries",
  annotations: readOnly("按话题翻条目"),
  description:
    "按话题把条目逐条翻出来，**不走关键词门槛**：只要挂在这个话题下就返回，按日期从新到旧。" +
    "用于 memory_search 没命中但你知道话题名、或用户问「这个话题之前都记了什么」的时候。" +
    "topic 支持别名和已合并的旧名；名字没对上时会给出最接近的候选，不会静默返回空。\n" +
    "下一步：想找其中某条具体结论、或跨话题比对，用 memory_search(query=…, topic=…)；" +
    "想换话题就用 memory_topics 查目录。目录太长时用 days 或 limit 缩小（上限 20 条）。",
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "话题名，必填。用 memory_topics 查到的规范名最稳。" },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "最多列几条，默认 8，上限 20。" },
      days: { type: "integer", description: "只看最近 N 天。" },
      include_superseded: {
        type: "boolean",
        description: "连已被新结论取代的旧条目一起看。查「当初为什么改」时用。",
      },
    },
    required: ["topic"],
  },
};

export const TOOLS = [SEARCH_TOOL, TOPICS_TOOL, ENTRIES_TOOL];
/** @deprecated 用 TOOLS；保留给按单工具写的调用方与测试。 */
export const TOOL = SEARCH_TOOL;

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** 条目列表的渲染，search / entries 两个工具共用一份，免得一处截断一处不截断。 */
function hitLines(hits) {
  const lines = [];
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
  return lines;
}

/** 工具结果：条目原文 + 话题/日期/原文指针。截断是为了别把上下文塞满。 */
export function formatHits(hits, terms = [], hint = "", reason = "") {
  if (!hits?.length) {
    // 话题没解析到的时候，光说「没找到」会让人以为库里没内容。把原因和候选一起给，
    // 模型才知道是该换个话题名，还是这个话题真的空。
    const tail = hint ? `\n${hint}` : "";
    // 「问了句废话」也单独说：模型看到「没找到」只会换个近义词再试，
    // 告诉它「这几个词不承载信息」才能让它真的换说法。
    const why = emptyText(reason, terms);
    if (why) return `没找到相关记忆。${why}${tail}`;
    return `没找到相关记忆${terms.length ? `（检索词：${terms.join(" / ")}）` : ""}。${tail}`;
  }
  const lines = [`找到 ${hits.length} 条` + (terms.length ? `（检索词：${terms.join(" / ")}）` : "") + "："];
  lines.push(...hitLines(hits));
  // 空手时的导航出口在 handleMessage 里追加：那是工具分发的决策，不是渲染函数的活。
  return lines.join("\n");
}

/** 目录：名字 + 别名 + 条目数 + 最近更新 + 匹配依据 + 下一步。 */
export function formatTopics(r) {
  const lines = [];
  if (!r.topics?.length) {
    lines.push("话题目录是空的：库里还没有可用的条目。");
    lines.push("下一步：用 memory_search 直接搜内容；如果连它也没结果，检查写入链路（mem status）是不是在跑。");
    return lines.join("\n");
  }
  lines.push(
    r.fallback
      ? `没有匹配「${r.q}」的话题。库里共 ${r.total} 个，下面是最活跃的 ${r.shown} 个兜底浏览（不是匹配结果）：`
      : `话题目录：共 ${r.total} 个，列出 ${r.shown} 个` +
          (r.q ? `（过滤提示「${r.q}」）` : "") +
          (r.truncated ? `，还有没列出的` : "") +
          "，按条目数从多到少。"
  );
  r.topics.forEach((t, i) => {
    const alias = t.aliases?.length ? `（别名：${t.aliases.join(" / ")}）` : "";
    const why = t.match === "alias" ? " [别名命中]" : t.match === "fallback" ? " [兜底浏览]" : t.match === "name" ? " [名字命中]" : "";
    lines.push(`${i + 1}. ${t.name}${alias} — ${t.count} 条 · 最近 ${t.last || "未知"}${why}`);
  });
  if (r.truncated)
    lines.push(
      r.fallback
        ? `还有更多话题没列出：换个更短的词再过滤，或把 limit 调到最多 50。`
        : `还有更多话题没列出：用 q 缩小范围，或把 limit 调到最多 50。`
    );
  if (r.hint) lines.push(r.hint);
  // 结果自带下一步，不用模型再猜一轮（mcp-adapter 的「执行建议」）。
  lines.push(
    "下一步：把话题名填进 memory_search 的 topic 参数，或用 memory_entries(topic=…) 翻出这个话题下的条目；" +
      "想找具体某条结论请回到 memory_search。"
  );
  return lines.join("\n");
}

/** 按话题翻条目：头部说清范围与依据，尾部给下一步。 */
export function formatEntries(r) {
  const lines = [];
  if (!r.hits?.length) {
    if (r.unknown) {
      lines.push(r.hint || `没有「${r.topic}」这个话题。`);
      lines.push("下一步：用 memory_topics 查准名字再试，或直接用 memory_search(query=…) 搜内容。");
    } else {
      lines.push(`话题「${r.canonical || r.topic}」下没有条目。`);
      lines.push("可能都被 days 过滤掉了，或只剩已被取代的旧条目——试试放宽 days / include_superseded。");
      lines.push("下一步：用 memory_topics 换一个话题，或用 memory_search(query=…) 直接搜内容。");
    }
    if (r.hint && !r.unknown) lines.push(r.hint);
    return lines.join("\n");
  }
  lines.push(
    `话题「${r.canonical || r.topic}」下共 ${r.total} 条，列出 ${r.shown} 条` +
      (r.truncated ? "（还有没列出的）" : "") +
      "，按日期从新到旧。"
  );
  if (r.hint) lines.push(r.hint);
  lines.push(...hitLines(r.hits));
  if (r.truncated) lines.push(`还有更多条目没列出：把 limit 调到最多 20，或用 days 只看最近 N 天。`);
  lines.push(
    `下一步：想找其中某条具体结论，用 memory_search(query=…, topic="${r.canonical || r.topic}")；` +
      "想换话题用 memory_topics。"
  );
  return lines.join("\n");
}

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** 工具结果统一在这里收口：failed 不能渲染成「没有」。 */
function toolResult(r, format) {
  if (r.failed) {
    return { content: [{ type: "text", text: `检索失败：${failureText(r.reason, r.detail)}。这不代表没记过，稍后重试。` }], isError: true };
  }
  return { content: [{ type: "text", text: format(r) }] };
}

/** 某个入口没把导航实现接上时，明确说「没接上」，别伪装成空目录。 */
function missing(kind) {
  return { content: [{ type: "text", text: `${kind}没接上（这个入口只接了部分工具，内部错误）。` }], isError: true };
}

/**
 * 处理一条消息。通知（没有 id）返回 null——不能回，回了客户端会当成孤儿响应。
 *
 * @param {object} msg
 * @param {{search?:Function, topics?:Function, entries?:Function}} io
 *   三个实现由入口注入：本机直连思源时用 core 的函数，边缘机器上走中心接口。
 *   分开注入是为了让协议壳的测试不需要真的连思源。
 */
export async function handleMessage(msg, { search, topics, entries } = {}) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return err(msg?.id ?? null, -32600, "不是 JSON-RPC 2.0");
  }
  const { id, method, params } = msg;
  const notify = id === undefined || id === null;

  if (typeof method !== "string") return notify ? null : err(id, -32600, "缺 method");

  if (method === "initialize") {
    return ok(id, {
      // 回我们支持的版本，不回显客户端给的版本：回显等于承诺「你这个版本的语义
      // 我也懂」，客户端会据此发新字段，然后解析不了，表现是连上了但不响应。
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER,
      // 这段会被客户端注入模型上下文（MCP 规范里的 instructions）。没有它，工具
      // 就是三个躺在列表里的函数——2026-11-09 到 11-17 八天，除了一次配置验证，
      // 没有任何一次主动检索：模型不知道「什么时候该翻旧账」。
      instructions: INSTRUCTIONS,
    });
  }
  if (method.startsWith("notifications/")) return null;
  if (method === "ping") return ok(id, {});

  if (method === "tools/list") return ok(id, { tools: TOOLS });

  if (method === "tools/call") {
    const name = params?.name;
    // 不认识的工具要把可用清单一起给：模型拼错名字时能自己纠，而不是收到一句
    // 「没有这个工具」然后卡住（mcp-adapter 的未知工具引导）。
    if (!byName.has(name)) {
      return err(id, -32602, `没有这个工具：${name}。可用：${TOOLS.map((t) => t.name).join(" / ")}`);
    }
    const a = params?.arguments ?? {};

    if (name === SEARCH_TOOL.name) {
      const q = String(a.query ?? "").trim();
      if (!q) {
        return ok(id, { content: [{ type: "text", text: "缺 query：要查什么？" }], isError: true });
      }
      if (typeof search !== "function") return ok(id, missing("检索层"));
      try {
        const r = await search({
          q,
          limit: a.limit,
          topic: a.topic || undefined,
          project: a.project || undefined,
          days: a.days,
          // include_superseded → status=""（过时的也要）；否则交给默认的 current。
          status: a.include_superseded ? "" : undefined,
          // 来源分开记：agent 真的在用，还是人在 CLI 里调试，看日志分得清。
          source: "mcp",
        });
        // 后端坏了不能回「没找到」：模型会把它当成「库里没记过」直接回答用户。
        // isError 让客户端知道这是工具失败，值得重试或报警。
        if (r.failed) return ok(id, toolResult(r, formatHits));
        let text = formatHits(r.hits, r.terms, r.hint, r.reason);
        // 空手时给一条具体的导航出口，别让模型继续换近义词瞎试。
        if (!r.hits?.length && !r.failed) {
          text += "\n下一步：不确定话题叫什么就先用 memory_topics 看目录，再用 memory_entries 按话题翻条目。";
        }
        return ok(id, { content: [{ type: "text", text }] });
      } catch (e) {
        // 错误也走 result + isError：MCP 的 error 字段是协议层错误，
        // 检索失败属于工具执行失败，模型看到原因还能换个词再试。
        return ok(id, { content: [{ type: "text", text: `检索失败：${e.message}` }], isError: true });
      }
    }

    if (name === TOPICS_TOOL.name) {
      if (typeof topics !== "function") return ok(id, missing("话题目录"));
      try {
        const r = await topics({
          q: a.q,
          limit: a.limit,
          status: a.include_superseded ? "" : undefined,
          source: "mcp",
        });
        return ok(id, toolResult(r, formatTopics));
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: `列话题失败：${e.message}` }], isError: true });
      }
    }

    if (name === ENTRIES_TOOL.name) {
      const topic = String(a.topic ?? "").trim();
      if (!topic) {
        return ok(id, {
          content: [{ type: "text", text: "缺 topic。先用 memory_topics 看有哪些话题，再把规范名传进来。" }],
          isError: true,
        });
      }
      if (typeof entries !== "function") return ok(id, missing("话题条目"));
      try {
        const r = await entries({
          topic,
          limit: a.limit,
          days: a.days,
          status: a.include_superseded ? "" : undefined,
          source: "mcp",
        });
        return ok(id, toolResult(r, formatEntries));
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: `翻条目失败：${e.message}` }], isError: true });
      }
    }
  }

  return notify ? null : err(id, -32601, `没有这个方法：${method}`);
}

/**
 * 从 stdin 逐行读，逐行回。写完要 flush，否则客户端等在那里。
 *
 * 串行处理：请求之间没有依赖，但并发写 stdout 会让两条 JSON 交错成一行。
 */
export function startMcp({ search, topics, entries, input = process.stdin, output = process.stdout, log = () => {} } = {}) {
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
        send(await handleMessage(msg, { search, topics, entries }));
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
