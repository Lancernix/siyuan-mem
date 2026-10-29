import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 配置放在家目录，不跟项目走：里面有 API key，不能进版本库。 */
export const HOME_DIR = join(homedir(), ".siyuan-mem");
export const CONFIG_PATH = join(HOME_DIR, "config.json");
export const INBOX_DIR = join(HOME_DIR, "inbox");
export const DONE_DIR = join(HOME_DIR, "done");
/** 解析出来的块 id 缓存在这里：思源的文档索引是异步的，刚建完查不到，不缓存就会重复建。 */
export const STATE_PATH = join(HOME_DIR, "state.json");

const DEFAULTS = {
  siyuan: {
    baseUrl: "http://127.0.0.1:6806",
    token: "",
    notebook: "90-记忆",
    docs: { entries: "01-条目", raw: "02-原文", changes: "03-变更" },
  },
  model: {
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    name: "deepseek-chat",
    timeoutMs: 45000,
  },
  extract: {
    minTurnChars: 25,
    /** 一次模型调用最多塞多少字符。超了拆批，不截内容。 */
    maxCharsPerCall: 16000,
    /** 每批最多出几条。批与批之间是独立的，不会互相挤掉。 */
    maxEntriesPerBatch: 6,
    /** 一个会话最多入库几条，纯防噪音；撞到了会打印出来。 */
    maxEntriesPerSession: 60,
  },
};

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(base[k] ?? {}, v) : v;
  }
  return out;
}

export function ensureDirs() {
  for (const d of [HOME_DIR, INBOX_DIR, DONE_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

export function loadConfig() {
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + "\n");
    return structuredClone(DEFAULTS);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    throw new Error(`配置读不出来（${CONFIG_PATH}）：${e.message}`);
  }
  return deepMerge(DEFAULTS, raw);
}

export function loadState() {
  ensureDirs();
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveState(state) {
  ensureDirs();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

export function hasModel(cfg) {
  return Boolean(cfg.model?.apiKey);
}
