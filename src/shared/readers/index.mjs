/**
 * 读取层的入口：按 harness 分发。
 *
 * 分层是这样切的：
 *   base.mjs        共用——解压、找消息节点、role 归一、注入块、子代理回报、对账
 *   <harness>.mjs   各家特有——只声明差异（hooks），不重复写循环
 *   index.mjs       注册表 + 分发
 *
 * 为什么不用一份"万能形状识别"打天下：各家特有的规则（WorkBuddy 的
 * `<function_call>` 前缀、Qoder 的 origin、OMP 的 attribution、DSH 的 plugin:）
 * 混进共用代码之后，改一家的规则会波及另外三家。按 harness 拆开之后，
 * 升级或排障只看一个文件。
 *
 * 但底下的引擎仍然只有一份——所以加一个新 harness 是"加一个十几行的声明"，
 * 不是"再抄一遍解析循环"。
 */
import { readJsonLines, readText, walkMessages, auditWalks } from "./base.mjs";
import * as workbuddy from "./workbuddy.mjs";
import * as claude from "./claude.mjs";
import * as qoder from "./qoder.mjs";
import * as omp from "./omp.mjs";
import * as dsh from "./dsh.mjs";
import * as generic from "./generic.mjs";

export { readText, readJsonLines };

/**
 * 注册表。顺序即嗅探优先级：特征越独特的排越前。
 *
 * 必须 dsh 在前、generic 在最后：
 * - DSH 和 OMP 的首行都是 {type:"session", version:n}，但 DSH 有 `x/message` 这种带斜杠的事件名；
 * - Qoder 和 Claude 都是 user/assistant，Qoder 多 workspace-directories。
 */
export const REGISTRY = [dsh, qoder, workbuddy, omp, claude, generic];

export const HARNESS_NAMES = REGISTRY.map((a) => a.name);

function adapterOf(format, lines) {
  if (format) {
    const hit = REGISTRY.find((a) => a.name === format);
    if (!hit) throw new Error(`没有这个格式：${format}（可用 ${HARNESS_NAMES.join("|")}）`);
    return hit;
  }
  return REGISTRY.find((a) => a.sniff(lines.slice(0, 200))) ?? generic;
}

/** 判断这是哪家的日志。只用来打来源标签，不参与解析。 */
export function sniff(lines) {
  const hit = REGISTRY.find((a) => a.sniff(lines.slice(0, 200)));
  return hit && hit !== generic ? hit.name : "";
}

/**
 * 把事件流变成发言流。
 * @returns {{turns:{role:string,text:string}[], sessionId:string, cwd:string, skipped?:string}}
 */
export function readMessages(lines, format = "") {
  return adapterOf(format, lines).read(lines);
}

/** 逐块对账，口径与 readMessages 完全一致。 */
export function auditMessages(lines, format = "") {
  const a = adapterOf(format, lines);
  return auditWalks(lines, a.hooks ?? {});
}

/**
 * 读一个会话日志。format 留空则按内容嗅探（只影响标签）。
 * @returns {{turns:{role:string,text:string}[], sessionId:string, cwd:string, harness:string}}
 */
export function readLog(file, format = "") {
  const lines = readJsonLines(file);
  const a = adapterOf(format, lines);
  const out = a.read(lines);
  out.harness = format || snackName(a);
  out.turns = dedupe(out.turns);
  return out;
}

/** 泛型兜底时不要冒充某一家：标签写 unknown，写错了最多少一个来源标记。 */
function snackName(a) {
  if (a === generic) return "unknown";
  return a.name;
}

/**
 * 同一个问题可能被重试回放两次，**内容完全相同**的相邻轮去掉。
 *
 * 比的必须是全文。原来比的是「角色 + 前 120 字」，于是两条开头相同、后面不同的
 * 消息会被当成同一条丢掉——这是确定性的内容丢失，而且丢的是用户的第二条提问。
 */
export function dedupe(turns) {
  const out = [];
  let prev = "";
  for (const t of turns) {
    const key = `${t.role}:${t.text}`;
    if (key === prev) continue;
    prev = key;
    out.push(t);
  }
  return out;
}
