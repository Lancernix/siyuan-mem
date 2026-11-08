/**
 * 结构化事件日志。
 *
 * 人看的日志（serve.log）只够扫一眼"这一轮写了多少条"；调参、回溯、对比两次
 * 抽取的差异时，需要的是能被程序筛的东西：这条为什么没写、判重判成了什么、
 * 这一批用了哪个 prompt 版本。
 *
 * 所以两份并行：
 *   serve.log        人看，行文本，按体积轮转；
 *   logs/<日期>.jsonl 机器看，一行一个事件，按天分文件。
 *
 * 一条记录长这样：
 *   {"ts":"2026-10-31T01:52:03.412Z","ev":"entry.write","session":"6616caf8…",
 *    "id":"20261031015203-abc1234","entity":"mcp-adapter","len":214,"status":"current"}
 *
 * 不记正文。正文在思源里，日志只留 id 和长度——否则日志本身会变成一个
 * 未经治理的记忆库，而且带全文的日志很容易泄漏。
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./config.mjs";

const DIR = join(HOME_DIR, "logs");
const KEEP_DAYS = 30;
let pruned = false;

function pad(n) {
  return String(n).padStart(2, "0");
}

/** 按本地时区切天：跨日调试时"昨天那批"应该按人的直觉分，不是按 UTC。 */
export function dayOf(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function pathOf(day = dayOf()) {
  return join(DIR, `${day}.jsonl`);
}

/** 清掉超过保留期的日志。进程内只做一次，避免每条事件都 stat 目录。 */
export function prune(keepDays = KEEP_DAYS) {
  if (pruned) return;
  pruned = true;
  if (!existsSync(DIR)) return;
  const cut = Date.now() - keepDays * 86400_000;
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".jsonl")) continue;
    const day = f.slice(0, 10);
    const t = Date.parse(day + "T00:00:00");
    if (Number.isFinite(t) && t < cut) {
      try { unlinkSync(join(DIR, f)); } catch { /* 删不掉就算了，不能因为日志影响主流程 */ }
    }
  }
}

/**
 * 写一个事件。
 *
 * 任何异常都吞掉：日志失败不该让一条记忆写不进去。这里宁可静默，
 * 因为调用方全在写库的关键路径上。
 */
let eventBroken = false;
export function event(name, fields = {}) {
  try {
    mkdirSync(DIR, { recursive: true });
    prune();
    const rec = { ts: new Date().toISOString(), ev: name, ...fields };
    appendFileSync(pathOf(), JSON.stringify(rec) + "\n");
  } catch (e) {
    // 磁盘满、目录只读的时候，原来这里是全静默的：日志没了，运行看起来完全正常。
    // 只提示一次，别把 stderr 刷满。
    if (!eventBroken) {
      eventBroken = true;
      process.stderr.write(`! 事件日志写不进去（${e.message}），后续统计会缺失\n`);
    }
  }
}

/** 读某一天的全部事件；文件不存在返回空数组。 */
export function readDay(day = dayOf()) {
  const f = pathOf(day);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

/** 最近 n 天，从旧到新。 */
export function readDays(n = 7) {
  const out = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000);
    out.push(...readDay(dayOf(d)));
  }
  return out;
}

/**
 * 汇总。默认看最近 7 天：单看一天会被"今天没跑"误伤，看太久又看不清变化。
 */
export function stats({ days = 7 } = {}) {
  const rows = readDays(days);
  const byEv = new Map();
  let errors = 0;
  let written = 0;
  let skipped = 0;
  let replaced = 0;
  let degraded = 0;
  let hits = 0;
  let tokens = 0;
  const entries = [];
  const sessions = new Set();
  const models = new Map();
  const prompts = new Map();
  const fallbacks = new Map();

  for (const r of rows) {
    byEv.set(r.ev, (byEv.get(r.ev) ?? 0) + 1);
    if (r.ev === "error") errors++;
    if (r.ev === "entry.write") { written++; entries.push(r.len ?? 0); }
    if (r.ev === "entry.skip") skipped++;
    if (r.ev === "entry.replace") replaced++;
    if (r.ev === "memory.hit") hits++;
    // 模型层的降级：schema 不支持 / JSON 模式被拒 / schema 校验没过。
    // 这类事不报错，只让结果变糙，所以必须单独计数——不然"最近抽取正常"
    // 和"最近一直在用提示词硬凑"在日志上长得一模一样。
    if (r.ev === "llm.fallback") fallbacks.set(r.kind ?? "?", (fallbacks.get(r.kind ?? "?") ?? 0) + 1);
    if (r.session) sessions.add(String(r.session).slice(0, 8));
    if (r.ev === "extract.result") {
      // 没走模型就是降级：规则抽取写进库里全是半句话。这个数只要不是 0，
      // 就说明模型那头有配置问题或者正在失败，不能只看"写入多少条"。
      if (r.mode && r.mode !== "model" && r.mode !== "empty") degraded++;
      tokens += (r.tokens?.prompt ?? 0) + (r.tokens?.completion ?? 0);
      if (r.model) models.set(r.model, (models.get(r.model) ?? 0) + 1);
      if (r.prompt) prompts.set(r.prompt, (prompts.get(r.prompt) ?? 0) + 1);
    }
  }

  entries.sort((a, b) => a - b);
  const q = (p) => (entries.length ? entries[Math.floor(entries.length * p)] : 0);
  return {
    days,
    events: rows.length,
    sessions: sessions.size,
    written,
    skipped,
    replaced,
    degraded,
    hits,
    errors,
    fallbacks: [...fallbacks.entries()].sort((a, b) => b[1] - a[1]),
    tokens,
    len: { p10: q(0.1), p50: q(0.5), p90: q(0.9), max: entries.at(-1) ?? 0 },
    models: [...models.entries()],
    prompts: [...prompts.entries()],
    byEv: [...byEv.entries()].sort((a, b) => b[1] - a[1]),
  };
}
