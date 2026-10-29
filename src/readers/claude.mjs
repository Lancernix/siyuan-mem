/**
 * Claude Code：type=user|assistant，message.content 是块数组。
 *
 * 工具结果放在 `tool_result` 块里，靠块类型天然过滤掉；子代理的每条消息标 isSidechain。
 * 子代理的**结论**在 Task 工具的 tool_result 里，由共用层按 tool_use_id 反查工具名后收回。
 */
import { walkMessages } from "./base.mjs";

export const name = "claude";

export function sniff(sample) {
  if (sample.some((d) => d?.type === "workspace-directories" || d?.type === "runtime-config")) return false;
  return sample.some(
    (d) => (d?.type === "user" || d?.type === "assistant") && Array.isArray(d?.message?.content),
  );
}

export const hooks = {
  isSubagentLine: (d) => Boolean(d?.isSidechain),
};

export function read(lines) {
  return walkMessages(lines, hooks);
}
