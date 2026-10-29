#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { CONFIG_PATH, INBOX_DIR, loadConfig, LOG_PATH } from "./config.mjs";
import { PROVIDERS, resolveModel, hasModel, probe as probeModel, saveModelChoice, maskKey, usageToday } from "./llm.mjs";
import { formatHits } from "./store.mjs";
import { normalizeTurns, toExchanges } from "./extract.mjs";
import { pending } from "./inbox.mjs";
import { readLog, readJsonLines, auditMessages, HARNESS_NAMES } from "./readers/index.mjs";
import { listSessions, summarize } from "./harness.mjs";
import { open, enqueueLog, processQueue } from "./jobs.mjs";
import { serve, acquire, release, lockInfo } from "./serve.mjs";
import { startUi } from "./ui.mjs";
import { install, uninstall, serviceStatus, systemdUnit, PLIST_PATH } from "./service.mjs";

const USAGE = `mem —— 把 harness 会话变成思源笔记里的记忆条目

  mem init [--force]           建笔记本和三个文档（幂等；--force 丢掉 id 缓存重解析）
  mem status                   连通性、条目数、队列长度、服务是否在跑
  mem once [--dry] [--no-model] 处理 inbox 里的全部会话（跑的期间占锁）
  mem serve [--once]           常驻：每轮找新会话 → 投队列 → 写思源
      [--interval 分钟] [--dry] [--no-model] [--force]
  mem ingest <file.json>       把一个会话文件投入队列（测试用）
  mem ingest-log <日志>        直接读 harness 的会话日志入队
  mem scan [--n 3] [--all]     列出本机各 harness 的会话（--all 逐个读一遍数轮数）
  mem audit [文件...]          逐块对账：收了多少字，丢了多少字，为什么丢
  mem search <词...>           查记忆，默认只看 current
  mem search --all <词...>     查记忆，含已过时的
  mem review [n]               列最近 n 条，人工扫一眼
  mem remember <文本> [--entity X] [--type decision|fact|preference|reference]
  mem forget <块id>            标成 superseded（不删）
  mem model                    看当前模型配置与今天的用量
  mem model use <provider> --key sk-...  [--name 模型名] [--wire openai|anthropic|gemini]
  mem model test               真发一次请求，自证 key / 地址 / JSON 模式都通
  mem ui [--port 7787]         起本地面板（只读；点"跑一轮"会自己抢锁）
  mem service [status]         看系统服务状态
  mem service install [--interval 分钟] [--print]   装成 launchd 服务
  mem service uninstall        卸载
  mem service unit             打印 systemd 单元（Linux 用，不落盘）

配置：${CONFIG_PATH}
队列：${INBOX_DIR}
服务日志：${LOG_PATH}
`;

/** 只有这几个键吃后面的值，其余 --xxx 一律当布尔，免得 "search --all 风盾" 把查询词吃掉。 */
const VALUED = new Set(["entity", "type", "confidence", "limit", "format", "n", "interval", "key", "name", "wire", "port"]);

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
  return open();
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
  const svc = lockInfo();
  const svcLine = svc.running
    ? `运行中 pid ${svc.pid}，第 ${svc.round ?? 0} 轮，心跳 ${new Date(svc.at ?? Date.now()).toLocaleTimeString("zh-CN", { hour12: false })}`
    : svc.pid
      ? `锁是孤的（pid ${svc.pid} 已经不在了，下次启动会自动接管）`
      : "未运行（mem serve 启动它）";
  console.log(`思源         ${cfg.siyuan.baseUrl}  v${version}`);
  console.log(`笔记本       ${cfg.siyuan.notebook}`);
  console.log(`条目         current ${stats.current ?? 0} / superseded ${stats.superseded ?? 0}`);
  const mm = resolveModel(cfg);
  console.log(`模型         ${hasModel(cfg) ? `${mm.provider} / ${mm.model}` : "未配置（走规则抽取）"}`);
  const u = usageToday();
  if (u.calls) console.log(`今日用量     ${u.calls} 次调用，输入 ${u.prompt} / 输出 ${u.completion} tokens${u.failed ? `，失败 ${u.failed}` : ""}`);
  console.log(`待处理       ${pending().length} 个会话在队列里`);
  console.log(`服务         ${svcLine}`);
}

async function cmdOnce(flags) {
  // 手动跑也占同一把锁：思源没有行级合并，两个进程同时写会整块覆盖。
  acquire({ log: console.log });
  try {
    const sum = await processQueue({
      dry: Boolean(flags.dry),
      useModel: !flags["no-model"],
      onLine: console.log,
    });
    if (!sum.sessions) {
      console.log("队列是空的。");
      return;
    }
    const tk = sum.tokens ? `，tokens 输入 ${sum.tokens.prompt} / 输出 ${sum.tokens.completion}` : "";
    console.log(`\n写入 ${sum.written}，跳过 ${sum.skipped}，失败 ${sum.failed}${tk}`);
    if (sum.degraded) console.log(`${sum.degraded} 个会话抽取不完整，原文留在队列里等重试。`);
    if (sum.failed) process.exitCode = 1;
  } finally {
    release();
  }
}

async function cmdServe(flags) {
  const minutes = Number(flags.interval);
  return serve({
    once: Boolean(flags.once),
    dry: Boolean(flags.dry),
    useModel: !flags["no-model"],
    force: Boolean(flags.force),
    intervalMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined,
  });
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

  const r = enqueueLog(file, { format: flags.format === true ? "" : flags.format ?? "" });
  if (!r.added) {
    if (r.reason === "subagent") console.log("这是子代理会话（归属于另一个会话），不进记忆。");
    else if (r.reason === "empty") console.log("这条日志里没有能用的问答。");
    else console.log(`${r.harness}  没有新内容（上次读到第 ${r.before} 轮）`);
    return;
  }
  const note = r.before ? `（跳过前 ${r.before} 轮已读过的）` : "";
  console.log(`${r.harness}  新增 ${r.added} 轮${note}  ${r.target}`);
}

function mb(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

function ago(ts) {
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return "今天";
  if (d === 1) return "昨天";
  return `${d} 天前`;
}

/** 读一个文件，返回轮数和字符数；读不了就说明原因。 */
function probe(file) {
  try {
    const log = readLog(file);
    const turns = normalizeTurns(log.turns);
    const ex = toExchanges(turns, 25);
    const chars = ex.reduce((n, e) => n + e.q.length + e.a.length, 0);
    return { harness: log.harness, turns: turns.length, exchanges: ex.length, chars };
  } catch (e) {
    return { error: e.message };
  }
}

async function cmdScan(flags) {
  const sessions = listSessions(flags.harness === true ? "" : flags.harness ?? "");
  if (!sessions.length) {
    console.log("一个会话都没找到。看看 ROOTS 里那几条路径对不对。");
    return;
  }
  const n = Number(flags.n ?? 3);
  for (const g of summarize(sessions)) {
    const rows = sessions.filter((s) => s.harness === g.harness);
    console.log(`\n${g.harness.padEnd(10)} ${String(g.count).padStart(3)} 个会话  ${mb(g.bytes).padStart(8)}  最新 ${ago(g.newest)}`);
    const pick = flags.all ? rows : rows.slice(0, n);
    for (const s of pick) {
      const r = probe(s.file);
      const name = s.file.replace(process.env.HOME, "~");
      if (r.error) {
        console.log(`  ✗ ${mb(s.size).padStart(7)}  ${name}`);
        console.log(`      ${r.error}`);
        continue;
      }
      // 格式名和目录名不一致，说明嗅探把这家认成了别家——这条要修。
      const mark = r.harness === s.harness ? "" : `  ← 嗅探成 ${r.harness}`;
      console.log(`  · ${mb(s.size).padStart(7)}  ${String(r.turns).padStart(5)} 轮  ${(r.chars / 1000).toFixed(0).padStart(5)}k 字  ${name}${mark}`);
    }
    if (!flags.all && rows.length > pick.length) console.log(`  …还有 ${rows.length - pick.length} 个（--all 全读）`);
  }
  console.log(`\n共 ${sessions.length} 个会话，${mb(sessions.reduce((n, s) => n + s.size, 0))}。`);
  console.log(`支持格式：${HARNESS_NAMES.join(" / ")}`);
}

/** 中文一个字占两列，直接 padEnd 会对不齐。 */
function padLabel(s, width) {
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(0, width - w));
}

const KINDS = [
  ["kept", "收入语料"],
  ["thinking", "思考块"],
  ["tool", "工具调用与结果"],
  ["injected", "注入与摘要"],
  ["other", "其它角色"],
];

function auditLine(file, harness = "") {
  const a = auditMessages(readJsonLines(file));
  const total = KINDS.reduce((n, [k]) => n + a[k], 0);
  const name = file.replace(process.env.HOME, "~");
  console.log(`\n${name}`);
  console.log(`  ${String(a.events).padStart(6)} 个事件   收进 ${a.keeps} 段`);
  for (const [k, label] of KINDS) {
    const pct = total ? ((a[k] / total) * 100).toFixed(1) : "0.0";
    console.log(`  ${padLabel(label, 16)} ${String(a[k]).padStart(10)} 字  ${pct.padStart(5)}%`);
  }
  console.log(`  ${padLabel("合计", 16)} ${String(total).padStart(10)} 字`);
  return { harness, ...a, total };
}

async function cmdAudit(flags, rest) {
  if (rest.length) {
    for (const f of rest) auditLine(f);
    return;
  }
  if (flags.all) {
    // 全量对账：把每个会话的五个分类加起来，看整体上多少进了语料。
    const byHarness = new Map();
    const blank = () => ({ kept: 0, thinking: 0, tool: 0, injected: 0, other: 0, events: 0, keeps: 0, files: 0 });
    for (const s of listSessions()) {
      const a = auditMessages(readJsonLines(s.file));
      const g = byHarness.get(s.harness) ?? blank();
      for (const k of ["kept", "thinking", "tool", "injected", "other", "events", "keeps"]) g[k] += a[k];
      g.files++;
      byHarness.set(s.harness, g);
    }
    console.log("全部会话逐块对账：\n");
    console.log("harness      会话   收进语料      思考块       工具结果      注入摘要      其它    收录占比");
    const tot = blank();
    for (const [h, g] of [...byHarness].sort((a, b) => b[1].kept - a[1].kept)) {
      const sum = g.kept + g.thinking + g.tool + g.injected + g.other;
      const pct = sum ? ((g.kept / sum) * 100).toFixed(1) + "%" : "-";
      const f = (n) => `${(n / 10000).toFixed(0)}万`.padStart(8);
      console.log(`${h.padEnd(10)} ${String(g.files).padStart(4)} ${f(g.kept)} ${f(g.thinking)} ${f(g.tool)} ${f(g.injected)} ${f(g.other)} ${pct.padStart(8)}`);
      for (const k of Object.keys(tot)) tot[k] += g[k];
    }
    const sum = tot.kept + tot.thinking + tot.tool + tot.injected + tot.other;
    const f = (n) => `${(n / 10000).toFixed(0)}万`.padStart(8);
    console.log(`${"合计".padEnd(10)} ${String(tot.files).padStart(4)} ${f(tot.kept)} ${f(tot.thinking)} ${f(tot.tool)} ${f(tot.injected)} ${f(tot.other)} ${(((tot.kept / sum) * 100).toFixed(1) + "%").padStart(8)}`);
    console.log(`\n共 ${((sum) / 10000).toFixed(0)} 万字，收进语料 ${((tot.kept) / 10000).toFixed(0)} 万字、${tot.keeps} 段。`);
    return;
  }
  // 不带参数：每家挑最大的一个会话对账
  const sessions = listSessions();
  const biggest = new Map();
  for (const s of sessions) {
    const cur = biggest.get(s.harness);
    if (!cur || s.size > cur.size) biggest.set(s.harness, s);
  }
  console.log("每家取最大的一个会话：");
  const rows = [];
  for (const [harness, s] of biggest) rows.push(auditLine(s.file, harness));
  console.log("\n=== 汇总（各取一个样本，不代表整体）===");
  for (const r of rows.sort((a, b) => b.total - a.total)) {
    const pct = ((r.kept / r.total) * 100).toFixed(1);
    console.log(`${r.harness.padEnd(10)} 收 ${String(r.kept).padStart(9)} / 共 ${String(r.total).padStart(9)} 字 = ${pct}%`);
  }
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

async function cmdModel(args, flags) {
  const sub = args[0];
  const cfg = loadConfig();

  if (!sub) {
    const m = resolveModel(cfg);
    const u = usageToday();
    console.log(`provider     ${m.provider}（协议 ${m.wire}）`);
    console.log(`baseUrl      ${m.baseUrl || "（未配置）"}`);
    console.log(`模型         ${m.model || "（未配置）"}`);
    console.log(`key          ${maskKey(m.apiKey)}`);
    console.log(`JSON 模式    ${m.jsonMode ? "开" : "关"}`);
    console.log(`今日用量     ${u.calls ? `${u.calls} 次，输入 ${u.prompt} / 输出 ${u.completion} tokens` : "还没有调用"}`);
    console.log(`\n可选 provider：${Object.keys(PROVIDERS).join(", ")}`);
    console.log(`协议三选一：openai / anthropic / gemini（自定义端点用 model.wire 指定）`);
    return;
  }

  if (sub === "use") {
    const provider = args[1];
    if (!provider) throw new Error(`要指定一家：${Object.keys(PROVIDERS).join(", ")}`);
    const m = saveModelChoice(provider, { apiKey: flags.key, model: flags.name, wire: flags.wire });
    console.log(`已写入 ${CONFIG_PATH}`);
    console.log(`  ${m.provider} / ${m.model}  协议 ${m.wire}  key ${maskKey(m.apiKey)}  JSON ${m.jsonMode ? "开" : "关"}`);
    console.log("  下一步：mem model test");
    return;
  }

  if (sub === "test") {
    if (!hasModel(cfg)) throw new Error("还没配 key：mem model use deepseek --key sk-...");
    const r = await probeModel(cfg);
    console.log(`通了：${r.provider} / ${r.model}（${r.wire}）  ${r.ms}ms  ${r.attempts} 次尝试`);
    console.log(`  tokens 输入 ${r.usage.prompt} / 输出 ${r.usage.completion}  JSON 模式 ${r.jsonOk ? "生效" : "没生效（退回提示词约束）"}`);
    console.log(`  回包：${r.sample}`);
    return;
  }

  throw new Error(`不认识的子命令：${sub}（可用：use / test）`);
}

async function cmdService(args, flags) {
  const sub = args[0] ?? "status";
  if (sub === "status") {
    const s = serviceStatus();
    console.log(`plist        ${PLIST_PATH}${s.installed ? "" : "（不存在）"}`);
    console.log(`服务         ${s.running ? `运行中 pid ${s.pid}` : s.state ?? "未运行"}`);
    if (s.note) console.log(`备注         ${s.note}`);
    const svc = lockInfo();
    if (svc.running) console.log(`内部心跳     pid ${svc.pid}，第 ${svc.round ?? 0} 轮`);
    // 服务"装了但没跑"最常见的原因是配置问题，把日志最后一行贴出来，省得再去找文件。
    const last = (() => {
      try {
        const lines = readFileSync(LOG_PATH, "utf8").trimEnd().split("\n");
        return lines[lines.length - 1] ?? "";
      } catch {
        return "";
      }
    })();
    if (last) console.log(`最近日志     ${last}`);
    return;
  }
  if (sub === "install") {
    const minutes = Number(flags.interval) || 0;
    const r = install({ intervalMinutes: minutes, print: Boolean(flags.print) });
    if (flags.print) return void console.log(r.plist);
    console.log(`已写入 ${r.path}`);
    console.log(minutes ? `  每 ${minutes} 分钟跑一次（StartInterval）` : "  常驻（KeepAlive，崩溃后 30 秒重试）");
    if (r.loaded) {
      console.log("  已装载。看状态：mem service status");
    } else {
      console.log(`  但装载失败：${r.error}`);
      console.log(`  ${r.hint}`);
      process.exitCode = 1;
    }
    return;
  }
  if (sub === "uninstall") {
    const r = uninstall();
    console.log(`已卸载，plist ${r.path} 已删除`);
    return;
  }
  if (sub === "unit") {
    return void console.log(systemdUnit({ intervalMinutes: Number(flags.interval) || 0 }));
  }
  throw new Error(`不认识的子命令：${sub}（可用：status / install / uninstall / unit）`);
}

async function cmdUi(flags) {
  const cfg = loadConfig();
  const port = Number(flags.port) || cfg.ui?.port || 7787;
  // 面板本身只读；点"跑一轮"时才抢锁，抢不到就报"服务正在跑"。
  const runRound = async (logFn) => {
    acquire({ log: logFn ?? console.log });
    try {
      return await processQueue({ useModel: !flags["no-model"] });
    } finally {
      release();
    }
  };
  const ui = startUi({ port, runRound });
  console.log(`面板 ${ui.url}（Ctrl-C 退出）`);
  const stop = async () => {
    await ui.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
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
    case "serve":
      return cmdServe(flags);
    case "ingest":
      return cmdIngest(rest);
    case "ingest-log":
      return cmdIngestLog(flags, rest);
    case "scan":
      return cmdScan(flags);
    case "audit":
      return cmdAudit(flags, rest);
    case "search":
      return cmdSearch(flags, rest);
    case "review":
      return cmdReview(rest);
    case "remember":
      return cmdRemember(flags, rest);
    case "forget":
      return cmdForget(rest);
    case "model":
      return cmdModel(rest, flags);
    case "ui":
      return cmdUi(flags);
    case "service":
      return cmdService(rest, flags);
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
