/**
 * 告警条：只留「需要人看一眼」的事，不做消息中心。
 *
 * 面板顶上的黄条就是它。写盘而不是只放内存：serve 重启后，昨天那批进了死信的
 * 会话不该因为重启就没人知道。按 kind 去重，同一种问题只留最近一条，
 * 否则连续十轮失败会堆出十条一样的。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME_DIR } from "../util/config.mjs";

const PATH = join(HOME_DIR, "alerts.json");

export function alerts() {
  try {
    const list = JSON.parse(readFileSync(PATH, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function raise(kind, text) {
  const list = alerts().filter((a) => a.kind !== kind);
  list.unshift({ kind, text, at: new Date().toISOString() });
  try {
    mkdirSync(dirname(PATH), { recursive: true });
    writeFileSync(PATH, JSON.stringify(list.slice(0, 10), null, 2) + "\n", { mode: 0o600 });
  } catch {
    // 写不进去不影响主流程：告警是提示，不是账本。
  }
  return list;
}

export function clear(kind) {
  const list = kind ? alerts().filter((a) => a.kind !== kind) : [];
  try {
    writeFileSync(PATH, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
  } catch {}
  return list;
}

/** 当前有没有待处理的问题，给面板一个布尔，省得前端自己算。 */
export function hasAlerts() {
  return alerts().length > 0;
}

export { PATH as ALERT_PATH };
