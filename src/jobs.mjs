/**
 * 两件可以被反复调用的事：把日志投进队列、把队列写进思源。
 *
 * 单独抽出来是为了让 `cli` 和 `serve` 走同一段代码。两份实现迟早会漂，
 * 而"手动跑成功、后台跑丢字"是最难查的一类问题。
 */
import { statSync } from "node:fs";
import { loadConfig, loadOffsets, saveOffsets, hasModel } from "./config.mjs";
import { SiYuan } from "./siyuan.mjs";
import { Store } from "./store.mjs";
import { normalizeTurns, toExchanges, extractEntries } from "./extract.mjs";
import { pending, readSession, archive, drop } from "./inbox.mjs";
import { readLog } from "./readers/index.mjs";

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

  const offsets = loadOffsets();
  const st = statSync(file);
  const prev = offsets[file];
  const fresh = prev && st.size >= prev.bytes && log.turns.length >= prev.turns;
  const turns = fresh ? log.turns.slice(prev.turns) : log.turns;
  const before = log.turns.length - turns.length;
  if (!turns.length) return { harness: log.harness, added: 0, before, upToDate: true };

  const target = drop({
    session_id: log.sessionId || `log-${Date.now()}`,
    harness: log.harness,
    cwd: log.cwd,
    date: new Date().toISOString().slice(0, 10),
    turns,
  });
  // 先投递再记偏移不成立：投递失败会重读同一段。反过来先记偏移再投递，
  // 万一进程在这一行之后被杀，那一段就永远丢了。所以顺序是投递成功才记偏移。
  offsets[file] = { bytes: st.size, turns: log.turns.length, at: Date.now() };
  saveOffsets(offsets);

  return { harness: log.harness, added: turns.length, before, target };
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

export async function processQueue({ dry = false, useModel = true, onLine = () => {} } = {}) {
  const { cfg, store } = open();

  const files = pending();
  const sum = { sessions: files.length, written: 0, skipped: 0, failed: 0, degraded: 0 };
  if (!files.length) return sum;

  assertModel(cfg, { useModel, dry });

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

    const fallbackEntity = (payload.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
    const { entries, mode, error, batches, dropped } = await extractEntries(cfg, exchanges, {
      fallbackEntity,
      useModel,
    });
    if (error) onLine(`  ! 模型失败，退回规则：${error}`);

    const batchNote = batches > 1 ? ` / ${batches} 批` : "";
    onLine(`${payload.session_id ?? "?"}  ${exchanges.length} 轮${batchNote}  ${mode}  抽出 ${entries.length} 条`);
    if (dropped) onLine(`    · 超出单会话上限，${dropped} 条没写（调 extract.maxEntriesPerSession 可放开）`);

    // 失败按会话计：一个会话写挂了，不能连累后面几个都不归档。
    let failedHere = 0;
    for (const e of entries) {
      if (dry) {
        onLine(`    [${e.entity || "-"}] ${e.text}`);
        continue;
      }
      try {
        const r = await store.writeEntry(e, {
          source: payload.harness ?? "",
          session: payload.session_id ?? "",
          date: payload.date ?? "",
        });
        if (r.duplicate) sum.skipped++;
        else {
          sum.written++;
          onLine(`    + [${e.entity || "-"}] ${e.text}`);
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
