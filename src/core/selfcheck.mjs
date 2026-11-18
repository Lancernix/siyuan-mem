/**
 * 自检：确认「判重这条链路现在是通的」。
 *
 * 判重失败时的策略是「当没有重复」——这是对的（重复一条是脏，丢一条是错），但它让
 * 故障完全静默：一次 ReferenceError 被 catch 吞掉，判重就失效了半小时，而日志上
 * 只是多几条 dedupe.failed，跟「模型偶尔抖动」长得一样。
 *
 * 做法：拿一对必然进候选的固定样本走一遍真实调用，只看「请求发出去了没有、有没有
 * 抛程序错误」。模型判成什么（replace/covered/keep）都算通——验的是链路不是判断力。
 */
import { existsSync, readFileSync } from "node:fs";
import { judgeDuplicates, pickCandidates, dedupeStats } from "./dedupe.mjs";
import { isBackendFailure, isTrivialQuery } from "./search-reason.mjs";
import { dayOf, pathOf } from "../util/log.mjs";
import { normalizeSource } from "../util/source.mjs";

/**
 * 一对自检样本：同一件事的两种说法。必须字面高度重合才进得了候选；这条要是哪天
 * 进不了候选，哨兵会报「样本失效」，别和「判重坏了」混。
 */
const SAMPLE_OLD = {
  id: "selfcheck-old",
  entity: "自检样本",
  brief: "容器端口映射写错",
  project: "",
  text: "容器内 nginx 监听 7788，宿主机侧映射写成了 7789，改回去就好。",
};
const SAMPLE_NEW = {
  id: "selfcheck-new",
  entity: "自检样本",
  brief: "容器端口映射写错",
  project: "",
  text: "容器里 nginx 监听的是 7788，宿主机映射写成了 7789，要改回来。",
};

/**
 * 跑一次判重哨兵。
 *
 * @returns {{ok:boolean, reason:string, ms:number, action:string}}
 */
export async function checkDedupe(cfg, { deadlineMs = 90_000 } = {}) {
  const t0 = Date.now();
  // 先验样本本身：样本进不了候选时，一次模型都不会调，那时候报「判重坏了」是误报。
  const { plan } = pickCandidates({ news: [SAMPLE_NEW], existing: [SAMPLE_OLD] });
  if (!plan.length) {
    return { ok: false, reason: "自检样本进不了候选（挑候选的逻辑或门槛变了）", ms: 0, action: "" };
  }

  const before = dedupeStats();
  try {
    const out = await judgeDuplicates({
      cfg,
      news: [SAMPLE_NEW],
      existing: [SAMPLE_OLD],
      deadline: Date.now() + deadlineMs,
    });
    const after = dedupeStats();
    const ms = Date.now() - t0;
    if (after.crashed > before.crashed) {
      return { ok: false, reason: `判重链路抛了程序错误：${after.lastError}`, ms, action: "" };
    }
    if (after.calls === before.calls) {
      return { ok: false, reason: "一次模型调用都没发出去", ms, action: "" };
    }
    if (after.failed > before.failed) {
      return { ok: false, reason: `判重没生效：${after.lastError || "模型调用失败"}`, ms, action: "" };
    }
    // 关键的一条：必须**真的拿到一份可解析的裁决**。
    //
    // 只看 failed 是不够的——模型返回 `{"decisions":[]}`（换了键名、或者干脆没按格式回）
    // 时既不抛错也不产生裁决，failed 不动，哨兵就会报「通过」。而这恰恰是哨兵最该
    // 抓的那种「静默失效」。
    if (after.answered <= before.answered) {
      return { ok: false, reason: "模型没有返回可解析的裁决（空结果也算坏）", ms, action: "" };
    }
    // 判成 keep 也是通的：哨兵验链路，不验判断力。
    return { ok: true, reason: "", ms, action: out.get(0)?.action ?? "keep" };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 160), ms: Date.now() - t0, action: "" };
  }
}

/**
 * 今天的判重账本：裁决了多少条、失败多少次、崩溃多少次。
 *
 * 崩溃（ReferenceError 这类程序错误）和失败（模型超时、429）要分开数：
 * 前者是我们自己的 bug，出现一次就该当事故处理；后者是环境噪音。
 */
/**
 * 今天的召回健康度，按调用来源分开。
 *
 * 必须分来源：人和 agent 的调用混在一起，就答不了「这东西到底有没有被用起来」。
 *
 * 只有「真的查了、真的没有」才算空手：后端挂了该去修后端，没问出词该换说法，
 * 混进空手率，这个指标就不能用来判断「要不要继续调召回」了。
 */
export function recallHealthToday(day = dayOf()) {
  const out = { hit: 0, miss: 0, failed: 0, trivial: 0, bySource: {} };
  const file = pathOf(day);
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.ev !== "memory.hit" && e.ev !== "memory.miss") continue;
    const src = normalizeSource(e.source);
    if (!out.bySource[src]) out.bySource[src] = { hit: 0, miss: 0, failed: 0, trivial: 0 };
    if (e.ev === "memory.hit") {
      out.hit++;
      out.bySource[src].hit++;
    } else {
      // 三分类：真的没查到 / 后端坏了 / 没问出东西。旧的日志没有 reason，
      // 归到 miss——它们都是真查过且没命中的。
      const kind = isBackendFailure(e.reason) ? "failed" : isTrivialQuery(e.reason) ? "trivial" : "miss";
      out[kind]++;
      out.bySource[src][kind]++;
    }
  }
  return out;
}

/**
 * 今天有多少场会话读过记忆库本身。
 *
 * `session.begin` 里带着 memTools（这场调过几次我们自己的 MCP 工具）。工具结果在
 * 采集层就被丢掉了，所以不会原样回流；但调用过就说明这场的内容是从库里取的，
 * 它写出来的总结有大概率是二手复述。
 *
 * 只统计，不处理。要不要在抽取前拦掉这类会话，得先看真实比例：一场都没有的时候
 * 就加拦截，只会在「误伤正常会话」和「漏掉大半」之间瞎猜。
 *
 * @returns {{sessions:number, reading:number, calls:number}}
 */
export function derivedHealthToday(day = dayOf()) {
  const out = { sessions: 0, reading: 0, calls: 0 };
  const file = pathOf(day);
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.ev !== "session.begin") continue;
    out.sessions++;
    const n = Number(e.memTools) || 0;
    if (n > 0) {
      out.reading++;
      out.calls += n;
    }
  }
  return out;
}

/**
 * 今天的导航调用：列了几次目录、翻了几次条目，按来源分开。
 *
 * 单独一套事件、单独一个计数，不混进 recallHealthToday：那个数是「召回准不准」
 * 的分母，导航是「有没有能力先发现命名空间」。混在一起会让空手率被导航灌水，
 * 也会让「agent 到底用没用新工具」这个问题又答不了。
 */
export function browseHealthToday(day = dayOf()) {
  const out = { topics: 0, entries: 0, bySource: {} };
  const file = pathOf(day);
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.ev !== "memory.browse" || (e.kind !== "topics" && e.kind !== "entries")) continue;
    const src = normalizeSource(e.source);
    if (!out.bySource[src]) out.bySource[src] = { topics: 0, entries: 0 };
    out[e.kind]++;
    out.bySource[src][e.kind]++;
  }
  return out;
}

export function dedupeHealthToday(day = dayOf()) {
  const out = { decisions: 0, replace: 0, covered: 0, failed: 0, crashed: 0, leafFailed: 0, lastError: "" };
  const file = pathOf(day);
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.ev === "dedupe.decision") {
      out.decisions++;
      if (e.action === "replace") out.replace++;
      else if (e.action === "covered") out.covered++;
    } else if (e.ev === "dedupe.failed") {
      // 拆半重试的子块失败单独算：它不会冒到逻辑层，混进 failed 会把一次失败
      // 记成八次；完全不记又看不见。
      if (Number(e.depth) > 0) out.leafFailed++;
      else {
        out.failed++;
        out.lastError = String(e.error ?? e.reason ?? "").slice(0, 60);
      }
    } else if (e.ev === "dedupe.crash") {
      // 与 dedupeStats() 的内存口径一致：子块（depth>0）的程序错误计 leafFailed，
      // 不计 crashed。否则同一次失败在两个视图里是两个数字。
      if (Number(e.depth) > 0) out.leafFailed++;
      else {
        out.crashed++;
        out.lastError = String(e.error ?? "").slice(0, 60);
      }
    }
  }
  return out;
}
