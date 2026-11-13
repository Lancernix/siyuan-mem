/**
 * 召回调用来源：唯一真源。
 *
 * `memory.hit/miss`、`memory.browse` 都按 source 分桶，用来回答「这套东西到底有没有
 * 被用起来」。来源字符串如果各写各的，一个拼错就多一个桶，`mem status` 那行会被切碎。
 *
 * 更麻烦的是同一串调用记成两种来源：边缘 MCP 的 search 被硬写成 `api`，而 topics /
 * entries 透传 `mcp`——「mcp 那一栏是不是 0」这个判据就废了。
 *
 * 白名单四个真实入口，其余归 `unknown`。边缘和中心两端都调它：滚动更新时可能一边
 * 新一边旧，两边得认同一套。
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
