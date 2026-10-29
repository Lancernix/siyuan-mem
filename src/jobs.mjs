/**
 * 两件可以被反复调用的事：把日志投进队列、把队列写进思源。
 *
 * 单独抽出来是为了让 `cli` 和 `serve` 走同一段代码。两份实现迟早会漂，
 * 而"手动跑成功、后台跑丢字"是最难查的一类问题。
 */
import { statSync } from "node:fs";
import { loadConfig, loadOffsets, saveOffsets, offsetsOf, machineId } from "./config.mjs";
import { hasModel } from "./llm.mjs";
import { SiYuan } from "./siyuan.mjs";
import { Store } from "./store.mjs";
import { normalizeTurns, toExchanges, extractEntries } from "./extract.mjs";
import { pending, readSession, archive, drop } from "./inbox.mjs";
import { readLog } from "./readers/index.mjs";
import { archive as archiveRaw } from "./raw.mjs";
import { loadEntities, shotList, resolveEntities } from "./entities.mjs";

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
export function enqueueLog(file, { format = "" } = {}) {
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
  const fresh = prev && st.size >= prev.bytes && log.turns.length >= prev.turns;
  const turns = fresh ? log.turns.slice(prev.turns) : log.turns;
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
  offsets[file] = { bytes: st.size, turns: log.turns.length, at: Date.now() };
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
  const usable = parts.filter((p) => p && p.path && !p.skip && !p.dry);
  if (!usable.length) return "";
  const p =
    usable.find((x) => x.from <= from && x.to >= from) ??
    usable.find((x) => x.from >= from) ??
    usable[usable.length - 1];
  const a = Math.max(from, p.from);
  const b = Math.min(to, p.to);
  return `${p.path}#${a}-${b >= a ? b : a}`;
}

export async function processQueue({ dry = false, useModel = true, onLine = () => {} } = {}) {
  const { cfg, sy, store } = open();

  const files = pending();
  const sum = { sessions: files.length, written: 0, skipped: 0, failed: 0, degraded: 0, raw: 0, entities: 0, pending: 0, tokens: { prompt: 0, completion: 0 } };
  if (!files.length) return sum;

  assertModel(cfg, { useModel, dry });

  // 文档 id 要提前解析：归档和实体都要往对应文档里写。
  const ids = await store.docIds();
  // 实体表一轮只查一次，跨会话复用。刚建的实体在 SQL 索引里还查不到，
  // 每个会话各查一遍的话，下一个会话会把它当新的再造一份。
  let entityTable = null;

  for (const file of files) {
    let payload;
    try {
      payload = readSession(file);
    } catch (e) {
      onLine(`  ! 读不出来，跳过：${file}（${e.message}）`);
      sum.failed++;
      continue;
    }

    const turns = normalizeTurns(payload.turns ?? payload.events ?? []);
    const exchanges = toExchanges(turns, cfg.extract.minTurnChars);
    if (!exchanges.length) {
      if (!dry) archive(file);
      sum.skipped++;
      continue;
    }

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
        if (!dry) sum.raw += parts.filter((p) => p.path).length;
      } catch (e) {
        // 归档失败不该挡住记忆本身：条目照写，只是暂时没有原文指针。
        onLine(`  ! 原文归档失败：${e.message}（条目照写，只是没有原文）`);
      }
    }

    // 2) 抽取时带上已有实体清单，从源头减少「同一款裤子五个名字」。
    if (!entityTable) entityTable = await loadEntities(sy, ids.entities);
    const entityShot = shotList(entityTable, cfg.extract?.entityShotList ?? 300);

    const fallbackEntity = (payload.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
    const { entries, mode, error, batches, dropped, usage } = await extractEntries(cfg, exchanges, {
      fallbackEntity,
      useModel,
      entityShot,
    });
    if (error) onLine(`  ! 模型失败，退回规则：${error}`);
    // 记账：回灌一百多个会话时，"花了多少 token"是唯一能判断该不该继续跑的指标。
    if (usage) {
      sum.tokens.prompt += usage.prompt;
      sum.tokens.completion += usage.completion;
    }

    const batchNote = batches > 1 ? ` / ${batches} 批` : "";
    onLine(`${payload.session_id ?? "?"}  ${exchanges.length} 轮${batchNote}  ${mode}  抽出 ${entries.length} 条`);
    if (dropped) onLine(`    · 超出单会话上限，${dropped} 条没写（调 extract.maxEntriesPerSession 可放开）`);

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
        if (r.weak.length) onLine(`    · ${r.weak.length} 组拿不准，写进 05-实体待确认`);
      } catch (e) {
        onLine(`    ! 实体归一失败：${e.message}（先用原名写）`);
      }
    }

    // 4) 写条目
    let failedHere = 0;
    for (const e of entries) {
      const entity = entityMap.get(e.entity) ?? e.entity;
      const rawPtr =
        e.from != null && parts.length ? ptrFor(parts, turnFrom + e.from, turnFrom + e.to) : "";
      if (dry) {
        // 用条目自己的轮次范围，不是整个 part：dry 的意义就是看指针会精确到哪一段。
        const where =
          e.from != null ? `  · 第 ${turnFrom + e.from}–${turnFrom + e.to} 轮` : parts[0]?.dry ? `  · 整段 ${parts[0].from}–${parts[0].to}` : "";
        onLine(`    [${entity || "-"}] ${e.text}${where}`);
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
            project: (payload.cwd ?? "").split("/").filter(Boolean).pop() ?? "",
            raw: rawPtr,
            // 挂在会话分组项上的原文链接。一个会话通常只有一个 part。
            rawPath: parts.find((p) => p.path)?.path ?? "",
          }
        );
        if (r.duplicate) sum.skipped++;
        else {
          sum.written++;
          onLine(`    + [${entity || "-"}] ${e.text}`);
        }
      } catch (err) {
        failedHere++;
        onLine(`    ! 写入失败：${err.message}`);
      }
    }

    sum.failed += failedHere;
    const degraded = mode === "heuristic-after-error" || mode === "partial";
    if (degraded) sum.degraded++;
    if (!dry && failedHere === 0 && !degraded) archive(file);
    else if (degraded) onLine("    · 抽取没跑完整，原文留在队列里，下次重试");
  }

  return sum;
}
