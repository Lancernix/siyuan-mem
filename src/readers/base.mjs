/**
 * 共用层：把"一行一个事件"的日志，变成一条条带 role 和 text 的发言。
 *
 * 这一层只放四家都成立的东西：怎么解压、怎么找消息节点、role 怎么归一、
 * 什么是注入块、怎么对账。各家特有的判断不写在这里，写成 hooks 由上层注入——
 * 否则改一家的规则会波及另外三家。
 *
 * 上层（src/readers/<harness>.mjs）只声明差异：
 *   sessionIdOf / cwdOf / isSubagentLine / isSubagentFile / roleOf / dropKind
 */
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

/* ---------- 文本清洗 ---------- */

const REMINDER = /<system-reminder[\s\S]*?<\/system-reminder>/g;
const CONTEXT_TAGS = /<(?:user_info|craft_mode|additional-data|current_time|wecom_wedrive_references)[\s\S]*?<\/(?:user_info|craft_mode|additional-data|current_time|wecom_wedrive_references)>/g;

/**
 * 上下文压缩后的纪要，会以 user 角色回放。一条能到 48 万字。
 * 它是"之前聊过什么的摘要"，不是用户说的话；当成提问抽，抽出来的是纪要的纪要。
 */
export const INJECTED_BLOCK = /^\s*<(?:cb_summary|conversation_history_summary|task-notification)\b/;

/**
 * 只做三件事：丢掉伪装成用户消息的注入块、剥掉 system-reminder 这类外壳、压掉多余空行。
 *
 * 不截断，一个字都不截。走到这里的每一段都是用户真说的话或模型真说的话，也就是唯一
 * 不可再生的语料；截断是不可逆的有损压缩，写时丢掉的东西，读的时候任何模型都救不回来。
 * 长度问题在抽取那一侧按批切开处理，不在采集这一侧砍。
 */
export function cleanUserText(text) {
  const raw = String(text ?? "");
  if (INJECTED_BLOCK.test(raw)) return "";
  return raw
    .replace(REMINDER, "")
    .replace(CONTEXT_TAGS, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 模型侧同样不截断，只去首尾空白。 */
export function cleanAssistantText(text) {
  return String(text ?? "").trim();
}

/* ---------- 读文件：DSH 的日志是多帧 zstd ---------- */

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 多帧 zstd 追加写。
 *
 * Node 的 zstdDecompressSync 和 createZstdDecompress 都只解第一帧，而且不报错：
 * 1MB 的文件解出 243 字节，看起来像成功了。必须自己按帧魔数切开逐帧解。
 */
function unzstd(buf) {
  const cuts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) cuts.push(i);
  }
  if (!cuts.length) return zlib.zstdDecompressSync(buf).toString("utf8");
  const parts = [];
  for (let k = 0; k < cuts.length; k++) {
    const seg = buf.subarray(cuts[k], cuts[k + 1] ?? buf.length);
    try {
      parts.push(zlib.zstdDecompressSync(seg));
    } catch {
      // 魔数落进压缩数据里是可能的。这一段解不开，就并到下一段一起重试。
      if (k + 1 < cuts.length) {
        cuts.splice(k + 1, 1);
        k--;
      }
    }
  }
  return Buffer.concat(parts).toString("utf8");
}

/** 按扩展名或文件头判断要不要解压。 */
export function readText(file) {
  const buf = readFileSync(file);
  if (file.endsWith(".zstd") || file.endsWith(".zst") || buf.subarray(0, 4).equals(ZSTD_MAGIC)) {
    return unzstd(buf);
  }
  return buf.toString("utf8");
}

/** 读成 JSON 行。坏行跳过：日志可能在写的时候被读到，最后一行通常是半截。 */
export function readJsonLines(file) {
  const lines = [];
  for (const line of readText(file).split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      lines.push(JSON.parse(s));
    } catch {
      // 见上
    }
  }
  return lines;
}

/* ---------- 消息的形状 ---------- */

export const ROLE_ALIAS = {
  user: "user", human: "user", prompt: "user", input: "user",
  assistant: "assistant", ai: "assistant", model: "assistant", bot: "assistant", output: "assistant",
};

/**
 * 一条消息挂在哪个节点上。候选挨个试，谁有 role 用谁。
 *
 *   WorkBuddy  role/content 在顶层
 *   Qoder/CC   message.role / message.content
 *   OMP        message.role / message.content
 *   DSH        data.role / data.content（assistant 还多一层 data.message）
 */
export function messageNode(d) {
  for (const c of [d?.message, d?.data?.message, d?.data, d]) {
    if (c && typeof c === "object" && typeof c.role === "string") return c;
  }
  return null;
}

const TEXT_BLOCK = /^(text|input_text|output_text)$/;

/** content 可能是字符串，也可能是块数组；只要文本块，thinking 和 tool 结果一律跳。 */
export function blocksToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && typeof p.text === "string" && TEXT_BLOCK.test(p.type ?? "text"))
    .map((p) => p.text)
    .join("\n");
}

export function blockChars(b) {
  if (typeof b === "string") return b.length;
  if (!b || typeof b !== "object") return 0;
  if (typeof b.text === "string") return b.text.length;
  if (typeof b.thinking === "string") return b.thinking.length;
  if (typeof b.content === "string") return b.content.length;
  return 0;
}

/* ---------- 子代理回报 ---------- */

/**
 * 工具调用 id → 工具名。
 *
 * Claude Code 的 tool_result 里只有 tool_use_id，名字在上一轮的 tool_use 块里，
 * 不建这张表就无法判断"这条结果是不是子代理交回来的"。
 */
export function toolUseMap(lines) {
  const map = new Map();
  for (const d of lines) {
    const m = messageNode(d);
    const blocks = Array.isArray(m?.content) ? m.content : [];
    for (const b of blocks) {
      if (/^(tool_use|tool_call|tooluse|function_call)$/i.test(b?.type ?? "") && b?.id && b?.name) {
        map.set(b.id, b.name);
      }
    }
  }
  return map;
}

/** 这些工具名背后是一个子代理，它的返回是结论，不是工具噪音。 */
export const DELEGATE_TOOL = /^(task|agent|subagent|delegate|delegate_task|spawn|vibe_wait)$/i;

/**
 * 子代理交回来的那份总结。
 *
 * 子代理自己的会话日志整份不读（它和主线是两个话题），但它的**结论**会回到主会话：
 * Claude Code 是 Task 工具的 tool_result，OMP 是 job 工具结果里包一段 `<task-result>`。
 * 这份东西是把子代理丢掉的前提——不认它，丢的就是结论本身。
 */
export function delegationText(m, idToName) {
  const blocks = Array.isArray(m?.content) ? m.content : [];
  let name = String(m?.toolName ?? m?.name ?? "");
  let text = "";
  const collect = (s) => {
    if (s) text += (text ? "\n" : "") + s;
  };
  for (const b of blocks) {
    if (typeof b === "string") {
      collect(b);
      continue;
    }
    if (b?.toolName) name ||= String(b.toolName ?? "");
    if (!name && b?.tool_use_id) name = idToName.get(b.tool_use_id) ?? "";
    // OMP 把工具输出放在 type=text 的块里，Claude 放在 tool_result 块里，两种都要认。
    if (/tool_?result/i.test(b?.type ?? "")) {
      const c = b?.content;
      collect(
        typeof c === "string" ? c
          : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("\n")
          : typeof b?.text === "string" ? b.text : "",
      );
    } else if (typeof b?.text === "string") {
      collect(b.text);
    }
  }
  if (!text) return "";
  // 派发回执和参数校验报错不是结论。"Spawned agent X — the result will be delivered later"
  // 这类只有一行，收进去就是纯噪音。
  if (/^\s*(Spawned agent|Validation failed for tool|Still Running)/.test(text)) return "";
  if (/<task-result[ >]/.test(text) || DELEGATE_TOOL.test(name)) return text;
  return "";
}

/* ---------- 默认行为 ---------- */

export const DEFAULT_HOOKS = {
  sessionIdOf: (d) => d?.sessionId ?? d?.id ?? "",
  cwdOf: (d) => d?.cwd ?? "",
  /** 单条消息级子代理标记（Claude/Qoder 的 isSidechain）。 */
  isSubagentLine: () => false,
  /** 整份文件级子代理标记（DSH 的 delegationDepth）。 */
  isSubagentFile: () => false,
  roleOf: (m) => ROLE_ALIAS[String(m?.role ?? "").toLowerCase()] ?? null,
  /**
   * 这条消息该不该丢，丢的话归到哪一类。
   * 返回 null 表示收下；返回 "tool" / "injected" 表示丢，并用于对账归类。
   */
  dropKind: () => null,
};

/**
 * 把事件流变成发言流。
 *
 * @param {object[]} lines
 * @param {object} hooks 上层各家的差异，见 DEFAULT_HOOKS
 * @returns {{turns:{role:string,text:string}[], sessionId:string, cwd:string, skipped?:string}}
 */
export function walkMessages(lines, hooks = {}) {
  const h = { ...DEFAULT_HOOKS, ...hooks };
  const idToName = toolUseMap(lines);
  let sessionId = "";
  let cwd = "";

  if (h.isSubagentFile(lines)) {
    const first = lines[0] ?? {};
    return { turns: [], sessionId: h.sessionIdOf(first) ?? "", cwd: "", skipped: "subagent" };
  }

  const turns = [];
  for (const d of lines) {
    sessionId ||= h.sessionIdOf(d) ?? "";
    cwd ||= h.cwdOf(d) ?? "";
    if (h.isSubagentLine(d)) continue;

    const m = messageNode(d);
    if (!m) continue;

    // 子代理回报：以结论的身份进语料，别当成工具输出扔掉。
    const report = delegationText(m, idToName);
    if (report) {
      turns.push({ role: "assistant", text: `（子代理回报）${cleanAssistantText(report)}` });
      continue;
    }

    const role = h.roleOf(m, d);
    if (!role) continue;

    const raw = blocksToText(m.content);
    const clean = role === "user" ? cleanUserText(raw) : cleanAssistantText(raw);
    if (!clean) continue;
    if (h.dropKind(m, raw, clean, d)) continue;
    turns.push({ role, text: clean });
  }
  return { turns, sessionId, cwd };
}

/**
 * 逐块对账：收进语料多少字，丢了多少字，为什么丢。
 *
 * walkMessages 只回答"留下了什么"，回答不了"有没有悄悄漏掉"。这里把每条消息的每个块
 * 都归一次类，五类相加等于日志里全部消息文字；剩下的只有 id、时间戳、模型名这类结构字段。
 * 哪天冒出第六类，就说明出现了没认出来的新格式。
 *
 * 必须和 walkMessages 用同一套 hooks，否则两边对不上——账上说收了，实际一条都没写。
 */
export function auditWalks(lines, hooks = {}) {
  const h = { ...DEFAULT_HOOKS, ...hooks };
  const acc = { kept: 0, thinking: 0, tool: 0, injected: 0, other: 0, events: 0, keeps: 0, skipped: 0 };
  const add = (k, n) => { acc[k] += n; };

  if (h.isSubagentFile(lines)) {
    for (const d of lines) {
      acc.events++;
      const m = messageNode(d);
      const blocks = Array.isArray(m?.content) ? m.content : [];
      for (const b of blocks) add("injected", blockChars(b));
    }
    acc.skipped = 1;
    return acc;
  }

  const idToName = toolUseMap(lines);
  for (const d of lines) {
    acc.events++;
    if (h.isSubagentLine(d)) { add("injected", JSON.stringify(d).length); continue; }

    const m = messageNode(d);
    if (!m) {
      // 没有 role 的结构性事件：只关心带正文的（OMP 的 handoff、DSH 的 system/message）。
      const own = typeof d?.content === "string" ? d.content : "";
      if (!own) continue;
      const typed = String(d?.type ?? "");
      add(/system|developer|inbox|spliced|compaction|custom/.test(typed) ? "injected" : "other", own.length);
      continue;
    }

    const report = delegationText(m, idToName);
    if (report) { add("kept", report.length); acc.keeps++; continue; }

    const rawRole = String(m.role ?? "").toLowerCase();
    const role = h.roleOf(m, d);
    // 不是对话角色的消息：工具结果、系统/开发者注入。先按角色定性，再看块类型。
    const roleCat = /tool/.test(rawRole) ? "tool" : /system|developer|agent/.test(rawRole) ? "injected" : null;

    const blocks = Array.isArray(m.content)
      ? m.content
      : typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : [];

    for (const b of blocks) {
      const t = typeof b === "string" ? "text" : (b?.type ?? "text");
      const n = blockChars(b);
      if (!n) continue;
      if (roleCat) { add(roleCat, n); continue; }
      if (!role) { add("other", n); continue; }
      if (t === "thinking" || t === "reasoning") { add("thinking", n); continue; }
      if (!TEXT_BLOCK.test(t)) { add("tool", n); continue; }

      const raw = String(b.text ?? "");
      const clean = role === "user" ? cleanUserText(raw) : cleanAssistantText(raw);
      const drop = h.dropKind(m, raw, clean, d);
      if (drop) { add(drop, n); continue; }
      if (!clean) { add("injected", n); continue; }
      add("kept", clean.length);
      acc.keeps++;
    }
  }
  return acc;
}
