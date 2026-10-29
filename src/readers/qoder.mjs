/**
 * Qoder：日志格式照抄 Claude Code（user/assistant + message.content 块数组）。
 *
 * 多出来的是自己的事件类型：workspace-directories、runtime-config、active-leaf、
 * last-prompt、attachment。另外它给消息标 `origin.kind`，非 human 的是注入。
 *
 * 和 claude.mjs 长得几乎一样，但不合并：哪天 Qoder 换格式，改这个文件就行，
 * 不会波及 Claude Code 那一份。
 */
import { walkMessages } from "./base.mjs";

export const name = "qoder";

export function sniff(sample) {
  return sample.some((d) => d?.type === "workspace-directories" || d?.type === "runtime-config");
}

export const hooks = {
  isSubagentLine: (d) => Boolean(d?.isSidechain),
  dropKind: (_m, _raw, _clean, d) => (d?.origin?.kind && d.origin.kind !== "human" ? "injected" : null),
};

export function read(lines) {
  return walkMessages(lines, hooks);
}
