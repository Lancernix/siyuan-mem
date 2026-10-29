/**
 * 会话日志读取器。
 *
 * 插件采集只在装了插件的 harness 里有效。读日志这条路覆盖剩下的情况，
 * 也是插件坏掉时的兜底——日志是 append-only 的，harness 自己不会写丢。
 *
 * 三家格式不一样，但都是"一行一个事件"，所以适配器很薄。
 */
import { readFileSync } from "node:fs";

const REMINDER = /<system-reminder[\s\S]*?<\/system-reminder>/g;
/**
 * 上下文压缩的摘要块会以 user 角色回放，一条能到 48 万字。
 * 它是"之前聊过什么的纪要"，不是用户说的话；当成提问抽，抽出来的是摘要的摘要。
 */
const SUMMARY_BLOCK = /^\s*<cb_summary>/;
const MAX_TURN_CHARS = 2000;
const CONTEXT_TAGS = /<(?:user_info|craft_mode|additional-data|current_time|wecom_wedrive_references)[\s\S]*?<\/(?:user_info|craft_mode|additional-data|current_time|wecom_wedrive_references)>/g;

function cleanUserText(text) {
  const raw = String(text ?? "");
  if (SUMMARY_BLOCK.test(raw)) return "";
  const clean = raw
    .replace(REMINDER, "")
    .replace(CONTEXT_TAGS, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clip(clean);
}

/** 粘贴进来的日志、文件、报错会到几十万字，整条发给模型是纯烧钱。留头部够判断了。 */
function clip(text) {
  return text.length <= MAX_TURN_CHARS ? text : text.slice(0, MAX_TURN_CHARS) + "…";
}

/** WorkBuddy：type=message，content 是 [{type:"input_text"|"text", text}]。 */
function readWorkbuddy(lines) {
  const turns = [];
  let sessionId = "";
  let cwd = "";
  for (const d of lines) {
    if (d?.sessionId) sessionId ||= d.sessionId;
    if (d?.cwd) cwd ||= d.cwd;
    if (d?.type !== "message") continue;
    const role = d.role === "assistant" ? "assistant" : d.role === "user" ? "user" : null;
    if (!role) continue;
    const parts = Array.isArray(d.content) ? d.content : [];
    const text = parts
      .filter((p) => p && typeof p.text === "string" && /text$/.test(p.type ?? "text"))
      .map((p) => p.text)
      .join("\n");
    const clean = role === "user" ? cleanUserText(text) : clip(String(text ?? "").trim());
    if (!clean) continue;
    // 工具结果和文件快照会以 user 角色出现，拦掉。
    if (role === "user" && /^<(?:function_call|file-history)/.test(clean)) continue;
    turns.push({ role, text: clean });
  }
  return { turns, sessionId, cwd, harness: "workbuddy" };
}

/** Claude Code：type=user|assistant，message.content 是块数组。 */
function readClaude(lines) {
  const turns = [];
  let sessionId = "";
  let cwd = "";
  for (const d of lines) {
    if (d?.sessionId) sessionId ||= d.sessionId;
    if (d?.cwd) cwd ||= d.cwd;
    if (d?.type !== "user" && d?.type !== "assistant") continue;
    if (d?.isSidechain) continue; // 子代理，不进记忆
    const m = d.message ?? {};
    const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
    const text = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
    const clean = d.type === "user" ? cleanUserText(text) : clip(String(text ?? "").trim());
    if (!clean) continue;
    turns.push({ role: d.type, text: clean });
  }
  return { turns, sessionId, cwd, harness: "claude-code" };
}

/** DSH：session.v4.jsonl，事件形如 {type:"user/message"|"assistant/message", data}。 */
function readDsh(lines) {
  const turns = [];
  let sessionId = "";
  let cwd = "";
  for (const d of lines) {
    sessionId ||= d?.sessionId ?? d?.header?.id ?? "";
    cwd ||= d?.cwd ?? d?.header?.cwd ?? "";
    let message = null;
    if (d?.type === "user/message") message = d.data;
    else if (d?.type === "assistant/message") message = d.data?.message;
    if (!message) continue;
    const kind = message?.source?.kind;
    if (typeof kind === "string" && kind.startsWith("plugin:")) continue;
    if (kind === "tool") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
    const clean = role === "user" ? cleanUserText(text) : clip(String(text ?? "").trim());
    if (!clean) continue;
    turns.push({ role, text: clean });
  }
  return { turns, sessionId, cwd, harness: "dsh" };
}

const READERS = { workbuddy: readWorkbuddy, claude: readClaude, dsh: readDsh };

function sniff(lines) {
  for (const d of lines.slice(0, 60)) {
    if (d?.type === "message" && d?.sessionId) return "workbuddy";
    if (d?.type === "user" || d?.type === "assistant") return "claude";
    if (d?.type === "user/message" || d?.type === "assistant/message") return "dsh";
  }
  return null;
}

/**
 * 读一个会话日志。format 留空则按内容嗅探。
 * @returns {{turns:{role:string,text:string}[], sessionId:string, cwd:string, harness:string}}
 */
export function readLog(file, format = "") {
  const raw = readFileSync(file, "utf8");
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
  const kind = format || sniff(lines);
  const reader = READERS[kind];
  if (!reader) throw new Error(`认不出这个日志的格式（${file}），用 --format 指定 workbuddy|claude|dsh`);
  const out = reader(lines);
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
