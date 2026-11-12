/**
 * 任务级试跑：模拟 agent 用「一串工具调用」去回答一道 hard 档问题。
 *
 * 和 eval-recall.mjs 的区别：那边是单跳（一句 query → 一个期望 id），量不了
 * 「先列目录、再按话题翻」这种链路。这里记录的是**调用链**：每步调了什么、
 * 返回了什么、最终能不能把答案摆到模型眼前、以及这一串一共往上下文里塞了多少字。
 *
 * 两条不能破的规矩，否则就变成自证：
 *
 *  1. **链路里不许偷看 expect。** 挑话题名只能从问题本身出发；expect 只在
 *     最后判分时用一次。LLM 策略里模型只看到问题 + 话题名字清单，看不到
 *     条目正文，也看不到答案。
 *  2. **不宣称「召回变好了」。** 这里测的是「导航可达性」——答案在不在
 *     agent 顺着目录能翻到的范围里，而不是排序准不准。翻到了不等于模型
 *     会读、会认，那要真 harness 实测才算。
 *
 * 两种策略，对照着看：
 *
 *   mechanical  刻意机械、零模型：strongTerms(整句) 前 3 个词各查一次目录，
 *               收真的匹配上的话题（兜底浏览不算），再逐个翻条目。
 *               完全可复现，也比真实 agent 笨——所以它的**负数比正数更可信**。
 *   llm         更接近真实 harness：先把不带 q 的话题目录（前 50）给模型，
 *               让它挑最可能回答这个问题的 1–3 个话题，再翻条目。
 *               这一步正是「从问题猜话题名」，机械链路栽在这儿。
 *
 * 两步都以 memory_search(整句) 开头，和单跳基线同口径。
 *
 * 用法：
 *   node scripts/eval-tasks.mjs --file ~/.siyuan-mem/eval/recall-pairs.json
 *   node scripts/eval-tasks.mjs --kind hard --limit 5 --strategy both --verbose
 *   node scripts/eval-tasks.mjs --strategy llm --out /tmp/tasks.json
 *
 * 题库和结果都不进仓库：里面有真实记忆的正文和 id。
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_FILE = join(homedir(), ".siyuan-mem", "eval", "recall-pairs.json");
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);
const file = arg("file", DEFAULT_FILE);
const outFile = arg("out", "");
const limit = Number(arg("limit", 5));
const kind = arg("kind", "hard");
const strategy = arg("strategy", "both");
const verbose = has("verbose");
const TOPIC_WORDS = Number(arg("topic-words", 3));
const MAX_TOPICS = Number(arg("max-topics", 3));
const ENTRY_LIMIT = 20;
const CATALOG_LIMIT = Number(arg("catalog-limit", 50));

if (!existsSync(file)) {
  console.error(`找不到题库：${file}`);
  process.exit(1);
}

const { searchEntries, termsOf, strongTerms } = await import("../src/core/search.mjs");
const { listTopics, listEntries } = await import("../src/core/browse.mjs");
const { formatHits, formatTopics, formatEntries } = await import("../src/mcp/server.mjs");
const { loadConfig } = await import("../src/util/config.mjs");
const { chat } = await import("../src/util/llm.mjs");
const { SiYuan } = await import("../src/util/siyuan.mjs");
const { ATTR } = await import("../src/core/store.mjs");

const cases = JSON.parse(readFileSync(file, "utf8")).filter((c) => c.kind === kind && c.expect?.length);

/**
 * 反查期望条目挂在哪个话题下，**只用于留痕分析**，不进任何检索决策。
 * 有了它，脚本能自动区分「模型挑错话题」和「目录压根没给到」——README 里
 * 那两个数字（11/14 在前 50、采访式对话第 153 名）原来是手工查出来的，
 * 下次重跑不记这些就又得手工查一遍（第十八轮复审 P3）。
 */
async function loadExpectEntities(cfg, cs) {
  const ids = [...new Set(cs.flatMap((c) => c.expect ?? []))];
  if (!ids.length) return new Map();
  try {
    const sy = new SiYuan({ baseUrl: cfg.siyuan.baseUrl, token: cfg.siyuan.token, timeoutMs: 8000 });
    const list = ids.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(",");
    const rows = await sy.sql(`SELECT id, ial FROM blocks WHERE id IN (${list})`);
    const re = new RegExp(`${ATTR.entity}="([^"]*)"`);
    return new Map((rows ?? []).map((r) => [r.id, re.exec(String(r.ial ?? ""))?.[1] ?? ""]));
  } catch {
    // 反查失败不影响试跑，只是留痕里少一列；别把分析步骤变成新的失败面。
    return new Map();
  }
}
/** 后端坏了不能产出结果表：故障时每条都空手，看起来像「导航没用」。 */
function check(r, what) {
  if (r.failed) throw new Error(`${what} 报故障：${r.reason}${r.detail ? `（${String(r.detail).slice(0, 100)}）` : ""}`);
  return r;
}

const PICK_PROMPT = `你是一个记忆检索助手。用户问了一个关于过去对话的问题，你需要判断应该去哪些「话题」下面翻记录。

只输出 JSON：{"topics":["话题名",…]}，最多 3 个，按可能性从高到低。
规则：
- 只能从给定的话题清单里选，原样照抄名字，不要编造、不要改写。
- 问题里的说法可能和话题名完全不同（口语、别名、只描述场景），按语义猜。
- 宁可少选也不要凑数；一个都不像就返回 {"topics":[]}。
- 不要解释，只输出 JSON。`;

/** 模型挑话题：只喂问题 + 话题名字，不喂正文、不喂 expect。 */
async function pickTopicsWithLlm(cfg, q, catalog) {
  const names = catalog.map((t, i) => `${i + 1}. ${t.name}${t.aliases?.length ? `（别名：${t.aliases.join("、")}）` : ""}`).join("\n");
  const r = await chat(cfg, {
    messages: [
      { role: "system", content: PICK_PROMPT },
      { role: "user", content: `问题：${q}\n\n话题清单：\n${names}` },
    ],
    json: true,
    tag: "eval-tasks-pick",
  });
  let picked = [];
  try {
    picked = JSON.parse(String(r.text ?? "")).topics ?? [];
  } catch {
    // 模型偶尔会裹一层 markdown，捞一次；捞不到就当它没挑出来，别伪造。
    const m = /\{[\s\S]*\}/.exec(String(r.text ?? ""));
    if (m) {
      try {
        picked = JSON.parse(m[0]).topics ?? [];
      } catch {
        /* 留空 */
      }
    }
  }
  // 只认清单里真有的名字：模型照抄错了也别让链路偷偷用一个不存在的话题。
  const known = new Set(catalog.map((t) => t.name));
  return [...new Set(picked.map(String))].filter((n) => known.has(n)).slice(0, MAX_TOPICS);
}

async function runCase(c, which, cfg, expectEntity) {
  const chain = [];
  let catalogInfo = null;
  const foundAt = { step: "", tool: "", rank: 0 };
  let chars = 0;
  let llmError = "";
  const note = (tool, args, r, text, ids) => {
    const n = String(text ?? "").length;
    chars += n;
    chain.push({ tool, args, ids, chars: n, n: ids.length });
    if (!foundAt.step) {
      const at = (c.expect ?? []).map((id) => ids.indexOf(id)).find((x) => x >= 0);
      if (at !== undefined) {
        foundAt.step = String(chain.length);
        foundAt.tool = tool;
        foundAt.rank = at + 1;
      }
    }
  };

  // step 1：单跳基线。整句问法，和 eval-recall 的口径一致。
  const s = check(await searchEntries({ q: c.q, limit, silent: true }), "memory_search");
  const sIds = s.hits.map((h) => h.id);
  note("memory_search", { q: c.q, limit }, s, formatHits(s.hits, s.terms, s.hint, s.reason), sIds);
  const singleHit = (c.expect ?? []).some((id) => sIds.includes(id));

  let topics = [];
  let words = [];
  let fallbackOnly = 0;

  if (which === "mechanical") {
    // 从问题本身拆词查目录。兜底浏览不算匹配——它给的是最活跃的话题，跟问题
    // 无关，拿去翻条目只是浪费上下文。
    words = strongTerms(termsOf(c.q)).slice(0, TOPIC_WORDS);
    const found = new Map();
    for (const w of words) {
      const t = check(await listTopics({ q: w, limit: 20, silent: true }), "memory_topics");
      note("memory_topics", { q: w, limit: 20 }, t, formatTopics(t), t.topics.map((x) => x.name));
      if (t.fallback) {
        fallbackOnly++;
        continue;
      }
      for (const x of t.topics) if (!found.has(x.name)) found.set(x.name, x);
    }
    topics = [...found.keys()].slice(0, MAX_TOPICS);
  } else {
    // 目录只取一次（不带 q），把名字清单交给模型挑。这一步替代机械链路里
    // 「用 2-gram 硬猜话题名」，是真实 agent 会做的语义判断。
    const t = check(await listTopics({ limit: CATALOG_LIMIT, silent: true }), "memory_topics");
    note("memory_topics", { limit: CATALOG_LIMIT }, t, formatTopics(t), t.topics.map((x) => x.name));
    // 目录容量留痕：下次重跑能自动区分「模型挑错」和「目录根本没给到」。
    catalogInfo = {
      total: t.total,
      shown: t.shown,
      truncated: t.truncated,
      degraded: t.degraded,
      // 期望条目所在话题在不在这一屏目录里。这里只读数据库做**分析**，
      // 结果不回流到任何检索决策，所以不构成自证。
      expectVisible: (c.expect ?? []).some(
        (id) => expectEntity.get(id) && t.topics.some((x) => x.name === expectEntity.get(id))
      ),
      expectEntity: [...new Set((c.expect ?? []).map((id) => expectEntity.get(id)).filter(Boolean))],
    };
    try {
      topics = await pickTopicsWithLlm(cfg, c.q, t.topics);
      chain.push({ tool: "llm_pick", args: { topics }, ids: [], chars: 0, n: topics.length });
    } catch (e) {
      // 模型挂了要显式留痕，不能静默当成「模型没挑出话题」——那会伪造阴性。
      llmError = String(e?.message ?? e).slice(0, 160);
      chain.push({ tool: "llm_pick_failed", args: { error: llmError }, ids: [], chars: 0, n: 0 });
    }
  }

  // step 3：翻话题。封顶 MAX_TOPICS，别让一串调用把上下文吃光。
  for (const name of topics) {
    const e = check(await listEntries({ topic: name, limit: ENTRY_LIMIT, silent: true }), "memory_entries");
    note("memory_entries", { topic: name, limit: ENTRY_LIMIT }, e, formatEntries(e), e.hits.map((h) => h.id));
  }

  const allIds = new Set(chain.flatMap((x) => x.ids));
  return {
    q: c.q, qk: c.qk ?? "", expect: c.expect, strategy: which,
    words, topics, fallbackOnly, llmError, catalogInfo, singleHit,
    reachable: !!(c.expect ?? []).some((id) => allIds.has(id)),
    foundAt, calls: chain.length, chars, chain,
  };
}

const cfg = loadConfig();
const expectEntity = await loadExpectEntities(cfg, cases);
const run = strategy === "both" ? ["mechanical", "llm"] : [strategy];
const groups = new Map(run.map((s) => [s, []]));
try {
  for (const c of cases) {
    for (const s of run) groups.get(s).push(await runCase(c, s, cfg, expectEntity));
  }
} catch (e) {
  console.error(`\n试跑中止：${e.message}`);
  console.error("后端出问题时任何链路都会空手，这不能当成「导航没用」。修好后重跑。");
  process.exit(2);
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`\n任务级试跑：${kind} 档 ${cases.length} 题，单跳 limit=${limit}，话题封顶 ${MAX_TOPICS} × ${ENTRY_LIMIT} 条。`);
console.log(`策略：${run.join(" / ")}\n`);
console.log("策略         单跳命中   导航可达   单跳没中但导航翻到   平均调用   平均字符   模型挑话题失败");
for (const s of run) {
  const rows = groups.get(s);
  const single = rows.filter((r) => r.singleHit).length;
  const reach = rows.filter((r) => r.reachable).length;
  const rescued = rows.filter((r) => !r.singleHit && r.reachable).length;
  const errs = rows.filter((r) => r.llmError).length;
  console.log(
    `${s.padEnd(12)} ${String(single).padStart(3)}/${rows.length} ${pct(single, rows.length).padStart(6)}   ${String(reach).padStart(3)}/${rows.length} ${pct(reach, rows.length).padStart(6)}      ${String(rescued).padStart(3)} 题              ${(rows.reduce((n, r) => n + r.calls, 0) / rows.length).toFixed(1).padStart(5)}   ${String(Math.round(rows.reduce((n, r) => n + r.chars, 0) / rows.length)).padStart(7)}   ${errs ? String(errs) : "-"}`
  );
  // 目录容量分因：够不到的题里，有多少是「答案话题压根没出现在目录里」。
  // 这个区分原来靠手工查，现在随留痕一起产出（第十八轮复审 P3）。
  const withCat = rows.filter((r) => r.catalogInfo);
  if (withCat.length) {
    const visible = withCat.filter((r) => r.catalogInfo.expectVisible).length;
    const cut = withCat.filter((r) => r.catalogInfo.truncated).length;
    console.log(
      `${"".padEnd(12)} 目录容量：共 ${withCat[0].catalogInfo.total} 个话题，给了 ${withCat[0].catalogInfo.shown} 个；` +
        `答案话题在这屏里 ${visible}/${withCat.length} 题；目录被截断 ${cut} 次` +
        `${withCat[0].catalogInfo.degraded ? "（实体表读不出来）" : ""}`
    );
  }
}

for (const s of run) {
  const rows = groups.get(s);
  console.log(`\n===== ${s} 逐题 =====`);
  console.log("题号  单跳  可达  调用  字符   挑中的话题");
  rows.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(3)}   ${r.singleHit ? " ✓ " : " · "}    ${r.reachable ? " ✓ " : " · "}   ${String(r.calls).padStart(3)}  ${String(r.chars).padStart(5)}   ${r.topics.join("、") || "(没翻)"}${r.llmError ? ` [模型失败:${r.llmError.slice(0, 40)}]` : ""}`
    );
    if (verbose) {
      console.log(`      目录：${r.catalogInfo ? `共 ${r.catalogInfo.total} / 给了 ${r.catalogInfo.shown} / 答案话题可见 ${r.catalogInfo.expectVisible} / 期望话题 ${r.catalogInfo.expectEntity.join("、") || "?"}` : "(机械策略不查目录)"}`);
      console.log(`      问题：${r.q}`);
      console.log(`      期望：${r.expect.join(",")}`);
      console.log(`      命中于：第 ${r.foundAt.step || "-"} 步 ${r.foundAt.tool || "-"} 第 ${r.foundAt.rank || "-"} 条`);
      r.chain.forEach((st, j) => console.log(`      ${j + 1}. ${st.tool}(${JSON.stringify(st.args)}) → ${st.n} 项 / ${st.chars} 字`));
    }
  });
  const bad = rows.filter((r) => !r.reachable);
  if (bad.length) {
    console.log("  整条链路都够不到的：");
    for (const r of bad) console.log(`    · ${r.q}\n       挑中 ${r.topics.join("、") || "(空)"}`);
  }
}

if (outFile) {
  writeFileSync(outFile, JSON.stringify({ kind, limit, groups: Object.fromEntries(groups) }, null, 1));
  console.log(`\n留痕写到 ${outFile}`);
}
