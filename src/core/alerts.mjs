/**
 * 告警条：只留「需要人看一眼」的事，不做消息中心。
 *
 * 面板顶上的黄条就是它。写盘而不是只放内存：serve 重启后，昨天那批进了死信的
 * 会话不该因为重启就没人知道。按 kind 去重，同一种问题只留最近一条，
 * 否则连续十轮失败会堆出十条一样的。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME_DIR, loadConfig } from "../util/config.mjs";

const PATH = join(HOME_DIR, "alerts.json");

export function alerts() {
  try {
    const list = JSON.parse(readFileSync(PATH, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * 群机器人消息体各家不一样，按域名挑一个。认不出的按通用 {text} 发。
 * 这是尽力而为：发失败不能影响主流程，面板里那条还在，不会真丢。
 */
function webhookBody(url, text) {
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (/qyapi\.weixin\.qq\.com$/.test(host)) return { msgtype: "text", text: { content: text } };
  if (/oapi\.dingtalk\.com$/.test(host)) return { msgtype: "text", text: { content: text } };
  if (/open\.feishu\.cn$/.test(host)) return { msg_type: "text", content: { text } };
  return { text };
}

function deliver(url, text) {
  if (!url) return;
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(webhookBody(url, text)),
    signal: AbortSignal.timeout(6000),
  }).catch(() => {});
}

export function raise(kind, text) {
  const old = alerts().find((a) => a.kind === kind);
  // 同一件事反复出现、文字都没变，不重复发——否则每轮一条，群里很快没人看了。
  if (old?.text === text) return alerts();
  const list = alerts().filter((a) => a.kind !== kind);
  list.unshift({ kind, text, at: new Date().toISOString() });
  try {
    mkdirSync(dirname(PATH), { recursive: true });
    writeFileSync(PATH, JSON.stringify(list.slice(0, 10), null, 2) + "\n", { mode: 0o600 });
  } catch {
    // 写不进去不影响主流程：告警是提示，不是账本。
  }
  // Webhook 是凭据：配置优先，环境变量兜底（容器里注入更方便）。
  const url = process.env.MEM_ALERT_WEBHOOK || loadConfig().ui?.alertWebhook || "";
  deliver(url, `[siyuan-mem] ${text}`);
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
