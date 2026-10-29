/**
 * DSH：事件名带斜杠（user/message、assistant/message、tool/result），数据在 data 里。
 *
 * 三条特有规则：
 * - `source.kind` 以 `plugin:` 开头的是注入（包括记忆注入本身），不收；
 * - `source.kind = "tool"` 是工具回填，按工具结果归类；
 * - 子代理是独立会话文件，用 `delegationDepth > 0` 标。它的回报落在父会话的
 *   tool/result 里，由共用层认。
 *
 * 另外 DSH 的日志是多帧 zstd，解压由 base.readText 处理。
 */
import { walkMessages } from "./base.mjs";

export const name = "dsh";

export function sniff(sample) {
  return sample.some((d) => d?.type === "user/message" || d?.type === "assistant/message" || d?.type === "turn/start");
}

export const hooks = {
  isSubagentFile: (lines) =>
    lines.some((d) => d?.type === "session" && Number(d.delegationDepth ?? 0) > 0),
  dropKind: (m) => {
    const kind = m?.source?.kind;
    if (typeof kind !== "string") return null;
    if (kind.startsWith("plugin:")) return "injected";
    if (kind === "tool") return "tool";
    return null;
  },
};

export function read(lines) {
  return walkMessages(lines, hooks);
}
