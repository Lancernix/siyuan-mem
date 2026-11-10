/**
 * 两件可以被反复调用的事：把日志投进队列、把队列写进思源。
 *
 * 单独抽出来是为了让 `cli` 和 `serve` 走同一段代码。两份实现迟早会漂，
 * 而"手动跑成功、后台跑丢字"是最难查的一类问题。
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { loadConfig, loadOffsets, saveOffsets, offsetsOf, machineId, slicePlan } from "../util/config.mjs";
import { hasModel } from "../util/llm.mjs";
import { SiYuan } from "../util/siyuan.mjs";
import { Store } from "./store.mjs";
import { normalizeTurns, toExchanges, extractEntries, promptVersion } from "./extract.mjs";
import { pending, readSession, archive, drop, rewrite, bumpAttempt, clearAttempt, deadLetter } from "./inbox.mjs";
import { readLog } from "../util/readers/index.mjs";
import { event } from "../util/log.mjs";
import { archive as archiveRaw, narrowAnchor } from "../util/raw.mjs";
import { loadEntities, shotList, resolveEntities, convergeTopics, mergeEntities } from "./entities.mjs";
import { judgeDuplicates, dedupeStats } from "./dedupe.mjs";
import { dropPending, flushPending, notePending } from "./repair.mjs";

/** 建连接。注入路径要能快速放弃，写路径慢一点没关系，但别无限等。 */
export function open() {
  const cfg = loadConfig();
  const sy = new SiYuan({
    baseUrl: cfg.siyuan.baseUrl,
    token: cfg.siyuan.token,
    timeoutMs: 5000,
  });
  return { cfg, sy, store: new Store(sy, cfg) };
}

/**
 * 读一份会话日志，只把上次之后新增的轮次投进队列。
 *
 * 会话日志是 append-only 的，所以"读到第几轮"就是进度；文件变短说明被重写
 * 或轮转过，那就从头再来。返回 added 为 0 表示没有新内容，不算失败。
 */
/**
 * 这个日志是不是还在被写。
 *
 * 正在进行的会话切出来全是半句话——「等等」「你先别」这类没说完的轮次，
 * 抽出来的结论也是半截。serve 靠 quietSeconds 过滤，手动 ingest-log 也要。
 * （实测踩过：投了当前正在进行的那个 1183 轮会话，178 万字跑 112 批、
 *   二十分钟，抽出来全是「用户要求先探清楚能力」这类过程叙述。）
 */
export function isActive(file, quietSeconds = 180) {
  try {
    const st = statSync(file);
    return Date.now() - st.mtimeMs < quietSeconds * 1000;
  } catch {
    return false;
  }
}

/**
 * 分组标题里的「项目」取哪一段。
 *
 * 直接拿 cwd 最后一段会成片地写出 `default-workspace`、`2026-10-27-23-26-02`、
 * `c276c7b5` 这种标题——那是 harness 自己造的目录名，人看不出这是哪个项目。
 * 所以从后往前走，跳过这些没意义的段；全都没意义就退回 harness 名。
 */
const NOISE_SEGMENT = [
  /^default-workspace$/i,
  /^workspace$/i,
  /^(im|src|app|project|code|tmp|main|www|home|users|desktop|downloads|documents)$/i,
  // 日期当目录名：2026-10-27、2026-10-27-23-26-02
  /^\d{4}-\d{2}-\d{2}(-\d{2}(-\d{2}(-\d{2})?)?)?$/,
  // uuid 片段、提交哈希、随机八位
  /^[0-9a-f]{8}-[0-9a-f]{4}/i,
  /^[0-9a-f]{6,}$/i,
];

export function projectOf(cwd, harness = "") {
  const home = basename(homedir());
  const parts = String(cwd ?? "").split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i].trim();
    if (!seg) continue;
    if (NOISE_SEGMENT.some((re) => re.test(seg))) continue;
    // 一两个字符的段（用户名、盘符）也不是项目名；点开头的是配置目录（~/.dsh）。
    if (seg.length < 3 || seg.startsWith(".")) continue;
    // 家目录名本身也不是项目（~/Downloads → 退到 harness）。
    if (seg === home) continue;
    return seg;
  }
  return String(harness ?? "") || "未命名";
}

export function enqueueLog(file, { format = "", quietSeconds = 180 } = {}) {
  if (quietSeconds > 0 && isActive(file, quietSeconds)) {
    return { added: 0, reason: "active", quietSeconds };
  }
  const log = readLog(file, format);
  if (!log.turns.length) {
    return {
      harness: log.harness,
      added: 0,
      reason: log.skipped === "subagent" ? "subagent" : "empty",
    };
  }

  const all = loadOffsets();
  const offsets = offsetsOf(all, machineId());
  const st = statSync(file);
  const prev = offsets[file];
  // 和 push 用同一套判断：重写（mtime 变了、轮数没涨）就整份重读。
  // 这里原来只看体积和轮数，同尺寸改写会每轮空转却不投递。
  const plan = slicePlan(prev, { size: st.size, mtime: st.mtimeMs }, log.turns.length);
  const turns = log.turns.slice(plan.from);
  const before = log.turns.length - turns.length;
  if (!turns.length) return { harness: log.harness, added: 0, before, upToDate: true };

  const target = drop({
    session_id: log.sessionId || `log-${Date.now()}`,
    harness: log.harness,
    machine: machineId(),
    cwd: log.cwd,
    date: new Date().toISOString().slice(0, 10),
    // 这批 turns 在完整会话里从第几轮开始。归档要用它算全局轮次号，
    // 没有它的话，增量推送会让轮次从 1 重新数，指针全错位。
    turnFrom: before + 1,
    turns,
  });
  // 先投递再记偏移不成立：投递失败会重读同一段。反过来先记偏移再投递，
  // 万一进程在这一行之后被杀，那一段就永远丢了。所以顺序是投递成功才记偏移。
  // 存 mtime：只比体积会漏掉"同尺寸重写"，而 serve/push 那边就是靠它判断
  // "文件到底变过没有"。少存这个字段，每轮都会把全部会话重读一遍。
  offsets[file] = { bytes: st.size, mtimeMs: st.mtimeMs, turns: log.turns.length, at: Date.now() };
  saveOffsets(all);

  return { harness: log.harness, added: turns.length, before, target: target.file ?? target };
}

/**
 * 把队列里的会话逐条写进思源。
 *
 * 只有"完整跑完"才归档：模型挂了退回规则抽取时，原文留在队列里等模型恢复
 * 重跑（writeEntry 自带哈希去重，重跑不会写两遍）。归档意味着原文出队，
 * 之后再也拿不回，所以不能急。
 */
/**
 * 没有 key 的时候 extract 会静默退回规则抽取，而规则抽取只取首句/首段，
 * 写进正式库的全是半句话（实测："[interrupted] 让我为您重新推荐一些…"）。
 * 所以默认行为是拒绝，而不是降级；--no-model 才是显式选择规则抽取。
 */
export function assertModel(cfg, { useModel = true, dry = false } = {}) {
  if (dry || !useModel || hasModel(cfg)) return;
  throw new Error(
    "没有配置模型（config.model.apiKey），规则抽取写进库里全是半句话。\n" +
      "  要么填 key，要么显式加 --no-model 表示你就是要规则抽取，或者先用 --dry 看一眼。"
  );
}

/** 条目落在哪个 part 上。跨 part 的批次只可能出现在首次回灌的超长会话里。 */
function ptrFor(parts, from, to) {
  // skip 的 part 也要算进来：那是「这段原文之前已经传过」的快路径，它带着
  // path 和轮次范围，照样能定位。之前把 skip 过滤掉了，导致全量重跑时
  // 每场会话都命中快路径 → 指针全空 → 652 条里只有 4 条挂得上原文。
  const usable = parts.filter((p) => p && p.path && !p.dry);
  if (!usable.length) return "";
  const p =
    usable.find((x) => x.from <= from && x.to >= from) ??
    usable.find((x) => x.from >= from) ??
    usable[usable.length - 1];
  const a = Math.max(from, p.from);
  const b = Math.min(to, p.to);
  return `${p.path}#${a}-${b >= a ? b : a}`;
}

/**
 * 把一个刚被标过时的条目从本轮候选池里摘掉。
 *
 * 摘掉是必须的：`known` 是这一轮开始时读的 current 快照，supersede 只改了块属性、
 * 不动这份内存数组。一轮里处理好几个会话时，后面那个会话的新条目仍可能拿「已经被
 * 标过时的旧条目」当候选，判成 covered 就直接不写了——而它参照的那条已经不是 current，
 * 等于拿一份作废的底稿去比对，还不报错。
 */
function forgetFromPool(pool, id) {
  const i = pool.findIndex((e) => e.id === id);
  if (i >= 0) pool.splice(i, 1);
}

/**
 * 处理队列。
 *
 * maxSessions / maxMs 是**一轮的预算**，不是总量：跑不完留到下一轮。
 * 没有预算的那一版把整个队列一口气抽完——第一次全量迁移时第 2 轮跑了四小时，
 * 那四小时里心跳不动、`mem status` 看着像死了，边缘新推的东西也插不进来。
 * 队列本身是持久的，留到下一轮没有任何损失；看不见进度才是真问题。
 *
 * 但轮预算只在**会话之间**看，还不够。2026-11-10 凌晨那几轮是这么过的：
 *
 *     02:55  这一轮到预算了（3 个会话 / 86 分钟）
 *     04:05  这一轮到预算了（4 个会话 / 52 分钟）
 *
 * 一轮 20 分钟的预算，实际跑 86 分钟才收手——因为一场会话内部的判重 + 写库
 * 可以无限制拖下去，而那时思源已经开始 5 秒超时。于是：
 *
 *   - maxSessionMs：会话内部也设闸门，到点就停手，已写的条目留着（幂等，下轮
 *     重跑会命中 hash 判重跳过），没写的留队列。
 *   - maxConsecutiveFailures：写库连着失败就熔断本轮。思源卡住时一条 5 秒超时，
 *     一场会话几十条就是几分钟纯等待，还会把内存越顶越高。
 *   - maxAttempts：老是过不去的会话进死信，别再压着队头。
 */
export async function processQueue({
  dry = false,
  useModel = true,
  onLine = () => {},
  maxSessions = Number.POSITIVE_INFINITY,
  maxMs = Number.POSITIVE_INFINITY,
  maxSessionMs = 10 * 60_000,
  maxConsecutiveFailures = 3,
  maxAttempts = 3,
  deps = null,
} = {}) {
  // deps 只给测试用：注入假的 store/sy，才能在几百毫秒里把"思源卡住"造出来。
  // 生产路径永远是 open() 自己建连接。
  const { cfg, sy, store } = deps ?? open();
  const extract = deps?.extract ?? extractEntries;

  const files = pending();
  const startedAt = Date.now();
  let done = 0;
  // 写库连续失败计数。成功一次就归零：只有"连着"失败才说明思源本身不对，
  // 偶尔一条写不进去（块索引没准备好）不该把整轮停掉。
  let writeFails = 0;
  let broken = null;
  /** 把本轮撞停的那场会话是谁。熔断之后要靠它判断「是思源坏了还是这一场坏了」。 */
  let brokenSession = null;
  const sum = { sessions: files.length, left: 0, written: 0, skipped: 0, replaced: 0, failed: 0, degraded: 0, raw: 0, entities: 0, pending: 0, dedupeCalls: 0, dedupeMs: 0, dead: 0, unfinished: 0, trimmed: 0, narrowed: 0, broken: false, tokens: { prompt: 0, completion: 0 } };

  // 先补上一轮没标完的"过时"。这件事跟模型无关，也不该等队列里有活才干——
  // 偏偏最容易漏的就是"队列空了但账本还欠着"。
  if (!dry) {
    const fixed = await flushPending(store, { log: onLine }).catch(() => 0);
    if (fixed) onLine(`  · 补做了 ${fixed} 条取代（上一轮写完新条目，但没标完旧条目）`);
  }

  if (!files.length) return sum;

  assertModel(cfg, { useModel, dry });

  // 判重用的条目池：一轮读一次，之后每写一条就往里补一条。
  // 不从 SQL 现查：块索引有 3 秒延迟，这一轮刚写的条目查不回来，会被判成"库里没有"。

  const known = !dry && useModel ? await store.listCurrent().catch(() => []) : [];
  // 判重池是有上限的（默认 3000）。撞到上限时判重会漏——新条目跟池子外那条
  // 是同一件事也发现不了——而这件事看不出来，只能主动报。
  if (known.length >= 3000) {
    onLine(`  · 判重池已满 ${known.length} 条，更早的条目不参与判重（考虑按话题裁剪或提高上限）`);
  }

  // 文档 id 要提前解析：归档和实体都要往对应文档里写。
  const ids = await store.docIds();
  // 实体表一轮只查一次，跨会话复用。刚建的实体在 SQL 索引里还查不到，
  // 每个会话各查一遍的话，下一个会话会把它当新的再造一份。
  let entityTable = null;

  /**
   * 死信收口：一次失败可能是偶然，连着 maxAttempts 次就不是了。
   *
   * 只有"这个会话本身有问题"的失败才计数（读不动、超预算、抽取不完整）。
   * 写库失败不在这里记——那是思源的毛病，记到会话头上会让一次故障把整队扫进 dead/。
   */
  /**
   * 思源还能不能读。
   *
   * 只读、无副作用、一条 SQL。用来在写失败之后区分「库整体坏了」和「这一条写不进去」——
   * 这个区别决定了要不要给会话记一次失败：记错了，一次故障能把整队扫进 dead/；
   * 不记，毒会话就永远压在队头。
   */
  const storeReadable = async () => {
    try {
      const rows = await sy.sql("SELECT id FROM blocks LIMIT 1");
      return Array.isArray(rows);
    } catch {
      return false;
    }
  };

  const park = (file, reason) => {
    const n = bumpAttempt(file);
    if (n < maxAttempts) {
      onLine(`    · 这个会话第 ${n} 次没过（${reason}），原文留在队列里`);
      return false;
    }
    try {
      deadLetter(file, `第 ${n} 次失败后挪入死信：${reason}`);
      sum.dead++;
      event("session.dead", { file: String(file).split("/").pop(), attempts: n, reason });
      onLine(`  ! 试了 ${n} 次还是不行，挪进 dead/：${String(file).split("/").pop()}（${reason}）`);
    } catch (e) {
      onLine(`  ! 挪死信失败：${e.message}`);
    }
    return true;
  };

  for (const file of files) {
    // 预算用尽就停：跑不完的留在队列里，下一轮接着来。
    if (done >= maxSessions || Date.now() - startedAt >= maxMs) {
      sum.left = files.length - done;
      onLine(`  · 这一轮到预算了（${done} 个会话 / ${Math.round((Date.now() - startedAt) / 60000)} 分钟），还剩 ${sum.left} 个下次继续`);
      break;
    }
    done++;
    const sessionStart = Date.now();
    const sessionDeadline = sessionStart + maxSessionMs;
    const overSession = () => Date.now() >= sessionDeadline;
    let aborted = false;
    let payload;
    try {
      payload = readSession(file);
    } catch (e) {
      onLine(`  ! 读不出来，跳过：${file}（${e.message}）`);
      event("session.read_fail", { file: String(file).split("/").pop(), message: e.message });
      sum.failed++;
      park(file, `读不动：${e.message}`);
      continue;
    }

    const turns = normalizeTurns(payload.turns ?? payload.events ?? []);
    const exchanges = toExchanges(turns, cfg.extract.minTurnChars);
    if (!exchanges.length) {
      if (!dry) archive(file);
      event("session.skip", { session: payload.session_id ?? "", reason: "no-exchanges" });
      sum.skipped++;
      continue;
    }

    event("session.begin", {
      session: payload.session_id ?? "",
      harness: payload.harness ?? "",
      machine: payload.machine ?? machineId(),
      project: projectOf(payload.cwd, payload.harness),
      turns: turns.length,
      exchanges: exchanges.length,
    });

    const turnFrom = Math.max(1, Number(payload.turnFrom) || 1);

    // 1) 先归档原文。顺序不能反：附件上传时内核会改名，路径只有传完才知道，
    //    而条目要把它写进属性里。先抽后归档的话，就得事后回填几十条属性。
    let parts = [];
    if (cfg.raw?.enabled !== false) {
      try {
        parts = await archiveRaw({
          sy,
          cfg,
          ids,
          payload: { ...payload, turnFrom },
          dry,
          log: onLine,
        });
        // 只数这一轮真传上去的：重试时会带回上次已传的段（reused），
        // 把它们算进来会让"原文 N 段"这个数虚高。
        if (!dry) sum.raw += parts.filter((p) => p.path && !p.reused).length;
      } catch (e) {
        // 归档失败就整场跳过：不抽、不写、不归档，留在队列里下轮重试。
        //
        // 原来是"条目照写，只是没有原文"。听着像取舍，实际是永久损失——条目一旦
        // 写进去，指针就定了，事后没有任何办法把它接回原文（轮次范围只在抽取那
        // 一刻存在）。而且多 part 归档中途失败时，已传的 part 没有正文引用、
        // 没传的也没进 parts，最后整场条目全是"无出处"。
        //
        // 重试很便宜：已上传的 part 记在 raw-index 里，下一轮从断点接着传。
        onLine(`  ! 原文归档失败，这场先不写：${e.message}（原文留在队列里，下轮重试）`);
        event("raw.fail", { session: payload.session_id ?? "", message: e.message });
        sum.failed++;
        continue;
      }
    }

    // 原文传完就已经可能超预算了：附件上传是最慢的一段（几 MB 的 jsonl 分片）。
    // 这里停手最划算——原文进度记在 raw-index 里，下轮从断点接着传，抽取和判重全不用重来。
    if (!dry && overSession()) {
      onLine(`    · 这场光归档就超了单会话上限（${Math.round((Date.now() - sessionStart) / 60000)} 分钟），条目下轮再抽`);
      event("session.budget", { session: payload.session_id ?? "", stage: "raw", ms: Date.now() - sessionStart });
      sum.failed++;
      park(file, "归档阶段超预算");
      continue;
    }

    // 2) 抽取时带上已有实体清单，从源头减少「同一款裤子五个名字」。
    if (!entityTable) entityTable = loadEntities();
    const entityShot = shotList(entityTable, cfg.extract?.entityShotList ?? 300);

    const fallbackEntity = (payload.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
    const tExtract = Date.now();
    const { entries, mode, error, batches, dropped, droppedBriefs, merged, usage, stoppedEarly, coveredThrough, remainingBatches } = await extract(cfg, exchanges, {
      fallbackEntity,
      useModel,
      entityShot,
      session: payload.session_id ?? "",
      // 抽取也要看表：一场 384 轮的会话能拆十几批，一批一次模型调用、实测单次
      // 最长 254 秒。不给它这个数，光抽取就能把一轮拖到四十分钟。
      deadline: sessionDeadline,
    });
    if (error) onLine(`  ! 模型失败，退回规则：${error}`);
    // 记账：回灌一百多个会话时，"花了多少 token"是唯一能判断该不该继续跑的指标。
    if (usage) {
      sum.tokens.prompt += usage.prompt;
      sum.tokens.completion += usage.completion;
    }
    event("extract.result", {
      session: payload.session_id ?? "",
      mode,
      batches,
      entries: entries.length,
      merged: merged ?? 0,
      dropped: dropped ?? 0,
      droppedBriefs: droppedBriefs?.length ? droppedBriefs : undefined,
      ms: Date.now() - tExtract,
      tokens: usage ?? { prompt: 0, completion: 0 },
      model: cfg.model?.name ?? "",
      prompt: promptVersion(),
      stoppedEarly: stoppedEarly || undefined,
      remainingBatches: stoppedEarly ? remainingBatches : undefined,
      error: error ?? undefined,
    });

    const batchNote = batches > 1 ? ` / ${batches} 批` : "";
    onLine(`${payload.session_id ?? "?"}  ${exchanges.length} 轮${batchNote}  ${mode}  抽出 ${entries.length} 条${merged ? `（合并重复 ${merged} 条）` : ""}`);
    if (dropped) onLine(`    · 超出上限，${dropped} 条没写（单批 ${cfg.extract?.maxEntriesPerBatch ?? 8} / 单会话${cfg.extract?.maxEntriesPerSession ? ` ${cfg.extract.maxEntriesPerSession}` : "自适应"}）`);

    // 3) 实体归一。dry 时不写表（会往库里造垃圾），只按原名走。
    let entityMap = new Map();
    if (!dry) {
      try {
        const names = [...new Set(entries.map((e) => e.entity).filter(Boolean))];
        const r = await resolveEntities({ sy, cfg, ids, names, useModel, table: entityTable, log: onLine });
        entityMap = r.map;
        sum.entities += r.created.length;
        sum.pending += r.weak.length;
        if (r.created.length) onLine(`    · 新实体 ${r.created.length} 个：${r.created.slice(0, 8).join("、")}`);
        if (r.weak.length) onLine(`    · ${r.weak.length} 组拿不准，写进 03-实体待确认`);
      } catch (e) {
        onLine(`    ! 实体归一失败：${e.message}（先用原名写）`);
      }
    }

    // 3.5) 判重：跟库里同话题的已有条目比一遍。
    // 抽取只看得到一个会话，跨会话的重复它看不见；这里补上这一眼。
    let decisions = new Map();
    if (!dry && useModel) {
      const news = entries.map((e) => ({
        entity: entityMap.get(e.entity) ?? e.entity,
        text: e.text,
        brief: e.brief ?? "",
        // 项目名要带上：判重的第三条通道是「同项目」，同一个 cwd 下的两条即使话题
        // 名不同也值得让模型看一眼。不带就是空的，那条通道对这批条目等于关闭。
        project: projectOf(payload.cwd, payload.harness),
      }));
      // 候选池给全库，不再只给「同话题」。
      // 只给同话题的那一版有个看不见的漏：同一件事被抽成两个话题名时（"本地调试环境"
      // vs "nanobot"），两边永远比不到一起，于是互相否定的两条结论都留在 current。
      // 筛候选的活交给 pickCandidates——它按字面覆盖率挑，同话题门槛低、跨话题门槛高，
      // 送进模型的仍然是每条最多 10 条。
      const pool = known;
      if (pool.length) {
        const t0 = Date.now();
        const callsBefore = dedupeStats().calls;
        decisions = await judgeDuplicates({ cfg, news, existing: pool, deadline: sessionDeadline });
        // 统计**真实模型调用次数**。原来记的是「有裁决的批次」——判 keep 的时候一条裁决
        // 都没有，计数是 0，和 dedupeStats().calls 对不上，也看不出这一轮到底花了多少调用。
        sum.dedupeCalls += dedupeStats().calls - callsBefore;
        sum.dedupeMs += Date.now() - t0;
        for (const [idx, d] of decisions) {
          event("dedupe.decision", {
            session: payload.session_id ?? "",
            action: d.action,
            entity: news[idx]?.entity ?? "",
            brief: (news[idx]?.brief ?? "").slice(0, 40),
            target: d.id,
          });
        }
        if (decisions.size) onLine(`    · 判重：${decisions.size} 条跟库里撞了（${Math.round((Date.now() - t0) / 100) / 10}s）`);
      }
    }

    // 4) 写条目
    let failedHere = 0;
    let writtenHere = 0;
    let skippedHere = 0;
    // 开写之前就已经超预算的，这一场就写完再算——见下面那条注释。
    const overAtWriteStart = !dry && overSession();
    for (const [idx, e] of entries.entries()) {
      // 单会话闸门：到点就收手。
      //
      // 但**开写之前就已经超时的那一场要写完**。抽取一趟可能是十几分钟的模型调用，
      // 时间全花在抽取和判重上、到写这一步才收手，等于这一场白抽——下轮从头再来，
      // 三趟之后还会被当成老赖挪进 dead/。所以这个标记在进循环前算一次：
      // 进来时还在预算内，才允许写到一半停下；进来时就超了，这一场写完。
      if (!overAtWriteStart && writtenHere > 0 && overSession()) {
        aborted = true;
        onLine(
          `    · 这场超了单会话上限（${Math.round((Date.now() - sessionStart) / 60000)} 分钟），已写 ${writtenHere} 条，剩下的下轮继续`
        );
        event("session.budget", { session: payload.session_id ?? "", stage: "write", written: writtenHere, total: entries.length, ms: Date.now() - sessionStart });
        break;
      }
      const entity = entityMap.get(e.entity) ?? e.entity;
      const verdict = decisions.get(idx);
      // 抽取是「一批一次模型调用」，那一批抽出来的 4–10 条结论共用同一个 from/to，
      // 指针因此常常横跨几十轮、三万多字——点开等于没指。用结论里那些模型编不出来
      // 的硬锚（文件名、参数、端口、报错串）落回原文行，把范围收窄到真正出处的
      // 那几轮。原文就在本进程的 payload.turns 里，不用下载附件、不用再调模型。
      //
      // 收窄是保守的：跨轮归纳、锚点分散、证据掉太多，一律原样返回。宽了只是多读
      // 几行，窄错了是把出处排除在外而且看不出来，两者代价不对称。
      const anchor =
        e.from != null && parts.length
          ? narrowAnchor(e.text, payload.turns ?? payload.events ?? [], e.from, e.to)
          : null;
      const aFrom = anchor?.from ?? e.from;
      const aTo = anchor?.to ?? e.to;
      const rawPtr =
        e.from != null && parts.length ? ptrFor(parts, turnFrom + aFrom, turnFrom + aTo) : "";
      if (anchor?.narrowed && !dry) {
        sum.narrowed++;
        event("anchor.narrow", {
          session: payload.session_id ?? "",
          from: turnFrom + e.from,
          to: turnFrom + e.to,
          narrowedFrom: turnFrom + aFrom,
          narrowedTo: turnFrom + aTo,
          rows: anchor.rows,
        });
      }
      if (dry) {
        // 用条目自己的轮次范围，不是整个 part：dry 的意义就是看指针会精确到哪一段。
        const where =
          e.from != null ? `  · 第 ${turnFrom + aFrom}–${turnFrom + aTo} 轮${anchor?.narrowed ? `（收窄，原 ${turnFrom + e.from}–${turnFrom + e.to}）` : ""}` : parts[0]?.dry ? `  · 整段 ${parts[0].from}–${parts[0].to}` : "";
        onLine(`    [${entity || "-"}] ${e.text}${where}`);
        continue;
      }
      if (verdict?.action === "covered") {
        // 库里那条已经把这件事说完了，不重复写。
        sum.skipped++;
        skippedHere++;
        event("entry.skip", {
          session: payload.session_id ?? "",
          reason: "covered",
          entity,
          brief: (e.brief ?? "").slice(0, 40),
          target: verdict.id,
        });
        onLine(`    = 已有：${e.brief || e.text.slice(0, 24)}`);
        continue;
      }
      try {
        const r = await store.writeEntry(
          { ...e, entity },
          {
            source: payload.harness ?? "",
            session: payload.session_id ?? "",
            date: payload.date ?? "",
            machine: payload.machine ?? machineId(),
            project: projectOf(payload.cwd, payload.harness),
            raw: rawPtr,
          }
        );
        // 思源回了话，说明它不是卡死，计数器归零。
        writeFails = 0;
        if (r.duplicate) {
          sum.skipped++;
          skippedHere++;
          event("entry.skip", { session: payload.session_id ?? "", reason: "hash-duplicate", entity, hash: r.id });
          // 上一轮可能"新条目写成功、旧条目没标过时"就断了。重试到这一轮时，
          // 新条目会命中 hash 被判重跳过，于是 supersede 永远补不上，新旧两条
          // 同时是 current。所以这里要顺着 verdict 把那个动作补做完。
          if (verdict?.action === "replace" && verdict.id && verdict.id !== r.id) {
            notePending({ old: verdict.id, new: r.id, entity });
            await store.supersede(verdict.id, r.id);
            dropPending(verdict.id);
            forgetFromPool(known, verdict.id);
            sum.replaced++;
            event("entry.replace", { session: payload.session_id ?? "", old: verdict.id, new: r.id, entity, retried: true });
            onLine(`    ~ 补做取代（上一轮没做完）`);
          }
        } else {
          sum.written++;
          writtenHere++;
          event("entry.write", {
            session: payload.session_id ?? "",
            id: r.id,
            entity,
            type: e.type ?? "",
            len: String(e.text ?? "").length,
            confidence: e.confidence ?? "",
            status: "current",
          });
          onLine(`    + [${entity || "-"}] ${e.text}`);
          // 这一场新写的条目也要进池子：同一轮里后面的会话能看见它。
          // 带 project：一轮里处理多个会话时，前一个会话刚写的条目要能参与后一个会话的
          // 「同项目」判重。漏了这个字段，那条兜底通道对同一轮内的新条目等于关闭。
          known.push({ id: r.id, entity, brief: e.brief ?? "", text: e.text, project: projectOf(payload.cwd, payload.harness) });
          if (verdict?.action === "replace") {
            // 新的更全：写新的，旧的标过时，指针留着。
            // 先记账再动：upsert 成功了但 supersede 挂了，下一轮能补。
            notePending({ old: verdict.id, new: r.id, entity });
            await store.supersede(verdict.id, r.id);
            dropPending(verdict.id);
            forgetFromPool(known, verdict.id);
            sum.replaced++;
            event("entry.replace", { session: payload.session_id ?? "", old: verdict.id, new: r.id, entity });
            onLine(`    ~ 取代了旧的一条`);
          }
        }
      } catch (err) {
        failedHere++;
        writeFails++;
        event("error", { where: "write-entry", session: payload.session_id ?? "", entity, message: err.message });
        onLine(`    ! 写入失败：${err.message}`);
        // 连着几条都写不进去，就不是这一条的问题了：思源多半卡住了。
        // 继续写只会把 5 秒超时一条条叠起来，把内存和这一轮的时间一起耗掉。
        if (writeFails >= maxConsecutiveFailures) {
          broken = `连续 ${writeFails} 次写库失败：${err.message}`;
          brokenSession = file;
          break;
        }
      }
    }

    // 原文传上去了、但一条条目都没写（全被 covered / 全重复）时，附件在正文里
    // 没有任何引用——"清理未引用资源"会把它当垃圾扫走。给分组标题挂一个会话级链接顶上：
    // 不伪造内容，只建一个标题，下一轮真写出条目时列表会接在它后面。
    if (parts.length && !writtenHere && !dry) {
      const anchor = await store
        .ensureGroupAnchor(
          {
            source: payload.harness ?? "",
            session: payload.session_id ?? "",
            project: projectOf(payload.cwd, payload.harness),
          },
          payload.date ?? "",
          // 每个 part 都要被引用：超长会话按字节切成多段，只挂第一段等于让后面几段
          // 变成"未引用附件"，下次清理就被扫走。传 ptr（带 #轮次范围），标题上
          // 才能写出「第 675–712 轮」，几个 part 堆在一起也分得清。
          parts.filter((p) => p.ptr).map((p) => p.ptr)
        )
        .catch((e) => {
          onLine(`    ! 给原文建锚点失败：${e.message}`);
          return "";
        });
      event("raw.orphan", {
        session: payload.session_id ?? "",
        parts: parts.length,
        anchored: Boolean(anchor),
      });
      onLine(
        anchor
          ? `    · 这场没有新条目，原文链接挂在分组标题上（${parts.length} 个 part）`
          : `    · 原文已上传，但这场没有新条目，也没建成锚点（${parts.length} 个 part）`
      );
    }

    sum.failed += failedHere;
    const degraded = mode === "heuristic-after-error" || mode === "partial";
    if (degraded) sum.degraded++;

    // 抽取到预算就收手的那种：已经抽过的那几轮从队列里摘掉，剩下的下轮接着抽。
    // 放在写完条目之后做——先摘再写，万一写库挂了，那几轮的结论就再也没人抽了。
    //
    // 但「放在后面」还不够：**写失败了就不能摘**。原来只看 stoppedEarly，于是
    // 「一条都没写进去」也会把前 N 轮从队列删掉，那几轮从此没人再抽，而日志上
    // 还写着「前 N 轮已写进库」。抽出来没写进去 = 没抽，覆盖点不能算数。
    // 先把「还剩多少轮没抽」算出来，它跟「写库干不干净」是两件事。
    //
    // 上一版把这两件事塞进同一个条件（wroteCleanly 里带 writtenHere > 0），于是
    // 零写入时既不摘轮次、也不置 trimmed，complete 就成了 true——**直接归档**，
    // 剩下的轮次跟着文件一起消失。而零写入很常见：全被 hash 判重跳过、或者模型
    // 这批没抽出东西。抽到点收手 + 零写入 = 剩余轮次必须留在队列里。
    const rawTurns = payload.turns ?? payload.events ?? [];
    const restTurns = stoppedEarly && coveredThrough != null ? rawTurns.slice(coveredThrough + 1) : [];
    const hasRest = restTurns.length > 0;
    // 写库干净 = 没有失败、也没熔断。不含「写了几条」——那是下面摘轮次的额外前提。
    const wroteCleanly = failedHere === 0 && !broken;

    let trimmed = false;
    if (!dry && hasRest && wroteCleanly && writtenHere > 0) {
      const rest = restTurns;
      if (rest.length) {
        try {
          rewrite(file, { ...payload, turns: rest, events: undefined, turnFrom: turnFrom + coveredThrough + 1 });
          trimmed = true;
          sum.trimmed++;
          event("session.trim", {
            session: payload.session_id ?? "",
            covered: coveredThrough + 1,
            left: rest.length,
            batchesLeft: remainingBatches,
          });
          onLine(`    · 抽到点了：前 ${coveredThrough + 1} 轮已写进库（${writtenHere} 条），还剩 ${rest.length} 轮，下轮接着抽`);
        } catch (e) {
          onLine(`    ! 队列改写失败，这场下轮会从头重抽：${e.message}`);
        }
      }
    }

    event("session.end", {
      session: payload.session_id ?? "",
      entries: entries.length,
      written: writtenHere,
      skipped: skippedHere,
      failed: failedHere,
      degraded,
      aborted,
      trimmed,
    });
    // 「抽到点了但还有轮次没抽」不算做完。这条原来漏了，导致零写入时照样归档。
    const complete = !aborted && failedHere === 0 && !degraded && !trimmed && !hasRest;
    // 没做完的场次要单独报出来：失败数是按"条"算的，超预算停手的那场一条都没失败，
    // 只看 failed 会以为一切正常。
    if (!complete && !trimmed) sum.unfinished++;
    if (!dry && complete) archive(file);
    else if (!dry && !trimmed) {
      if (degraded) onLine("    · 抽取没跑完整，原文留在队列里，下次重试");
      if (failedHere > 0 && !degraded) {
        onLine(`    · ${failedHere} 条没写进去，这场留在队列里（不摘轮次，否则那几轮就再没人抽了）`);
      }
      // 抽不到东西和超预算是这个会话自己的毛病，记次数；纯粹写不进去是思源的问题，
      // 不记——否则一次思源抖动就能把整队会话挨个记满、集体挪进 dead/。
      if (aborted || degraded) park(file, aborted ? "单会话超预算" : "抽取不完整");
      else if (hasRest) {
        // 抽到点了，但这一轮一条都没落库（全被跳过 / 模型给的条目被截光），
        // 而后面还有轮次没抽。留在队列重试，同时记一次——否则这场会在队头
        // 无限空转，烧的是模型的钱。
        onLine(`    · 抽到点了，但一条都没落库，还剩 ${restTurns.length} 轮；留在队列重试`);
        park(file, "抽到点了但一条都没写进去");
      }
    }

    // 写库熔断：本轮到此为止。剩下的会话原样留在队列，下一轮重来。
    if (broken) break;
  }

  if (broken) {
    sum.broken = true;
    sum.left = Math.max(sum.left, files.length - done);
    event("round.broken", { reason: broken, written: sum.written, session: brokenSession ?? "" });
    onLine(`  !! 本轮熔断：${broken}`);
    onLine("  !! 思源多半卡住了（内存/磁盘），先去看容器；队列原样保留，好了会自动接着跑");
    // 光熔断不够：队列是 FIFO，撞停的那场还压在队头，下一轮原样重来，后面永远轮不到。
    // 但也不能一律记账——思源整体卡住时，每条会话都会撞一次，连记三轮就把全队扫进 dead/。
    //
    // 判据要能区分「库坏了」和「这一条写不进去」。**不能只看本轮写了多少**：
    // 毒会话排在队首时整轮 written 恒为 0，那样它永远攒不到次数、永远卡在队头，
    // 死信机制形同虚设（上一版就是这么错的）。所以本轮零写入时补一次**读探针**：
    // 读得动 = 库是好的，是这一场自己的毛病；连读都不行，那才是思源的事，不记账。
    if (brokenSession) {
      const alive = sum.written > 0 || (await storeReadable());
      if (alive) {
        park(brokenSession, `写库连续失败${sum.written > 0 ? "（同一轮别的会话写得进去）" : "（读探针正常，库没坏）"}：${broken}`);
      } else {
        onLine("  !! 思源连读都读不动，这次不记在任何会话头上（一次故障不该把整队扫进死信）");
      }
    }
  }

  // 一轮处理完再收敛，不是每个会话跑一次。
  //
  // 逐会话收敛有两个问题：一是同一批会话说的是同一件事时，先收进来的名字还没齐，
  // 收敛看不到全貌；二是每会话一次调用，回灌一百个会话就是一百次，而且模型每次
  // 都可能给出稍有不同的保留名，合并结果会漂。放到最后统一看一次全表，稳得多。
  //
  // 这时条目已经写进库了，所以必须走 mergeEntities——它会回填块属性。
  if (!dry && useModel && hasModel(cfg) && entityTable?.length) {
    try {
      // 收敛要给模型看证据：光给名字，「mcp-adapter」和「DSH MCP 插件生态」
      // 在字面上就是一大一小两个名字，看不出后者桶里装的其实是前者。
      const samples = new Map();
      for (const r of await store.listCurrent().catch(() => [])) {
        const list = samples.get(r.entity) ?? [];
        if (list.length < 3 && r.brief) list.push(r.brief);
        samples.set(r.entity, list);
      }
      const merges = await convergeTopics({ cfg, table: entityTable, samples, log: onLine, deadline: Date.now() + 5 * 60_000 });
      for (const [from, to] of merges) {
        try {
          const r = await mergeEntities(sy, from, to, { log: onLine, box: ids.notebook });
          onLine(`    · 收敛 ${from} → ${to}，回填 ${r.changed} 条`);
        } catch (err) {
          onLine(`    ! 收敛失败 ${from} → ${to}：${err.message}`);
        }
      }
    } catch (err) {
      onLine(`    · 话题收敛跳过：${err.message}`);
    }
  }

  return sum;
}
