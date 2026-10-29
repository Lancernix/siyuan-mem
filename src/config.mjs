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
/** 每个会话日志读到哪儿了。没有它，同一个会话每次都要整份重发一遍。 */
export const OFFSET_PATH = join(HOME_DIR, "offsets.json");
/** 进程锁与轮次日志。放这里而不是 serve.mjs，免得 ui.mjs 为了拿路径反向依赖 serve。 */
export const LOCK_PATH = join(HOME_DIR, "serve.lock");
export const LOG_PATH = join(HOME_DIR, "serve.log");

const DEFAULTS = {
  siyuan: {
    baseUrl: "http://127.0.0.1:6806",
    token: "",
    notebook: "90-记忆",
    docs: { entries: "01-条目", raw: "02-原文", changes: "03-变更" },
  },
  model: {
    /** 预设名，见 llm.mjs 的 PROVIDERS；换成别家只改这一行 + apiKey。 */
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    name: "deepseek-chat",
    /** 能开就开：接口要求顶层是对象，prompt 已按 {"entries":[…]} 写。 */
    jsonMode: true,
    timeoutMs: 45000,
  },
  serve: {
    /** 常驻模式的轮询间隔。 */
    intervalMinutes: 10,
    /** 会话安静多久才切片投递：正在写的会话每十分钟切一刀，切出来全是半句话。 */
    quietSeconds: 180,
    /** 每轮最多投几个会话，防止第一次跑就把 105 个会话一起塞进模型。 */
    maxSessionsPerRound: 8,
  },
  ui: {
    /** 本地面板。只有 127.0.0.1，没有鉴权，别绑 0.0.0.0。 */
    enabled: true,
    port: 7787,
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

export function loadOffsets() {
  ensureDirs();
  try {
    return JSON.parse(readFileSync(OFFSET_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveOffsets(o) {
  ensureDirs();
  writeFileSync(OFFSET_PATH, JSON.stringify(o, null, 2) + "\n");
}

