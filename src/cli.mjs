#!/usr/bin/env node
import { loadConfig, CONFIG_PATH, INBOX_DIR, hasModel } from "./config.mjs";
import { SiYuan } from "./siyuan.mjs";
import { Store, formatHits } from "./store.mjs";
import { normalizeTurns, toExchanges, extractEntries } from "./extract.mjs";
import { pending, readSession, archive, drop } from "./inbox.mjs";
import { readLog } from "./readers.mjs";

const USAGE = `mem —— 把 harness 会话变成思源笔记里的记忆条目

  mem init [--force]           建笔记本和三个文档（幂等；--force 丢掉 id 缓存重解析）
  mem status                   连通性、条目数、待处理队列长度
  mem once [--dry] [--no-model] 处理 inbox 里的全部会话
  mem ingest <file.json>       把一个会话文件投入队列（测试用）
  mem ingest-log <日志>        直接读 harness 的会话日志入队（workbuddy|claude|dsh）
  mem search <词...>           查记忆，默认只看 current
  mem search --all <词...>     查记忆，含已过时的
  mem review [n]               列最近 n 条，人工扫一眼
  mem remember <文本> [--entity X] [--type decision|fact|preference|reference]
  mem forget <块id>            标成 superseded（不删）

配置：${CONFIG_PATH}
队列：${INBOX_DIR}
`;

/** 只有这几个键吃后面的值，其余 --xxx 一律当布尔，免得 "search --all 风盾" 把查询词吃掉。 */
const VALUED = new Set(["entity", "type", "confidence", "limit", "format"]);

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (VALUED.has(key) && next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { flags, rest };
}

function make() {
  const cfg = loadConfig();
  const sy = new SiYuan({
    baseUrl: cfg.siyuan.baseUrl,
    token: cfg.siyuan.token,
    // 注入路径要能快速放弃，不要卡住对话；写路径慢一点没关系。
    timeoutMs: 5000,
  });
  return { cfg, sy, store: new Store(sy, cfg) };
}

async function cmdInit(flags) {
  const { store } = make();
  const ids = await store.init({ force: Boolean(flags.force) });
  console.log("笔记本与文档就绪：");
  for (const [k, v] of Object.entries(ids)) console.log(`  ${k.padEnd(8)} ${v}`);
}

async function cmdStatus() {
  const { cfg, sy, store } = make();
  const version = await sy.version();
  const stats = await store.stats();
  console.log(`思源         ${cfg.siyuan.baseUrl}  v${version}`);
  console.log(`笔记本       ${cfg.siyuan.notebook}`);
  console.log(`条目         current ${stats.current ?? 0} / superseded ${stats.superseded ?? 0}`);
  console.log(`模型         ${hasModel(cfg) ? cfg.model.name : "未配置（走规则抽取）"}`);
  console.log(`待处理       ${pending().length} 个会话在队列里`);
}

async function cmdOnce(flags) {
  const { cfg, store } = make();
  const files = pending();
  if (!files.length) {
    console.log("队列是空的。");
    return;
  }
  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    let payload;
    try {
      payload = readSession(file);
    } catch (e) {
      console.error(`  ! 读不出来，跳过：${file}（${e.message}）`);
      failed++;
      continue;
    }
    const turns = normalizeTurns(payload.turns ?? payload.events ?? []);
    const exchanges = toExchanges(turns, cfg.extract.minTurnChars);
    if (!exchanges.length) {
      if (!flags.dry) archive(file);
      skipped++;
      continue;
    }
    const fallbackEntity = (payload.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
    const { entries, mode, error } = await extractEntries(cfg, exchanges, {
      fallbackEntity,
      useModel: !flags["no-model"],
    });
    if (error) console.error(`  ! 模型失败，退回规则：${error}`);

    console.log(`${payload.session_id ?? "?"}  ${exchanges.length} 轮  ${mode}  抽出 ${entries.length} 条`);
    for (const e of entries) {
      if (flags.dry) {
        console.log(`    [${e.entity || "-"}] ${e.text}`);
        continue;
      }
      try {
        const r = await store.writeEntry(e, {
          source: payload.harness ?? "",
          session: payload.session_id ?? "",
          date: payload.date ?? "",
        });
        if (r.duplicate) skipped++;
        else {
          written++;
          console.log(`    + [${e.entity || "-"}] ${e.text}`);
        }
      } catch (err) {
        failed++;
        console.error(`    ! 写入失败：${err.message}`);
      }
    }
    // 只有全部写完才归档，否则留在队列里下次重来（writeEntry 自带去重，重跑安全）。
    if (!flags.dry && failed === 0) archive(file);
  }
  console.log(`\n写入 ${written}，跳过 ${skipped}，失败 ${failed}`);
}

async function cmdIngest(args) {
  const file = args[0];
  if (!file) throw new Error("要给一个 json 文件");
  const payload = readSession(file);
  const target = drop(payload);
  console.log(`已入队：${target}`);
}

async function cmdIngestLog(flags, args) {
  const file = args[0];
  if (!file) throw new Error("要给一个日志文件路径");
  const log = readLog(file, flags.format === true ? "" : flags.format ?? "");
  if (!log.turns.length) {
    console.log("这条日志里没有能用的问答。");
    return;
  }
  const target = drop({
    session_id: log.sessionId || `log-${Date.now()}`,
    harness: log.harness,
    cwd: log.cwd,
    date: new Date().toISOString().slice(0, 10),
    turns: log.turns,
  });
  console.log(`${log.harness}   ${log.turns.length} 轮   ${target}`);
}

async function cmdSearch(flags, words) {
  const { store } = make();
  const q = words.join(" ");
  if (!q) throw new Error("要给一个查询词");
  const hits = await store.search(q, { includeSuperseded: Boolean(flags.all) });
  console.log(formatHits(hits));
}

async function cmdReview(args) {
  const n = Number(args[0]) || 20;
  const { store } = make();
  console.log(formatHits(await store.review(n)));
}

async function cmdRemember(flags, words) {
  const text = words.join(" ").trim();
  if (!text) throw new Error("要记什么？");
  const { store } = make();
  const r = await store.writeEntry(
    {
      text,
      entity: flags.entity ?? "",
      type: flags.type ?? "fact",
      confidence: Number(flags.confidence) || 5,
    },
    { source: "manual", session: "", date: "" }
  );
  console.log(r.duplicate ? `已存在：${r.id}` : `已写入：${r.id}`);
}

async function cmdForget(args) {
  const id = args[0];
  if (!id) throw new Error("要给块 id");
  const { store } = make();
  await store.supersede(id);
  console.log(`已标为 superseded：${id}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { flags, rest } = parseArgs(args);
  switch (cmd) {
    case "init":
      return cmdInit(flags);
    case "status":
      return cmdStatus();
    case "once":
      return cmdOnce(flags);
    case "ingest":
      return cmdIngest(rest);
    case "ingest-log":
      return cmdIngestLog(flags, rest);
    case "search":
      return cmdSearch(flags, rest);
    case "review":
      return cmdReview(rest);
    case "remember":
      return cmdRemember(flags, rest);
    case "forget":
      return cmdForget(rest);
    case undefined:
    case "-h":
    case "--help":
      return void console.log(USAGE);
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`错误：${e.message}`);
  process.exitCode = 1;
});
