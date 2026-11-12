/**
 * 召回调用来源：唯一真源。
 *
 * `memory.hit/miss`、`memory.browse` 都按 source 分桶，用来回答「这套东西到底
 * 有没有被用起来」。原来每个调用方各写各的字符串，中心接口还允许外部传任意
 * 20 字符——一个拼错的来源就多一个桶，`mem status` 里那行会被切碎。
 *
 * 更麻烦的是**同一串调用记成两种来源**（第十八轮复审 P2-2）：边缘 MCP 的
 * `memory_search` 走中心时被硬写成 `api`，而新加的 topics/entries 透传了
 * `mcp`。于是「mcp 那一栏是不是 0」这个判据在边缘路径上结构性失真——
 * 而这轮所有投入的正当性正挂在这个数上。
 *
 * 白名单只有四个真实入口；其余一律归 `unknown`，不新造桶。
 * 边缘和中心两端都调它：滚动更新时可能一边新一边旧，两边都得认同一套。
 */
export const RECALL_SOURCES = Object.freeze(["mcp", "cli", "ui", "api"]);

/**
 * @param {unknown} raw 调用方给的来源
 * @param {string} fallback 没给时的默认值。中心接口用 "api"（确实是 HTTP 调用），
 *                          本地直连用 "unknown"。
 */
export function normalizeSource(raw, fallback = "unknown") {
  const s = String(raw ?? "").trim().toLowerCase();
  if (RECALL_SOURCES.includes(s)) return s;
  // 拼错、伪造、过长的来源一律并到 fallback，不新造桶。
  const f = String(fallback).trim().toLowerCase();
  return RECALL_SOURCES.includes(f) ? f : "unknown";
}
