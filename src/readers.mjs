/**
 * 会话日志读取器。
 *
 * 插件采集只在装了插件的 harness 里有效。读日志这条路覆盖剩下的情况，
 * 也是插件坏掉时的兜底——日志是 append-only 的，harness 自己不会写丢。
 *
 * 只有一份读取器，不按 harness 分支。
 *
 * 本机实测五家（WorkBuddy / Qoder / OMP / DSH / Claude Code）：格式名字不同、字段位置不同、
 * 事件名不同，但每条消息都能归到同一个形状——有 role，有 content。所以按形状认比按名字认稳：
 * 新 harness 出来不用改代码。
 *
 * 之前写过四份专用适配器，和这份形状识别在全部 168 个本地会话上逐字节一致，
 * 于是删掉了。差异只剩两处，已经并进来：DSH 的 plugin: 注入标记、OMP 的 attribution。
 */
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

const REMINDER = /<system-reminder[\s\S]*?<\/system-reminder>/g;
/**
 * 这些块会以 user 角色回放，但根本不是用户说的话：
 * cb_summary / conversation_history_summary 是上下文压缩后的纪要（一条能到 48 万字），
 * task-notification 是后台任务完成通知。当成提问抽，抽出来的是纪要的纪要。
 */
const INJECTED_BLOCK = /^\s*<(?:cb_summary|conversation_history_summary|task-notification)\b/;

const CONTEXT_TAGS = /<(?:user_info|craft_mode|additional-data|current_time|wecom_wedrive_references)[\s\S]*?<\/(?:user_info|craft_mode|additional-data|current_time|wecom_wedrive_references)>/g;

const ROLE_ALIAS = {
  user: "user", human: "user", prompt: "user", input: "user",
  assistant: "assistant", ai: "assistant", model: "assistant", bot: "assistant", output: "assistant",
};

/**
 * 只做三件事：丢掉伪装成用户消息的注入块、剥掉 system-reminder 这类外壳、压掉多余空行。
 *
 * 不截断，一个字都不截。走到这里的每一段都是用户真说的话或模型真说的话，也就是唯一
 * 不可再生的语料；截断是不可逆的有损压缩，写时丢掉的东西，读的时候任何模型都救不回来。
 * 长度问题在抽取那一侧按批切开处理，不在采集这一侧砍。
 */
function cleanUserText(text) {
  const raw = String(text ?? "");
  if (INJECTED_BLOCK.test(raw)) return "";
  return raw
    .replace(REMINDER, "")
    .replace(CONTEXT_TAGS, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 模型侧同样不截断，只去首尾空白。 */
function cleanAssistantText(text) {
  return String(text ?? "").trim();
}

/* ---------- 文件读取：DSH 的日志是 zstd ---------- */

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * DSH 的会话是**多帧 zstd 追加写**的。
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

/* ---------- 一条消息挂在哪个节点上 ---------- */

/**
 * 候选节点挨个试，谁长得像消息就用谁。
 *
 *   WorkBuddy  role/content 在顶层
 *   Qoder/CC   message.role / message.content
 *   OMP        message.role / message.content
 *   DSH        data.role / data.content（assistant 还多一层 data.message）
 */
function messageNode(d) {
  for (const c of [d?.message, d?.data?.message, d?.data, d]) {
    if (c && typeof c === "object" && typeof c.role === "string") return c;
  }
  return null;
}

/** content 可能是字符串，也可能是块数组；只要文本块，thinking 和 tool 结果一律跳。 */
function blocksToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && typeof p.text === "string" && /^(text|input_text|output_text)$/.test(p.type ?? "text"))
    .map((p) => p.text)
    .join("\n");
}

/**
 * @returns {{turns:{role:string,text:string}[], sessionId:string, cwd:string, skipped?:string}}
 */
export function readMessages(lines) {
  const turns = [];
  let sessionId = "";
  let cwd = "";
  for (const d of lines) {
    sessionId ||= d?.sessionId ?? d?.id ?? "";
    cwd ||= d?.cwd ?? "";

    // 子代理：Claude/Qoder 标 isSidechain，OMP 用 parentSession 指向父会话。
    if (d?.isSidechain) continue;
    if (d?.type === "session" && d.parentSession) return { turns: [], sessionId, cwd, skipped: "subagent" };

    const m = messageNode(d);
    if (!m) continue;
    const role = ROLE_ALIAS[String(m.role).toLowerCase()];
    if (!role) continue;

    // 我们自己注入的上下文：认这个前缀，不然第二轮会把注入内容当用户说的话再抽一遍。
    const kind = m?.source?.kind;
    if (typeof kind === "string" && kind.startsWith("plugin:")) continue;
    if (kind === "tool") continue;
    // OMP 用 attribution 标来源，非 user 的是 agent 注入。
    if (role === "user" && m.attribution && m.attribution !== "user") continue;

    const text = blocksToText(m.content);
    const clean = role === "user" ? cleanUserText(text) : cleanAssistantText(text);
    if (!clean) continue;
    // 工具结果和文件快照会以 user 角色出现，拦掉。
    if (role === "user" && /^<(?:function_call|file-history)/.test(clean)) continue;
    turns.push({ role, text: clean });
  }
  return { turns, sessionId, cwd };
}

/**
 * 判断这是哪家的日志——只用来给条目打来源标签，不参与解析。
 *
 * 不能"第一个匹配就返回"：DSH 和 OMP 的第一行都是 {type:"session", version:n}，
 * 谁先判断谁赢，DSH 就被认成 OMP 了。所以先收集样本里出现过的全部事件名再判。
 */
export function sniff(lines) {
  const sample = lines.slice(0, 200);
  const types = new Set(sample.map((d) => d?.type).filter(Boolean));

  if (types.has("user/message") || types.has("assistant/message") || types.has("turn/start")) return "dsh";
  if (types.has("message")) {
    const m = sample.find((d) => d?.type === "message") ?? {};
    if (m.sessionId) return "workbuddy";
    if (m.message && typeof m.message === "object") return "omp";
  }
  if (types.has("workspace-directories") || types.has("runtime-config")) return "qoder";
  if (types.has("user") || types.has("assistant")) {
    const m = sample.find((d) => d?.type === "user" || d?.type === "assistant") ?? {};
    if (Array.isArray(m?.message?.content)) return "claude";
  }
  return "";
}

/** 允许用 --format 手动指定的来源名。只影响标签，不影响解析。 */
export const HARNESS_NAMES = ["workbuddy", "claude", "qoder", "omp", "dsh", "generic"];

/**
 * 读一个会话日志。format 留空则按内容嗅探（只影响标签）。
 * @returns {{turns:{role:string,text:string}[], sessionId:string, cwd:string, harness:string}}
 */
export function readLog(file, format = "") {
  const raw = readText(file);
  const lines = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      lines.push(JSON.parse(s));
    } catch {
      // 坏行跳过：日志可能在写的时候被读到，最后一行通常是半截。
    }
  }
  const out = readMessages(lines);
  out.harness = format || sniff(lines) || "unknown";
  out.turns = dedupe(out.turns);
  return out;
}

/** 同一个问题可能被重试回放两次，内容完全相同的相邻轮去掉。 */
function dedupe(turns) {
  const out = [];
  let prev = "";
  for (const t of turns) {
    const key = `${t.role}:${t.text.slice(0, 120)}`;
    if (key === prev) continue;
    prev = key;
    out.push(t);
  }
  return out;
}
