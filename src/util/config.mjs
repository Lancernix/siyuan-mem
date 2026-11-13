import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

/** 配置放在家目录，不跟项目走：里面有 API key，不能进版本库。 */
export const HOME_DIR = join(homedir(), ".siyuan-mem");
export const CONFIG_PATH = join(HOME_DIR, "config.json");
export const INBOX_DIR = join(HOME_DIR, "inbox");
export const DONE_DIR = join(HOME_DIR, "done");
/**
 * 死信：重试到上限还是过不去的会话挪到这里，不再参与每轮扫描。
 *
 * 必须有个出口。队列是 FIFO，一个每次都超预算/读不动的会话压在最前面，
 * 后面的永远轮不到——看上去队列有活、其实一条也走不动。
 */
export const DEAD_DIR = join(HOME_DIR, "dead");
/** 每个会话失败了几次。放文件里而不是内存：容器每轮重启都会清零，就永远到不了上限。 */
export const ATTEMPTS_PATH = join(HOME_DIR, "attempts.json");
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
/**
 * 实体表。存本地不存思源：它是**索引**不是内容——程序用它做归一和判重，人不读它。
 * 而且 02-实体 那个文档已经是「视图」（话题 + 块引用），一个文档不能同时当
 * 数据表和数据展示。想改走 mem entity add/merge。
 */
export const ENTITIES_PATH = join(HOME_DIR, "entities.json");

const DEFAULTS = {
  siyuan: {
    baseUrl: "http://127.0.0.1:6806",
    token: "",
    notebook: "Mem",
    // 笔记本的真身。第一次 init 会自动写进来；配了它之后改名不用改配置。
    notebookId: "",
    /** 变更日志。默认关：它是审计流水，跑一轮就是上千行，没人读。 */
    logChanges: false,
    /**
     * 同一会话的条目归到一个 `## 日期 · 项目` 下面。用列表项当分组标记而不是标题：
     * 标题是叶子块，不能有子块，列表项可以。
     */
    groupEntries: true,
    /**
     * 条目按什么切文档：'month' 按月，'none' 全塞进 01-条目 一个文档。
     * 一个月一百多条、几万字，正好是思源舒服的体量；无限长下去大纲和全文搜索都会变慢。
     */
    partition: "month",
    /**
     * 只留两个给人看的文档。原文不单独建文档：附件链接挂在块正文里就算「被引用」，
     * 挂到会话分组项上就够保活。
     */
    docs: {
      entries: "01-条目",
      entities: "02-实体",
      pending: "03-实体待确认",
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
     * 单次调用超时。批次放到 38000 字之后，输入涨了 2.4 倍，经济版模型的
     * 输出时间也跟着涨，180 秒才够。给得太紧会把正常请求判成超时，然后重试、
     * 再超时，白烧三倍 token。快的模型不会因此变慢，它拿到结果就返回。
     */
    timeoutMs: 180000,
  },
  serve: {
    /** 常驻模式的轮询间隔。 */
    intervalMinutes: 10,
    /** 会话安静多久才切片投递：正在写的会话每十分钟切一刀，切出来全是半句话。 */
    quietSeconds: 180,
    // 一轮最多处理多少个会话。太小让全量迁移爬得慢，太大就回到「一轮跑几小时」。
    // 一轮最多处理多少个会话：扫描投递和队列抽取共用这一个数。
    // 太小会让一次全量迁移爬得很慢，太大就回到"一轮跑几小时、心跳不动"。
    maxSessionsPerRound: 20,
    // 另一道保险：单轮的时间预算。20 个会话里混进几个超长的，也会在 20 分钟收手。
    maxMinutesPerRound: 20,
    /**
     * 单会话的闸门。轮预算只在会话之间检查，一场会话自己跑得久，一轮就能拖到天亮。
     * 到点收手，剩下的留队列下轮继续。
     */
    maxMinutesPerSession: 10,
    /** 连续几次写库失败就熔断本轮：思源卡住时 5 秒超时 × 几十条，越跑越死。 */
    maxConsecutiveFailures: 3,
    /** 同一个会话失败几次进死信。只对「自身有问题」的失败计数，不包含写库故障。 */
    maxAttemptsPerSession: 3,
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
    // 边缘推送的节奏：活跃时 15 分钟一轮，连续空转就退到 30 / 60。
    //
    // 为什么不是更短：人和模型来回一轮对话本来就要一两分钟，这几分钟里攒下的
    // 内容不值得为它多起一个进程。而端到端延迟的大头也不在这里——中心是
    // 10 分钟一轮抽取，就算 1 分钟推上去也得排队等那一轮。
    //
    // 为什么要有退避：harness 的产出是脉冲式的。忙起来几十轮，闲起来两三天
    // 没动静。固定间隔在闲的时候纯空转（每轮起一个 node，常驻 50MB），
    // 在忙的时候又显不出快——两头都不占。
    intervalSeconds: 900,
    maxIntervalSeconds: 3600,
    quietSeconds: 180,
    /** 单次请求的最大字符数，超了拆成多次。 */
    maxCharsPerRequest: 800_000,
  },
  extract: {
    minTurnChars: 25,
    /** 一次模型调用最多塞多少字符。超了拆批，不截内容。 */
    maxCharsPerCall: 38000,
    /**
     * 每批最多出几条。按 38000 字的批次、约每万字 4 条算，一批大约 15 条；给 18 留点余量，
     * 再多模型就会把条目摊成关键词清单。
     */
    maxEntriesPerBatch: 18,
    /**
     * 一个会话最多入库几条。默认不设，按批数自适应（批数 ×4，夹在 8-36 之间）：
     * 写死数字时，长会话后半段抽出来的东西全被这一行丢掉，而且丢的是最新的结论。
     * 想压噪音就显式写一个数，它会盖掉自适应。
     */
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
  // 0700：这几个目录里放的是会话原文、索引和配置，同机其他用户没必要读。
  // mode 只在创建时生效，已存在的目录也要显式收紧。
  for (const d of [HOME_DIR, INBOX_DIR, DONE_DIR, DEAD_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    // 已经存在的目录也要收紧：mode 只在创建时生效，老机器的 0755 目录不会自己变。
    // 队列里是会话原文，别人同机一个 ls 就看完了。
    try {
      if (statSync(d).mode & 0o077) chmodSync(d, 0o700);
    } catch {
      /* 改不动就算了，不该为了权限把主流程挂掉 */
    }
  }
}

export function loadConfig() {
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) {
    // 里面有 API key，创建时就 0600：mode 只在创建时生效，已经写成 0644 的再传也不改。
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + "\n", { mode: 0o600 });
    return structuredClone(DEFAULTS);
  }
  tightenPerms(CONFIG_PATH);
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
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  tightenPerms(STATE_PATH);
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
  writeFileSync(GROUPS_PATH, JSON.stringify(o, null, 2) + "\n", { mode: 0o600 });
  tightenPerms(GROUPS_PATH);
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
  writeFileSync(OFFSET_PATH, JSON.stringify(o, null, 2) + "\n", { mode: 0o600 });
  tightenPerms(OFFSET_PATH);
}

/** 取某台机器的偏移表（会就地补上缺失的层级，方便直接改再整体保存）。 */
export function offsetsOf(all, machine = machineId()) {
  all.machines ??= {};
  all.machines[machine] ??= {};
  return all.machines[machine];
}

/** 写配置里的某一段。只做深合并，不整份覆盖——把别人的 key 弄丢过一次就够了。 */
/** 权限收紧到 0600。老文件是 0644 的，靠这一步补。失败不影响读配置。 */
function tightenPerms(path) {
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) chmodSync(path, 0o600);
  } catch {
    /* 改不动就算了 */
  }
}

export function saveConfig(patch) {
  ensureDirs();
  let cur = {};
  try {
    cur = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
  const merged = deepMerge(deepMerge(structuredClone(DEFAULTS), cur), patch);
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  tightenPerms(CONFIG_PATH);
  return merged;
}


/**
 * 该从第几轮开始切，以及这个文件是不是被重写过。
 *
 * 判据是「mtime 变了 且 轮数没涨」：只看体积和轮数的话，「内容改长但轮数没变」会被
 * 当成 append，切出来是空的，新偏移却写回去了，新内容永久丢失且不报错。
 * 整份重读，重复的部分由中心按内容哈希挡掉。
 */
export function slicePlan(prev, { size = 0, mtime = 0 } = {}, turnsLen = 0) {
  const seen = prev?.turns ?? 0;
  if (!prev) return { from: 0, rewritten: false };
  if (prev.mtimeMs != null && prev.mtimeMs !== mtime && turnsLen <= seen) {
    return { from: 0, rewritten: true };
  }
  if (size >= (prev.bytes ?? 0) && turnsLen >= seen) return { from: seen, rewritten: false };
  return { from: 0, rewritten: false };
}
