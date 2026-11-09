#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { CONFIG_PATH, INBOX_DIR, loadConfig, LOG_PATH, machineId, saveConfig, offsetsOf, loadOffsets } from "../util/config.mjs";
import { PROVIDERS, resolveModel, hasModel, probe as probeModel, saveModelChoice, maskKey, usageToday } from "../util/llm.mjs";
import { formatHits, ATTR } from "../core/store.mjs";
import { parseArgs } from "../util/args.mjs";
import { loadRawIndex, readRange, parsePtr } from "../util/raw.mjs";
import { loadEntities, addEntity, mergeEntities, applyPending, shotList } from "../core/entities.mjs";
import { print as printDigest } from "../core/digest.mjs";
import { writeEntities } from "../core/entity-view.mjs";
import { readDays, stats as logStats, dayOf } from "../util/log.mjs";
import { normalizeTurns, promptState, toExchanges } from "../core/extract.mjs";
import { drop, pending, readSession } from "../core/inbox.mjs";
import { searchEntries } from "../core/search.mjs";
import { remoteSearch } from "../util/remote.mjs";
import { readLog, readJsonLines, auditMessages, HARNESS_NAMES } from "../util/readers/index.mjs";
import { listSessions, summarize } from "../util/harness.mjs";
import { open, enqueueLog, processQueue } from "../core/jobs.mjs";
import { serve, acquire, release, lockInfo } from "../core/serve.mjs";
import { startUi } from "../core/ui.mjs";
import { install, uninstall, serviceStatus, systemdUnit, PLIST_PATH, PLIST_PUSH_PATH } from "./service.mjs";
import { pushOnce, pushWatch, pingPush } from "./push.mjs";
import { startMcp } from "../mcp/server.mjs";
import { checkPrompt, history as promptHistory, PROMPT_PATH, resetPrompt, restore, savePrompt } from "../core/prompt.mjs";

const USAGE = `mem —— 把 harness 会话变成思源笔记里的记忆条目

采集与抽取
  mem init [--force] [--rebind]   建笔记本和文档（幂等；--rebind 接受笔记本被删了重建）
  mem status                      连通性、条目数、队列长度、服务是否在跑
  mem serve [--once] [--interval 分钟] [--dry] [--no-model] [--force]
                                  常驻：每轮找新会话 → 投队列 → 写思源
  mem once [--dry] [--no-model]   只跑一轮（处理完 inbox 就退）
  mem scan [--n 3] [--all]        列出本机各 harness 的会话
  mem audit [文件...]             逐块对账：收了多少字、丢了多少、为什么丢
  mem digest                      按会话分组打印记忆（给人读，不写库）
  mem raw list [会话id]           看原文归档了哪些 part

检索
  mem search <词...>              默认只看 current（--limit --topic --project --type --days --json）
  mem search --all <词...>        连已过时的也查
  mem search --to URL <词...>     从中心查（边缘机器用，token 取 push.token 或 --token）
  mem review [n]                  列最近 n 条，人工扫一眼
  mem show <块id> [--chars N]     回读这条结论对应的原文
  mem mcp [--to URL] [--token T]  起 MCP server（stdio），给 harness 调召回

实体
  mem entity [list [词]]          看实体表
  mem entity add <名> [--alias "别名1|别名2"]
  mem entity merge <旧名> <新名>  合并并回填条目（纯机械，不调模型）
  mem entity review [--dry]       执行 03-实体待确认 里勾选的项
  mem entity reindex              重建 02-实体

手工
  mem remember <文本> [--entity X] [--type decision|fact|preference|reference]
  mem forget <块id>               标成 superseded（不删）

模型与提示词
  mem model                       当前配置与今日用量
  mem model use <provider> [--key …] [--name …] [--wire openai|anthropic|gemini] [--base URL]
  mem model test                  真发一次请求，自证 key / 地址 / JSON 模式都通
  mem model list                  列内置的十家
  mem prompt [show|set <文件>|reset|history|restore <版本>]
                                  看/改抽取提示词；set 会先备份旧版，传 - 读标准输入

中心与边缘
  mem center [status]             看接收端
  mem center setup [--port 7788] [--bind 0.0.0.0] [--rotate]
                                  把本机设成中心，生成 token，打印边缘命令
  mem push [--to URL] [--token T] [--once|--watch] [--dry] [--all] [--from-scratch] [--test]
                                  把本机会话推给中心（默认只推安静 3 分钟的）

运维
  mem service [status|install|uninstall|unit] [--push]
                                  装/卸常驻服务：默认中心 serve，--push 是边缘推送
  mem log [stats|tail|grep]       结构化事件日志
  mem ui [--port 7787]            起本地只读面板

配置：${CONFIG_PATH}
队列：${INBOX_DIR}
服务日志：${LOG_PATH}
`;

/** 只有这几个键吃后面的值，其余 --xxx 一律当布尔，免得 "search --all 风盾" 把查询词吃掉。 */
function make() {
  return open();
}

async function cmdInit(flags) {
  const { store } = make();
  // --force  只解析不新建（文档层面）
  // --rebind 接受笔记本 id 变了（删了重建），并把配置指到新的那本
  const ids = await store.init({ force: Boolean(flags.force), rebind: Boolean(flags.rebind) });
  console.log("笔记本与文档就绪：");
  for (const [k, v] of Object.entries(ids)) {
    // months 是一组按月分的文档（{ "2026-11": id }），直接打印会变成 [object Object]。
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      console.log(`  ${k.padEnd(8)} ${keys.length} 个：${keys.slice(0, 3).join(" ")}${keys.length > 3 ? " …" : ""}`);
    } else {
      console.log(`  ${k.padEnd(8)} ${v}`);
    }
  }
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
  if (u.calls) {
    const cache = u.cached ? `（缓存命中 ${u.cached}）` : "";
    console.log(`今日用量     ${u.calls} 次调用，输入 ${u.prompt}${cache} / 输出 ${u.completion} tokens${u.failed ? `，失败 ${u.failed}` : ""}`);
  }
  console.log(`待处理       ${pending().length} 个会话在队列里`);
  console.log(`服务         ${svcLine}`);
  console.log(`本机         ${machineId()}`);
  const ing = cfg.ingest ?? {};
  console.log(
    `接收端       ${ing.enabled ? `${ing.bind}:${ing.port}${ing.token ? "" : "（无 token，只接受本机）"}` : "关（mem center setup 打开）"}`
  );
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
  const r = drop(payload);
  console.log(r.duplicate ? `队列里已经有了：${r.file}` : `已入队：${r.file}`);
}

async function cmdIngestLog(flags, args) {
  const file = args[0];
  if (!file) throw new Error("要给一个日志文件路径");

  // 默认跳过还在写的会话（3 分钟内改过），--force 强投。
  const r = enqueueLog(file, {
    format: flags.format === true ? "" : flags.format ?? "",
    // 0 是合法值（"不用等"），不能用 || 兜底——那会把 0 变成 180。
    // 传了但不是数字，就当参数错误——静默跳过安静检查比"报错"危险得多。
    quietSeconds: flags.force
      ? 0
      : flags.quiet === undefined
        ? 180
        : Number.isFinite(Number(flags.quiet))
          ? Number(flags.quiet)
          : (() => {
              throw new Error(`--quiet 要一个秒数，收到「${flags.quiet}」`);
            })(),
  });
  if (!r.added) {
    if (r.reason === "subagent") console.log("这是子代理会话（归属于另一个会话），不进记忆。");
    else if (r.reason === "empty") console.log("这条日志里没有能用的问答。");
    else if (r.reason === "active")
      console.log(`这条会话还在写（${r.quietSeconds} 秒内改过），先不动。加 --force 强投。`);
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
    { source: "manual", session: "", date: "", project: flags.project ?? "" }
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

async function cmdPrompt(args, flags = {}) {
  const sub = args[0] ?? "status";
  const st = promptState();

  if (sub === "status") {
    console.log(`来源      ${st.source === "user" ? PROMPT_PATH : "内置（没覆盖）"}`);
    console.log(`版本      ${st.version}    ${st.text.length} 字`);
    // 体检不是拒绝，是提醒：提示词坏掉从不报错，只让抽出来的东西悄悄变差。
    for (const w of st.warnings) console.log(`  ⚠ ${w}`);
    console.log("\n看全文 mem prompt show；改：mem prompt show > /tmp/p.md，编辑完 mem prompt set /tmp/p.md");
    return;
  }
  if (sub === "show") {
    process.stdout.write(`${st.text}\n`);
    return;
  }
  if (sub === "set") {
    const file = args[1];
    if (!file) throw new Error("用法：mem prompt set <文件>（传 - 从标准输入读）");
    const text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
    // 缺 json 字样是硬伤：火山等端点在 json_object 模式下直接 400，整批失败。
    // 其余体检项只提醒——有人就是要写短一点，不该拦。
    const warns = checkPrompt(text);
    if (warns.some((w) => /json/.test(w)) && !flags.force) {
      throw new Error(`${warns.join("\n")}\n\n确认要这样存，加 --force。`);
    }
    const r = savePrompt(text);
    const after = promptState();
    console.log(`已写入 ${r.path}`);
    if (r.backup) console.log(`旧版备份 ${r.backup}`);
    console.log(`版本 ${after.version}，${after.text.length} 字`);
    for (const w of after.warnings) console.log(`  ⚠ ${w}`);
    return;
  }
  if (sub === "reset") {
    const r = resetPrompt();
    if (!r.removed) return void console.log("本来就没有覆盖，现在用的就是内置那份。");
    console.log(`已删除覆盖，回到内置（备份 ${r.backup}）`);
    return;
  }
  if (sub === "restore") {
    const name = args[1];
    if (!name) throw new Error("用法：mem prompt restore <版本文件名>（mem prompt history 看有哪些）");
    const r = restore(name);
    console.log(`已还原到 ${name}\n当前版本备份在 ${r.backup || "（无）"}`);
    return;
  }
  if (sub === "history") {
    const h = promptHistory();
    console.log(h.length ? h.join("\n") : "还没有历史版本（只在你 set/reset 过之后才会有）");
    return;
  }
  throw new Error(`不认识的子命令：${sub}（可用：show / set / restore / reset / history）`);
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
    const fromEnv = m.apiKeyFrom && m.apiKeyFrom !== "config";
    console.log(
      `key          ${
        fromEnv ? `${maskKey(m.apiKey)}  ← 环境变量 ${m.apiKeyFrom}（配置文件里没有）` : m.apiKey ? `${maskKey(m.apiKey)}  ← 配置文件` : "（未配置）"
      }`
    );
    console.log(`JSON 模式    ${m.jsonMode ? "开" : "关"}`);
    console.log(`今日用量     ${u.calls ? `${u.calls} 次，输入 ${u.prompt}${u.cached ? `（缓存 ${u.cached}）` : ""} / 输出 ${u.completion} tokens` : "还没有调用"}`);
    console.log(`\n可选 provider：${Object.keys(PROVIDERS).join(", ")}`);
    console.log(`协议三选一：openai / anthropic / gemini（自定义端点用 model.wire 指定）`);
    return;
  }

  if (sub === "use") {
    const provider = args[1];
    if (!provider) throw new Error(`要指定一家：${Object.keys(PROVIDERS).join(", ")}`);
    const written = saveModelChoice(provider, { apiKey: flags.key, model: flags.name, wire: flags.wire, base: flags.base });
    // 用 resolveModel 重新解析一遍再打印：saveModelChoice 只写了部分字段，
    // 直接拿它打印会和 `mem model` 显示的不一致（jsonMode、key 来源都会打架）。
    const m = resolveModel({ model: written });
    console.log(`已写入 ${CONFIG_PATH}`);
    console.log(
      `  ${m.provider} / ${m.model}  协议 ${m.wire}  ` +
        `key ${m.apiKey ? maskKey(m.apiKey) : m.apiKeyFrom ? `从环境变量 ${m.apiKeyFrom} 读` : "（未配置）"}`
    );
    console.log("  下一步：mem model test");
    return;
  }

  if (sub === "list") {
    // models.dev 那份目录已经删掉了：5.6MB 的 JSON，解析进内存要 50MB，换来的只是
    // 「provider 不在预设里时自动找 baseUrl」——一年用不到一次。现在只认下面这十家
    // 和显式的 --base。要加一家，往 PROVIDERS 里补一行，比联网拉目录可靠。
    // 后面跟一个词就只列匹配的（原来参数被忽略，`mem model list qwen` 照样列十家）。
    const needle = String(args[1] ?? "").toLowerCase();
    const rows = Object.entries(PROVIDERS).filter(([id, p]) =>
      !needle || id.includes(needle) || String(p.model).toLowerCase().includes(needle) || String(p.wire).includes(needle)
    );
    if (!rows.length) {
      console.log(`没有匹配「${args[1]}」的预设。内置：${Object.keys(PROVIDERS).join(" / ")}`);
      return;
    }
    for (const [id, p] of rows) {
      console.log(`  ${id.padEnd(12)} ${String(p.wire).padEnd(9)} ${String(p.model).padEnd(28)} ${p.baseUrl}`);
    }
    console.log("\n用法：mem model use <id> --name <模型>；别家的端点直接写 --base <baseUrl> --wire <协议>");
    return;
  }

  if (sub === "test") {
    if (!hasModel(cfg)) {
      throw new Error(
        "还没有可用的 key。两条路：\n" +
          "  · 写进配置：mem model use <provider> --key sk-...（文件权限 0600）\n" +
          "  · 只放环境变量：export ARK_API_KEY=... 然后 mem model use volcengine --name <模型>（配置里不落明文）"
      );
    }
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
  // 边缘机器上只有 push，没有 serve。所以两个服务共用一套命令，靠 --push 区分。
  const mode = flags.push ? "push" : "serve";
  const what = mode === "push" ? "推送（edge）" : "中心（serve）";
  if (sub === "status") {
    if (flags.push) {
      const s = serviceStatus("push");
      console.log(`服务         ${what}`);
      console.log(`plist        ${PLIST_PUSH_PATH}${s.installed ? "" : "（不存在）"}`);
      console.log(`状态         ${s.running ? `运行中 pid ${s.pid}` : s.state ?? "未运行"}`);
      if (s.note) console.log(`备注         ${s.note}`);
      const cfg = loadConfig();
      const to = cfg.push?.to ?? "";
      console.log(`中心地址     ${to || "（没配：mem push --to … --save）"}`);
      console.log(`token        ${cfg.push?.token ? "已配" : "（没配）"}`);
      return;
    }
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
    if (mode === "push") {
      const cfg = loadConfig();
      if (flags.interval !== undefined) {
        throw new Error("--push 没有 --interval：边缘是常驻进程（活跃 15 分钟一轮，空转退到 60），改节奏去配 push.intervalSeconds");
      }
      const r = install({ mode: "push", print: Boolean(flags.print) });
      if (!flags.print && !cfg.push?.to) {
        throw new Error("先记住中心地址：mem push --to https://… --token … --save");
      }
      if (flags.print) return void console.log(r.plist);
      console.log(`已写入 ${r.path}`);
      const every = Math.round((Number(cfg.push?.intervalSeconds) || 900) / 60);
      const ceiling = Math.round((Number(cfg.push?.maxIntervalSeconds) || 3600) / 60);
      console.log(`  常驻推送 → ${cfg.push.to}（活跃 ${every} 分钟一轮，空转退到 ${ceiling} 分钟，崩溃后 30 秒重试）`);
      console.log(r.loaded ? "  已装载。看状态：mem service status --push" : `  但装载失败：${r.error}\n  ${r.hint}`);
      if (!r.loaded) process.exitCode = 1;
      return;
    }
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
    const r = uninstall(mode);
    console.log(`已卸载${what}，plist ${r.path} 已删除`);
    return;
  }
  if (sub === "unit") {
    return void console.log(systemdUnit({ intervalMinutes: Number(flags.interval) || 0, mode }));
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

/** 本机的非回环 IPv4，用来拼给边缘机器复制的那条命令。 */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

async function cmdCenter(args, flags) {
  const sub = args[0] ?? "status";
  const cfg = loadConfig();
  const ing = cfg.ingest ?? {};

  if (sub === "status") {
    console.log(`本机         ${machineId()}`);
    console.log(`接收端       ${ing.enabled ? `${ing.bind}:${ing.port}` : "关（mem center setup 打开）"}`);
    console.log(`token        ${ing.token ? maskKey(ing.token) : "（没配）"}`);
    console.log(`队列         ${pending().length} 个会话待处理`);
    if (ing.enabled) {
      // 真去敲一下端口。只念配置的话，"配置开着但进程没起"和"一切正常"长得一模一样。
      const probeHost = ing.bind === "0.0.0.0" ? "127.0.0.1" : ing.bind;
      try {
        // 非回环地址上用 https 前缀意味着中间有反代（证书在那边），明文 token
        // 不该直接发到公网；这里只探本机/回环，规则写死成 http。
        const scheme = /^(127\.|localhost$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(probeHost)
          ? "http"
          : "https";
        const r = await fetch(`${scheme}://${probeHost}:${ing.port}/api/ping`, {
          headers: ing.token ? { authorization: `Bearer ${ing.token}` } : {},
          signal: AbortSignal.timeout(3000),
        });
        const j = await r.json().catch(() => ({}));
        // 端口被别的服务占着时也会 200，得认一下对面是不是 mem。
        const isMem = j?.name === "siyuan-mem";
        console.log(
          `监听         ${!r.ok ? `有应答但被拒（HTTP ${r.status}）` : isMem ? "有应答" : "有应答但不是 mem（端口被别的服务占了？）"}` +
            (isMem && j.queue != null ? `，中心队列 ${j.queue} 个` : "")
        );
      } catch (e) {
        console.log(`监听         没应答（${e.name === "TimeoutError" ? "3 秒超时" : e.message}）`);
      }
      const host = ing.bind === "0.0.0.0" ? lanAddresses()[0] ?? "<这台机器的地址>" : ing.bind;
      console.log(`\n边缘机器上跑：\n  mem push --to http://${host}:${ing.port} --token ${ing.token || "<token>"} --once`);
      console.log("  （公网走反向代理时把 http://… 换成 https://你的域名）");
    }
    return;
  }

  if (sub === "setup") {
    const port = Number(flags.port) || ing.port || 7788;
    // 开接收端就意味着要跨机器访问，bind 默认从回环改成全部网卡；
    // 但如果用户显式给了 --bind，就按他说的来。
    const bind = flags.bind ?? (ing.bind === "127.0.0.1" ? "0.0.0.0" : ing.bind);
    const token = flags.rotate || !ing.token ? randomBytes(18).toString("base64url") : ing.token;
    saveConfig({ ingest: { enabled: true, bind, port, token } });
    const host = bind === "0.0.0.0" ? lanAddresses()[0] ?? "<这台机器的地址>" : bind;
    console.log(`已写入 ${CONFIG_PATH}`);
    console.log(`  接收端 ${bind}:${port}  token ${maskKey(token)}`);
    console.log(`  重启 mem serve 生效：mem service install（或 kill 掉再起）`);
    console.log(`\n在边缘机器上：`);
    console.log(`  mem push --to http://${host}:${port} --token ${token} --once`);
    console.log(`\n提醒：这是写入通道。公网暴露请走 HTTPS 反向代理，并把 token 当密码对待。`);
    return;
  }

  throw new Error(`不认识的子命令：${sub}（可用：status / setup）`);
}

async function cmdPush(flags, args) {
  const cfg = loadConfig();
  const to = flags.to ?? cfg.push?.to ?? "";
  const token = flags.token ?? cfg.push?.token ?? "";
  const machine = flags.machine ?? machineId();

  if (flags.save && (flags.to || flags.token)) {
    saveConfig({ push: { ...(flags.to ? { to: flags.to } : {}), ...(flags.token ? { token: flags.token } : {}), ...(flags.machine ? { machine: flags.machine } : {}) } });
    console.log(`已写入 ${CONFIG_PATH}`);
  }
  if (!to) throw new Error("没有中心地址：mem push --to http://中心:7788 --token …（加 --save 记住）");

  if (flags.test) {
    const r = await pingPush({ to, token });
    // 走到这里说明 ping 和 probe 都过了——两个接口都要 token，所以不用再猜「服务端设没设」。
    console.log(`通了：${to}  队列 ${r.queue} 个  token 有效`);
    return;
  }

  const opts = {
    to,
    token,
    machine,
    dry: Boolean(flags.dry),
    limit: flags.all ? Number.POSITIVE_INFINITY : Number(flags.limit) || 8,
    // 0 是合法值（用完就推），所以不能用 || 兜底
    quietSeconds: flags.quiet !== undefined ? Number(flags.quiet) : cfg.push?.quietSeconds ?? 180,
    maxChars: cfg.push?.maxCharsPerRequest ?? 800_000,
    // 本机的推送进度对"另一个中心"没有意义：换中心时要全量重推，重复的由中心挡。
    fromScratch: Boolean(flags["from-scratch"]),
    log: console.log,
  };

  if (flags.watch || flags.every) {
    await pushWatch({ ...opts, intervalSeconds: Number(flags.every) || cfg.push?.intervalSeconds || 300 });
    return;
  }

  const r = await pushOnce(opts);
  console.log(
    `扫描 ${r.scanned} 个会话，推送 ${r.sessions} 个 / ${r.turns} 轮 / ${r.chars} 字，` +
      `重复 ${r.duplicates} 包，跳过 ${r.skipped}，失败 ${r.failed}` +
      (r.left ? `，还有 ${r.left} 个下次继续（--all 一次推完）` : "")
  );
}

/** 从 ial 里抠某个属性值。ial 是 `{: custom-mem-x="y"}` 这种字符串。 */
function attrOf(ial, key) {
  return new RegExp(`${key}="([^"]*)"`).exec(ial ?? "")?.[1] ?? "";
}

async function cmdDigest() {
  const { sy, store } = make();
  const ids = await store.docIds();
  await printDigest({ sy, ids, out: (s) => console.log(s) });
}

async function cmdShow(args, flags) {
  const id = args[0];
  if (!id) throw new Error("要一个条目块 id：mem review 里能看到");
  const { sy } = make();

  const rows = await sy.sql(`SELECT content, ial FROM blocks WHERE id='${id.replace(/'/g, "''")}' LIMIT 1`);
  const row = rows?.[0];
  if (!row) throw new Error(`找不到块 ${id}`);

  const entity = attrOf(row.ial, ATTR.entity);
  const status = attrOf(row.ial, ATTR.status);
  const ptr = attrOf(row.ial, ATTR.raw);
  const text = String(row.content ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();

  console.log(`[${entity || "-"}] ${text}`);
  console.log(`状态 ${status || "-"}   块 ${id}`);
  if (!ptr) {
    console.log("\n这条没有原文指针：归档功能上线前写的，或者当时归档失败。");
    return;
  }

  const p = parsePtr(ptr);
  console.log(`原文 ${ptr}`);
  if (p?.from != null) console.log(`第 ${p.from}–${p.to} 轮`);

  const r = await readRange(sy, ptr, { maxChars: Number(flags.chars) || 8000 });
  if (r.missing) {
    console.log(`\n原文已失效：附件 ${p?.path} 不在了（被清理或手动删了）。`);
    return;
  }
  if (r.error) throw new Error(r.error);
  if (!r.turns.length) {
    console.log("\n指针那一段没读到内容：附件在，但轮次对不上。可能是日志被重写过。");
    return;
  }

  console.log("");
  for (const t of r.turns) {
    const who = t.role === "user" ? "用户" : "助手";
    console.log(`── 第 ${t.i} 轮 · ${who} ${"─".repeat(Math.max(0, 30))}`);
    console.log(t.text.trim());
    console.log("");
  }
  if (r.truncated) {
    console.log(`（这一段共 ${r.total} 轮，到字数上限截住了；加 --chars 80000 看全）`);
  }
}

/**
 * 看原文归档到了哪些 part。
 *
 * 数据源是本地 raw-index.json，不是思源里的块：原文本身是附件，索引是我们自己的
 * 账本。以前这里查的是一批早就不写的 raw-part 块，所以这个命令一直"没有归档过原文"。
 */
async function cmdRaw(args) {
  const sub = args[0] ?? "list";
  if (sub !== "list") throw new Error(`不认识的子命令：${sub}（可用：list）`);
  const session = args[1] ?? "";

  const idx = loadRawIndex();
  // 键是 machine|harness|session，拆回来才是人要看的三段。
  const rows = Object.entries(idx)
    .map(([key, parts]) => {
      const [machine, harness, ...rest] = key.split("|");
      return { machine, harness, session: rest.join("|"), parts: Array.isArray(parts) ? parts : [] };
    })
    .filter((r) => r.parts.length)
    .filter((r) => !session || r.session.includes(session))
    .sort((a, b) => a.session.localeCompare(b.session));

  if (!rows.length) {
    console.log(session ? `会话 ${session} 没有归档过原文` : "还没有归档过原文");
    return;
  }

  const total = rows.reduce((n, r) => n + r.parts.length, 0);
  console.log(`${total} 个 part，${rows.length} 个会话\n`);
  for (const r of rows) {
    console.log(`${r.session.slice(0, 26)}  ${r.machine}/${r.harness}  ${r.parts.length} 段`);
    for (const p of r.parts) {
      const range = `${p.from ?? "?"}-${p.to ?? "?"}`.padEnd(10);
      console.log(`  ${range} ${(p.path ?? "").replace(/^.*\/assets\//, "assets/")}`);
    }
  }
}

async function cmdEntity(args, flags) {
  const sub = args[0] ?? "list";
  const { sy, cfg, store } = make();
  const ids = await store.docIds();

  if (sub === "list") {
    const q = String(args[1] ?? "").toLowerCase();
    const table = loadEntities();
    const rows = table.filter(
      (e) => !q || e.name.toLowerCase().includes(q) || e.aliases.some((a) => a.toLowerCase().includes(q))
    );
    if (!rows.length) {
      console.log(q ? `没有匹配「${q}」的实体` : "实体表还是空的（第一次抽取时会自己建）");
      return;
    }
    console.log(`${rows.length} 个实体（共 ${table.length}）\n`);
    for (const e of rows) {
      const alias = e.aliases.length ? `  别名：${e.aliases.join("、")}` : "";
      const merged = e.status === "merged" ? `  [已并入 ${e.mergedInto}]` : "";
      console.log(`  ${e.name}${alias}${merged}`);
    }
    return;
  }

  if (sub === "add") {
    const name = args[1];
    if (!name) throw new Error("要一个名字：mem entity add 风盾500 --alias \"风盾 500|京造风盾500\"");
    const aliases = String(flags.alias ?? "")
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    const before = loadEntities();
    if (before.some((e) => e.name === name)) throw new Error(`已经有了：${name}（要加别名用 mem entity merge）`);
    addEntity(name, { aliases, source: "manual" });
    console.log(`已建实体「${name}」${aliases.length ? `，别名 ${aliases.join("、")}` : ""}`);
    return;
  }

  if (sub === "merge") {
    const [from, into] = args.slice(1);
    if (!from || !into) throw new Error("mem entity merge <旧名> <新名>");
    const r = await mergeEntities(sy, from, into, { log: console.log, box: ids.notebook });
    console.log(`已合并：${from} → ${into}，回填 ${r.changed} 条`);
    if (r.aliases?.length) console.log(`  现在的别名：${r.aliases.join("、")}`);
    return;
  }

  if (sub === "reindex") {
    const r = await writeEntities({ sy, ids, log: console.log });
    console.log(`已重建 02-实体：${r.groups} 个话题 / ${r.total} 条`);
    return;
  }

  if (sub === "review") {
    const r = await applyPending({ sy, cfg, ids, dry: Boolean(flags.dry), log: console.log });
    const s = r.stat;
    if (!s.todo && !s.merged && !s.rejected && !s.failed) {
      console.log("03-实体待确认 里没有待办。");
      return;
    }
    for (const m of r.merged) console.log(`  合并 ${m.a} → ${m.b}${flags.dry ? "（dry）" : ""}`);
    for (const x of r.rejected) console.log(`  否定 ${x.a} ← ${x.b}${flags.dry ? "（dry）" : ""}`);
    console.log(
      `\n待确认 ${s.todo}，合并 ${s.merged}，否定 ${s.rejected}${s.failed ? `，失败 ${s.failed}` : ""}${flags.dry ? "（dry，没写）" : ""}`
    );
    return;
  }

  throw new Error(`不认识的子命令：${sub}（可用：list / add / merge / review / reindex）`);
}

/**
 * 结构化事件日志的查看入口。
 *
 * 三件事：
 *   stats  一周的汇总：写了多少、拦了多少、错了多少次、条目多长、用的哪个 prompt
 *   tail   最近 N 条原始事件，按行打
 *   grep   在字段里搜（会话 id、话题、错误信息都行）
 *
 * 为什么不用 grep 直接翻 jsonl：一行一个 JSON，人眼找字段很费劲，
 * 而且想看的往往是"这个会话到底被判重判成了什么"，要跨事件拼。
 */
async function cmdLog(args, flags) {
  const sub = args[0] ?? "stats";

  if (sub === "stats") {
    const days = Number(flags.days ?? 7);
    const s = logStats({ days });
    if (!s.events) {
      console.log(`最近 ${days} 天没有事件。服务没跑过，或者日志被清了。`);
      return;
    }
    console.log(`最近 ${days} 天：${s.events} 条事件，${s.sessions} 个会话`);
    console.log(`  写入 ${s.written} 条 | 跳过 ${s.skipped} | 取代 ${s.replaced} | 错误 ${s.errors}`);
    if (s.degraded) console.log(`  ⚠ 降级 ${s.degraded} 次（没走模型，写进去的是规则抽取的半句话）`);
    // 模型层的降级不报错，只是结果变糙。不单独列出来，"抽取正常"和"一直在用
    // 提示词硬凑"在日志上长得一模一样。
    if (s.fallbacks?.length) {
      const why = {
        "schema-unsupported": "端点不认 json_schema，退回 json_object",
        "schema-validate": "模型没按 schema 返回，退回文本解析",
        "json-unsupported": "端点连 json_object 都不认，退回纯提示词",
      };
      console.log(
        `  ⚠ 模型降级: ${s.fallbacks.map(([k, v]) => `${why[k] ?? k}×${v}`).join("；")}`
      );
    }
    if (s.dedupeFailed) console.log(`  ⚠ 判重失败 ${s.dedupeFailed} 次（那几批当「没有重复」处理了）`);
    if (s.hits) console.log(`  召回 ${s.hits} 次（memory.hit，按话题去重）`);
    if (s.tokens) console.log(`  tokens ${s.tokens}`);
    if (s.written) {
      console.log(`  条目长度 P10/P50/P90/max: ${s.len.p10}/${s.len.p50}/${s.len.p90}/${s.len.max}`);
    }
    if (s.models?.length) console.log(`  模型: ${s.models.map(([k, v]) => `${k}×${v}`).join("  ")}`);
    if (s.prompts?.length) console.log(`  prompt: ${s.prompts.map(([k, v]) => `${k}×${v}`).join("  ")}`);
    console.log("  事件分布: " + s.byEv.map(([k, v]) => `${k}:${v}`).join("  "));
    return;
  }

  if (sub === "tail") {
    const n = Number(flags.n ?? 20);
    const rows = readDays(1).slice(-n);
    if (!rows.length) return void console.log("今天还没有事件。");
    for (const r of rows) {
      const t = String(r.ts ?? "").slice(11, 19);
      const { ts, ev, ...rest } = r;
      const brief = Object.entries(rest)
        .filter(([, v]) => v !== "" && v != null)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join(" ")
        .slice(0, 150);
      console.log(`${t} ${String(ev).padEnd(14)} ${brief}`);
    }
    return;
  }

  if (sub === "grep") {
    const pat = args[1];
    if (!pat) throw new Error("用法：mem log grep <关键词> [--days 7]");
    const days = Number(flags.days ?? 7);
    const hit = readDays(days).filter((r) => JSON.stringify(r).toLowerCase().includes(pat.toLowerCase()));
    console.log(`${hit.length} 条命中（最近 ${days} 天）`);
    for (const r of hit.slice(-60)) {
      const t = String(r.ts ?? "").slice(5, 19).replace("T", " ");
      const { ts, ev, ...rest } = r;
      console.log(`${t} ${String(ev).padEnd(14)} ${JSON.stringify(rest).slice(0, 160)}`);
    }
    return;
  }

  if (sub === "today") return void console.log(dayOf());

  throw new Error(`不认识的子命令：${sub}（可用：stats / tail / grep）`);
}

/**
 * 召回。这是整套系统第一个"读"的入口——在这之前只能人手写 SQL。
 *
 * 用法：
 *   mem search 车架
 *   mem search "mcp adapter 元工具" --limit=5
 *   mem search 索引 --topic=精简WMS设计 --days=30
 */
async function cmdSearch(args, flags) {
  const q = args.join(" ").trim();
  if (!q) throw new Error("用法：mem search <关键词>");
  const to = flags.to ?? loadConfig().push?.to ?? "";
  const r = to
    ? await remoteSearch({
        to,
        token: flags.token,
        q,
        limit: flags.limit,
        topic: flags.topic,
        project: flags.project,
        type: flags.type,
        days: flags.days,
        status: flags.all ? "" : undefined,
      })
    : await searchEntries({
        q,
        limit: flags.limit,
        topic: flags.topic,
        project: flags.project,
        type: flags.type,
        days: flags.days,
        // --all 连过时的也一起看：查"当初为什么改"时需要，默认只给在用的。
        status: flags.all ? "" : undefined,
      });
  if (flags.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (!r.hits.length) {
    console.log(`没找到。检索词：${r.terms.join(" / ") || "（空）"}${r.remote ? `\n（查的是远端 ${r.remote}）` : ""}`);
    return;
  }
  console.log(`找到 ${r.hits.length} 条（检索词：${r.terms.join(" / ")}）${r.remote ? `\n远端 ${r.remote}` : ""}\n`);
  r.hits.forEach((h, i) => {
    console.log(`${i + 1}. [${h.entity || "-"}] ${h.date || ""} · ${h.type || ""}`);
    if (h.brief) console.log(`   ${h.brief}`);
    if (h.text && h.text !== h.brief) console.log(`   ${h.text.slice(0, 120)}${h.text.length > 120 ? "…" : ""}`);
    if (h.raw) console.log(`   原文 ${h.raw}`);
    console.log("");
  });
}

async function cmdMcp(flags) {
  const cfg = loadConfig();
  const to = flags.to ?? cfg.push?.to ?? "";
  const token = flags.token ?? cfg.push?.token ?? "";

  // 有中心地址就走中心：边缘机器上没有思源，直连必然超时，
  // 而超时的表现是「每次都查不到」，看起来像记忆库是空的。
  const search = to
    ? (opts) => remoteSearch({ ...opts, to, token })
    : (opts) => searchEntries(opts);

  // stdout 留给协议，日志一律 stderr——混一行进去客户端就断开。
  // 不在这里等：stdin 开着，readline 就撑着进程；关掉时进程自己退。
  startMcp({
    search,
    log: (m) => process.stderr.write(`${m}\n`),
  });
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
      return cmdSearch(rest, flags);
    case "review":
      return cmdReview(rest);
    case "show":
      return cmdShow(rest, flags);
    case "digest":
      return cmdDigest();
    case "raw":
      return cmdRaw(rest);
    case "entity":
      return cmdEntity(rest, flags);
    case "remember":
      return cmdRemember(flags, rest);
    case "forget":
      return cmdForget(rest);
    case "prompt":
      return cmdPrompt(rest, flags);
    case "model":
      return cmdModel(rest, flags);
    case "ui":
      return cmdUi(flags);
    case "service":
      return cmdService(rest, flags);
    case "log":
      return cmdLog(rest, flags);
    case "center":
      return cmdCenter(rest, flags);
    case "push":
      return cmdPush(flags, rest);
    case "mcp":
      return cmdMcp(flags);
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
