/**
 * 模型目录：抄 OpenCode 的做法，用 models.dev 当"外部注册表"，别再手抄 baseUrl 和模型名。
 *
 * 只拿它当**数据**，不拿它的 SDK：pi-ai 那种"每个协议装一个 SDK"的做法在它自己那儿
 * 合理（它要支持 Bedrock、Mistral、OAuth），但我们只有一种调用形状，装 104 个包、
 * 132MB node_modules 换一张表，不值。
 *
 * 目录里没有 wire 协议，但每个 provider 有 `npm`（OpenCode 用它选 SDK），可以反推：
 *   @ai-sdk/anthropic*  → anthropic
 *   @ai-sdk/google*     → gemini
 *   其余                → openai 兼容
 * 这条映射是这份目录唯一"推断"出来的东西，其余全是抄来的事实。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./config.mjs";

export const CATALOG_URL = "https://models.dev/api.json";
export const CATALOG_PATH = join(HOME_DIR, "models.json");
const MAX_AGE_MS = 7 * 24 * 3600_000;

let _memo = null;
let _memoAt = 0;

/**
 * 只读缓存，不发网络请求。给 resolveModel 这种同步路径用。
 * 60 秒内存缓存：抽取一个会话要按批调用十几次，每次都读 2MB 的目录太蠢。
 */
export function loadCatalogSync() {
  if (_memo && Date.now() - _memoAt < 60_000) return _memo;
  try {
    const j = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    _memo = { providers: j.providers ?? j, fetchedAt: j.fetchedAt ?? 0, source: "cache" };
  } catch {
    _memo = { providers: null, fetchedAt: 0, source: "missing" };
  }
  _memoAt = Date.now();
  return _memo;
}

/** 目录更新后要作废内存缓存。 */
export function resetCatalogMemo() {
  _memo = null;
  _memoAt = 0;
}

/** 缓存过期或显式 refresh 时去拿一份新的；拿不到就退回旧缓存，不阻塞。 */
export async function loadCatalog({ refresh = false, timeoutMs = 8000 } = {}) {
  const cached = loadCatalogSync();
  const fresh = cached.providers && Date.now() - cached.fetchedAt < MAX_AGE_MS;
  if (cached.providers && fresh && !refresh) return cached;

  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const providers = await res.json();
    if (!providers || typeof providers !== "object") throw new Error("不是对象");
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(CATALOG_PATH, JSON.stringify({ fetchedAt: Date.now(), providers }));
    return { providers, fetchedAt: Date.now(), source: "network" };
  } catch (e) {
    return { ...cached, source: cached.providers ? "stale" : "missing", error: e.message };
  }
}

/** 从 npm 包名反推协议——这份目录里没有 wire 字段，这是唯一的推断。 */
export function wireOf(provider) {
  const npm = String(provider?.npm ?? "");
  if (/anthropic/i.test(npm)) return "anthropic";
  if (/google/i.test(npm)) return "gemini";
  return "openai";
}

/** 找 provider：先精确 id，再按名字模糊。 */
export function findProvider(providers, id) {
  if (!providers || !id) return null;
  const key = String(id).toLowerCase();
  if (providers[key]) return { id: key, ...providers[key] };
  const hit = Object.entries(providers).find(([k, v]) => k.toLowerCase() === key || String(v?.name ?? "").toLowerCase() === key);
  return hit ? { id: hit[0], ...hit[1] } : null;
}

/** 这个 provider 有没有从环境里现成的 key（名字都写在 env 数组里）。 */
export function envKeyOf(provider) {
  for (const name of provider?.env ?? []) {
    const v = process.env[name];
    if (v) return { name, value: v };
  }
  return null;
}

/** 模型条目：价格、上下文长度都在里面。 */
export function modelInfo(provider, modelId) {
  return provider?.models?.[modelId] ?? null;
}

/** 定价单位是美元 / 百万 token。只用于展示与估算，不参与计费。 */
export function priceOf(provider, modelId) {
  const m = modelInfo(provider, modelId);
  if (!m?.cost) return null;
  const { input = 0, output = 0, cache_read: cacheRead = 0, cache_write: cacheWrite = 0 } = m.cost;
  return { input, output, cacheRead, cacheWrite };
}
