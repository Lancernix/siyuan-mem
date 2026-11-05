/**
 * 两件可以被反复调用的事：把日志投进队列、把队列写进思源。
 *
 * 单独抽出来是为了让 `cli` 和 `serve` 走同一段代码。两份实现迟早会漂，
 * 而"手动跑成功、后台跑丢字"是最难查的一类问题。
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { loadConfig, loadOffsets, saveOffsets, offsetsOf, machineId } from "./config.mjs";
import { hasModel } from "./llm.mjs";
import { SiYuan } from "./siyuan.mjs";
import { Store } from "./store.mjs";
import { normalizeTurns, toExchanges, extractEntries, PROMPT_VERSION } from "./extract.mjs";
import { pending, readSession, archive, drop } from "./inbox.mjs";
import { readLog } from "./readers/index.mjs";
import { event } from "./log.mjs";
import { archive as archiveRaw } from "./raw.mjs";
import { loadEntities, shotList, resolveEntities, convergeTopics, mergeEntities } from "./entities.mjs";
import { judgeDuplicates } from "./dedupe.mjs";
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
    // 家目录名本身也不是项目（/Users/lancernix_1/Downloads → 退到 harness）。
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

export async function processQueue({ dry = false, useModel = true, onLine = () => {} } = {}) {
  const { cfg, sy, store } = open();

  const files = pending();
  const sum = { sessions: files.length, written: 0, skipped: 0, replaced: 0, failed: 0, degraded: 0, raw: 0, entities: 0, pending: 0, dedupeCalls: 0, dedupeMs: 0, tokens: { prompt: 0, completion: 0 } };

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

  for (const file of files) {
    let payload;
    try {
      payload = readSession(file);
    } catch (e) {
      onLine(`  ! 读不出来，跳过：${file}（${e.message}）`);
      event("session.read_fail", { file: String(file).split("/").pop(), message: e.message });
      sum.failed++;
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

    // 2) 抽取时带上已有实体清单，从源头减少「同一款裤子五个名字」。
    if (!entityTable) entityTable = loadEntities();
    const entityShot = shotList(entityTable, cfg.extract?.entityShotList ?? 300);

    const fallbackEntity = (payload.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
    const tExtract = Date.now();
    const { entries, mode, error, batches, dropped, droppedBriefs, merged, usage } = await extractEntries(cfg, exchanges, {
      fallbackEntity,
      useModel,
      entityShot,
      session: payload.session_id ?? "",
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
      prompt: PROMPT_VERSION,
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
        if (r.weak.length) onLine(`    · ${r.weak.length} 组拿不准，写进 05-实体待确认`);
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
      }));
      const want = new Set(news.map((n) => String(n.entity ?? "").replace(/\s+/g, "").toLowerCase()));
      const pool = known.filter((k) => want.has(String(k.entity ?? "").replace(/\s+/g, "").toLowerCase()));
      if (pool.length) {
        const t0 = Date.now();
        decisions = await judgeDuplicates({ cfg, news, existing: pool });
        sum.dedupeCalls += decisions.size ? 1 : 0;
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
    for (const [idx, e] of entries.entries()) {
      const entity = entityMap.get(e.entity) ?? e.entity;
      const verdict = decisions.get(idx);
      const rawPtr =
        e.from != null && parts.length ? ptrFor(parts, turnFrom + e.from, turnFrom + e.to) : "";
      if (dry) {
        // 用条目自己的轮次范围，不是整个 part：dry 的意义就是看指针会精确到哪一段。
        const where =
          e.from != null ? `  · 第 ${turnFrom + e.from}–${turnFrom + e.to} 轮` : parts[0]?.dry ? `  · 整段 ${parts[0].from}–${parts[0].to}` : "";
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
          known.push({ id: r.id, entity, brief: e.brief ?? "", text: e.text });
          if (verdict?.action === "replace") {
            // 新的更全：写新的，旧的标过时，指针留着。
            // 先记账再动：upsert 成功了但 supersede 挂了，下一轮能补。
            notePending({ old: verdict.id, new: r.id, entity });
            await store.supersede(verdict.id, r.id);
            dropPending(verdict.id);
            sum.replaced++;
            event("entry.replace", { session: payload.session_id ?? "", old: verdict.id, new: r.id, entity });
            onLine(`    ~ 取代了旧的一条`);
          }
        }
      } catch (err) {
        failedHere++;
        event("error", { where: "write-entry", session: payload.session_id ?? "", entity, message: err.message });
        onLine(`    ! 写入失败：${err.message}`);
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
    event("session.end", {
      session: payload.session_id ?? "",
      entries: entries.length,
      written: writtenHere,
      skipped: skippedHere,
      failed: failedHere,
      degraded,
    });
    if (!dry && failedHere === 0 && !degraded) archive(file);
    else if (degraded) onLine("    · 抽取没跑完整，原文留在队列里，下次重试");
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
      const merges = await convergeTopics({ cfg, table: entityTable, samples, log: onLine });
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
