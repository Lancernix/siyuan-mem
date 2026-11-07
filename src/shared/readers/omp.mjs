/**
 * OMP：type=message，消息包在 `message` 里，role 词表最杂
 * （user / assistant / toolResult / developer / fileMention）。
 *
 * 只认 user（且 attribution=user）和 assistant；developer 是 agent 自己说的话，
 * fileMention 是附件引用，都不是对话。
 *
 * 子代理不在这里判：它的转录放在会话目录的**下一层**（<会话>/T4impl.jsonl），
 * 由 harness.mjs 的 depth 字段挡掉。`parentSession` 是 handoff 续接，那是真会话。
 */
import { walkMessages } from "./base.mjs";

export const name = "omp";

export function sniff(sample) {
  return sample.some((d) => d?.type === "message" && d?.message && typeof d.message === "object");
}

export const hooks = {
  sessionIdOf: (d) => (d?.type === "session" ? d.id ?? "" : ""),
  cwdOf: (d) => (d?.type === "session" ? d.cwd ?? "" : ""),
  dropKind: (m) => (m?.attribution && m.attribution !== "user" ? "injected" : null),
};

export function read(lines) {
  return walkMessages(lines, hooks);
}
