import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
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
/** 实体否定的本地记录：`{"甲|乙": "2026-10-30"}`。同一台机器上判过就不再问。 */
export const NEGATIVES_PATH = join(HOME_DIR, "entity-negatives.json");
/**
 * 原文归档的本地索引：`{"机器|harness|会话": [{blockId, path, from, to}]}`。
 *
 * 为什么不只查思源：块的 SQL 索引是异步的，刚 append 完立刻查不到。
 * 归档紧接着要做幂等判断（这段是不是已经传过），查不到就会重复上传。
 * 本地这份是权威，SQL 只在本地丢了时兜底。
 */
export const RAW_INDEX_PATH = join(HOME_DIR, "raw-index.json");

const DEFAULTS = {
  siyuan: {
    baseUrl: "http://127.0.0.1:6806",
    token: "",
    notebook: "90-记忆",
    /**
     * 变更日志（03-变更）。默认关：它是审计流水，一行一次写入，
     * 106 个会话跑完就是上千行「+ [实体] 半句话」，人不会去读。
     * 要排查时手动打开。
     */
    logChanges: false,
    /**
     * 是否把同一会话的条目归到一个 `## 日期 · 项目` 标题下面。
     *
     * 默认关，因为思源的**标题是叶子块**，不能有子块：只能把条目用 previousID
     * 插在标题后面，于是每写一条都要记住"这一组最后一块是谁"。这个记录一旦错位
     * （块被手删、进程重启、多次重跑），就会变成每条前面顶一个标题。
     * 可靠的做法是一个会话一篇子文档，那要改写入路径，还没做。
     */
    groupEntries: false,
    docs: {
      entries: "01-条目",
      raw: "02-原文",
      changes: "03-变更",
      entities: "04-实体",
      pending: "05-实体待确认",
    },
  },
  model: {
    /** 预设名，见 llm.mjs 的 PROVIDERS；换成别家只改这一行 + apiKey。 */
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    name: "deepseek-chat",
    /** 能开就开：接口要求顶层是对象，prompt 已按 {"entries":[…]} 写。 */
    jsonMode: true,
    /**
     * 单次调用超时。给到 120 秒是因为「同权重但降速」的档位（DeepSeek 经济版、
     * 各家 Lite）在大输入上慢很多：16000 字输入 + 6 条结论，实测 20-60 秒。
     * 45 秒会把正常请求判成超时，然后重试、再超时，白烧三倍 token。
     * 快的模型不会因此变慢，它拿到结果就返回。
     */
    timeoutMs: 120000,
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
  ingest: {
    /**
     * 接收端：给别的机器推会话用。
     *
     * 默认关、默认只绑 127.0.0.1。它是写入通道，不是只读面板——没有 token
     * 又绑到 0.0.0.0，等于把记忆库的写权限摆在公网上。`mem ingest setup` 会
     * 生成 token 并一起改掉这两个值。
     */
    enabled: false,
    bind: "127.0.0.1",
    port: 7788,
    token: "",
    /** 单次请求上限。一个会话几百万字也就几 MB，24MB 已经宽松。 */
    maxBytes: 24 * 1024 * 1024,
  },
  push: {
    /** 边缘机器用：把本机日志推给中心。空表示还没配。 */
    to: "",
    token: "",
    /** 机器名。默认取短 hostname；同一台机器换名会导致 offsets 重来一遍。 */
    machine: "",
    /** 常态间隔。会话还在写的时候推过去全是半句话，所以另有 quietSeconds。 */
    intervalSeconds: 120,
    quietSeconds: 180,
    /** 单次请求的最大字符数，超了拆成多次。 */
    maxCharsPerRequest: 800_000,
  },
  extract: {
    minTurnChars: 25,
    /** 一次模型调用最多塞多少字符。超了拆批，不截内容。 */
    maxCharsPerCall: 16000,
    /** 每批最多出几条。批与批之间是独立的，不会互相挤掉。 */
    maxEntriesPerBatch: 5,
    /**
     * 一个会话最多入库几条。
     * 这个数字不是"能写多少"，是"应该写多少"的提示：设成 60 的时候实测
     * 一个会话抽出 54 条技术细节，每条都缺上下文，读起来像清单。
     */
    maxEntriesPerSession: 18,
    /** 抽取时带多少个已有实体进 prompt。多了会挤掉正文，少了复用率下降。 */
    entityShotList: 300,
  },
  raw: {
    /**
     * 原文归档。放思源附件（assets）而不是笔记正文：
     * 附件不进 blocks_fts，不会把 bm25 的 IDF 拉偏；但会被「清理未引用资源」扫到，
     * 所以每个 part 都必须在 02-原文 里有一个引用块。
     */
    enabled: true,
    /** assets 下的目录前缀，后面按 机器/harness 分层。 */
    dir: "mem-raw",
    /**
     * 单个 part 的硬上限，超了按轮次边界切。
     * 批次粒度由投递决定（安静 180 秒、只推增量），所以常态下一个会话一次一个 part；
     * 只有首次回灌超长会话才会碰到这个上限。
     */
    forcePartBytes: 8 * 1024 * 1024,
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

/**
 * 会话 → 标题块 id。写入时靠它判断「这个会话的标题是不是已经插过了」。
 * 不查 SQL：块的索引是异步的，刚插完查不到，会重复插入标题。
 */
export const GROUPS_PATH = join(HOME_DIR, "entry-groups.json");

export function loadGroups() {
  try {
    return JSON.parse(readFileSync(GROUPS_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveGroups(o) {
  ensureDirs();
  writeFileSync(GROUPS_PATH, JSON.stringify(o, null, 2) + "\n");
}

/** 本机标识。三台机器的日志路径长得一模一样，不分开就会互相顶掉。 */
export function machineId() {
  if (process.env.MEM_MACHINE) return String(process.env.MEM_MACHINE);
  try {
    const c = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (c?.push?.machine) return String(c.push.machine);
  } catch {}
  // hostname 常带 .local，截短只是为了让面板和日志好读。
  return hostname().split(".")[0] || "local";
}

/**
 * 偏移按机器分组：`{ version: 2, machines: { mac: { 路径: {...} }, server: {...} } }`。
 *
 * 旧格式是扁平的 `{ 路径: {...} }`，这里就地迁移到本机名下。不迁移的话，
 * 同一台机器升级后所有会话会重推一遍（内容哈希能挡住重复条目，但白烧 token）。
 */
export function loadOffsets() {
  ensureDirs();
  let raw;
  try {
    raw = JSON.parse(readFileSync(OFFSET_PATH, "utf8"));
  } catch {
    return { version: 2, machines: {} };
  }
  if (raw && raw.machines && typeof raw.machines === "object") return raw;
  return { version: 2, machines: { [machineId()]: raw ?? {} } };
}

export function saveOffsets(o) {
  ensureDirs();
  writeFileSync(OFFSET_PATH, JSON.stringify(o, null, 2) + "\n");
}

/** 取某台机器的偏移表（会就地补上缺失的层级，方便直接改再整体保存）。 */
export function offsetsOf(all, machine = machineId()) {
  all.machines ??= {};
  all.machines[machine] ??= {};
  return all.machines[machine];
}

/** 写配置里的某一段。只做深合并，不整份覆盖——把别人的 key 弄丢过一次就够了。 */
export function saveConfig(patch) {
  ensureDirs();
  let cur = {};
  try {
    cur = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
  const merged = deepMerge(deepMerge(structuredClone(DEFAULTS), cur), patch);
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  return merged;
}

