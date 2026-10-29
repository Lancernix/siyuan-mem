/**
 * WorkBuddy：扁平结构，role/content 直接挂在事件上，每条 message 带 sessionId。
 *
 * 特有的坑：工具结果和文件快照以 **user 角色**写进正文，文本以 `<function_call` /
 * `<file-history` 开头。不认这个前缀，一条工具输出就会被当成用户的问题抽成记忆。
 */
import { walkMessages } from "./base.mjs";

export const name = "workbuddy";

export function sniff(sample) {
  return sample.some((d) => d?.type === "message" && typeof d?.sessionId === "string" && d.sessionId);
}

const TOOL_TEXT = /^<(?:function_call|file-history)/;

export const hooks = {
  dropKind: (_m, _raw, clean) => (TOOL_TEXT.test(clean) ? "tool" : null),
};

export function read(lines) {
  return walkMessages(lines, hooks);
}
