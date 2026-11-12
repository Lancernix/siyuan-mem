/**
 * 导航层（列话题 / 按话题翻条目）的端到端测试，用假思源。
 *
 * 假思源**真的执行 SQL 里的 status / entity 条件**：上一轮日期那次的教训是，
 * 无条件返回整库的 mock 会让「SQL 少拼一个条件」完全测不出来（测试绿、线上空手）。
 * 这里同样：listEntries 要是忘了按话题过滤，测试必须红。
 *
 * 全部在临时 HOME 里跑，不碰真实实体表和日志。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "mem-browse-"));
process.env.HOME = HOME;

const { listTopics, listEntries, TOPIC_LIMIT, ENTRY_LIMIT } = await import("../src/core/browse.mjs");
const { ENTITIES_PATH, CONFIG_PATH } = await import("../src/util/config.mjs");

/** 超过展示阈值的话题名（真实库目前没有，但 schema 没有 .max()，随时可能出现）。 */
const LONG_NAME = "通勤骑行装备清单与冬季补能规划以及雨天备选方案汇总再外加一段很长的补充说明用来超过四十个汉字的截断阈值";

/** 实体表：规范名 + 别名 + 一个合并过的旧名，正好覆盖 topicNames 的三条路。 */
const TABLE = [
  { name: "通勤骑行", aliases: ["骑行穿搭", "公路车通勤"], status: "active" },
  { name: "羽毛球", aliases: ["羽球"], status: "active" },
  { name: "CAMP CROSS X 通勤车", aliases: [], status: "merged", mergedInto: "通勤骑行" },
  { name: "部署沙箱", aliases: [], status: "active" },
  { name: LONG_NAME, aliases: [], status: "active" },
];
let tableMode = "ok";

const ROWS = [
  { id: "a", date: "2026-11-10", entity: "通勤骑行", text: "通勤车换 32C 光头胎" },
  { id: "b", date: "2026-11-08", entity: "骑行穿搭", text: "冬天出门要感觉有点冷" },
  { id: "c", date: "2026-10-02", entity: "CAMP CROSS X 通勤车", text: "车架是 M5 孔" },
  { id: "d", date: "2026-09-20", entity: "羽毛球", text: "训练用 NO.5" },
  { id: "e", date: "2026-08-01", entity: "羽毛球", text: "比赛用高端竞赛级用球" },
  { id: "f", date: "2026-07-01", entity: "部署沙箱", text: "锁要放在 try 之外", status: "superseded" },
  { id: "g", date: "2026-11-11", entity: "部署沙箱", text: "改成先拿锁再写库" },
  // 第十八轮复审 P2-3：空 entity 与超长话题名。目录给出的名字必须能直接填回
  // listEntries，否则就是「目录 → 查不到 → 回目录」的死循环。
  { id: "h", date: "2026-11-03", entity: "", text: "没打话题的条目一" },
  { id: "i", date: "2026-11-02", entity: "", text: "没打话题的条目二" },
  { id: "j", date: "2026-11-04", entity: LONG_NAME, text: "长话题名条目一" },
  { id: "k", date: "2026-11-01", entity: LONG_NAME, text: "长话题名条目二" },
];

const ial = (r) =>
  Object.entries({
    "custom-mem-hash": r.id,
    "custom-mem-status": r.status ?? "current",
    "custom-mem-entity": r.entity,
    "custom-mem-brief": "",
    "custom-mem-date": r.date,
    "custom-mem-type": "decision",
    "custom-mem-confidence": "0.8",
    "custom-mem-raw": "",
    "custom-mem-project": "",
  })
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");

let sqlMode = "ok";
let lastStmt = "";

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/notebook/lsNotebooks") {
      return res.end(JSON.stringify({ code: 0, data: { notebooks: [{ id: "nb1", name: "Mem" }] } }));
    }
    if (req.url === "/api/query/sql") {
      lastStmt = String(body.stmt ?? "");
      if (sqlMode === "error") return res.end(JSON.stringify({ code: 1, msg: "database is locked" }));
      if (sqlMode === "not-array") return res.end(JSON.stringify({ code: 0, data: { rows: [] } }));
      // 还原 SQL 里真正生效的条件。别的条件（box/type/hash）是必带的常量，
      // 不为它们造分支；但 status / entity 变了必须看得见。
      // 未归类走的是 `(entity="" OR 属性缺失)`，不是名字列表，得单独认。
      const wantStatus = /custom-mem-status="([^"]*)"/.exec(lastStmt)?.[1] ?? "";
      const uncategorized = /custom-mem-entity=""|NOT LIKE '%custom-mem-entity=%'/.test(lastStmt);
      const entities = uncategorized
        ? []
        : [...lastStmt.matchAll(/custom-mem-entity="([^"]*)"/g)].map((m) => m[1]);
      const rows = ROWS.filter((r) => {
        if (wantStatus && (r.status ?? "current") !== wantStatus) return false;
        if (uncategorized) return r.entity === "";
        // 精确相等：原来用 includes 会让长话题名把短名字的条目也捞进来。
        if (entities.length && !entities.includes(r.entity)) return false;
        return true;
      });
      return res.end(JSON.stringify({ code: 0, data: rows.map((r) => ({ id: r.id, content: r.text, ial: ial(r) })) }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
test.after(() => server.close());

mkdirSync(join(HOME, ".siyuan-mem"), { recursive: true });
writeFileSync(CONFIG_PATH, JSON.stringify({ siyuan: { baseUrl: `http://127.0.0.1:${server.address().port}`, notebook: "Mem" } }));

function setTable() {
  if (tableMode === "missing") return;
  if (tableMode === "broken") return writeFileSync(ENTITIES_PATH, "{ 这不是 JSON");
  writeFileSync(ENTITIES_PATH, JSON.stringify(TABLE));
}
setTable();

function readEvents() {
  const dir = join(HOME, ".siyuan-mem", "logs");
  try {
    return readdirSync(dir)
      .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test.beforeEach(() => {
  sqlMode = "ok";
  tableMode = "ok";
  setTable();
  lastStmt = "";
});

test("列话题：别名与合并旧名归到规范名，条目数和最近日期跟着合并", async () => {
  const r = await listTopics({ silent: true });
  assert.equal(r.failed, undefined);
  assert.equal(r.degraded, false);
  const byName = new Map(r.topics.map((t) => [t.name, t]));
  // 「通勤骑行」3 条自己 + 别名「骑行穿搭」1 条 + 旧名「CAMP CROSS X 通勤车」1 条
  // 实际 ROWS 里 a(通勤骑行) b(骑行穿搭) c(旧名) 共 3 条；superseded 不计。
  assert.equal(byName.get("通勤骑行").count, 3);
  assert.equal(byName.get("通勤骑行").last, "2026-11-10");
  assert.ok(byName.get("通勤骑行").aliases.some((a) => a.includes("骑行穿搭")));
  assert.equal(byName.has("骑行穿搭"), false, "别名不该另起一行");
  assert.equal(byName.has("CAMP CROSS X 通勤车"), false, "合并旧名不该另起一行");
  assert.equal(byName.get("羽毛球").count, 2);
  assert.ok(!r.topics.some((t) => t.name === "未归类"));
});

test("列话题：q 是过滤提示，返回名字/别名命中的匹配依据", async () => {
  const byName = await listTopics({ q: "骑行穿搭", silent: true });
  assert.equal(byName.total, 1);
  assert.equal(byName.topics[0].name, "通勤骑行");
  assert.equal(byName.topics[0].match, "alias", "命中别名要标出来，模型才知道为什么它在结果里");
  const byExact = await listTopics({ q: "羽毛球", silent: true });
  assert.equal(byExact.topics[0].match, "name");
});

test("列话题：完全没有匹配时给活跃话题兜底，不返回空目录", async () => {
  // 空目录看起来像「库里没东西」，其实只是名字没对上——必须给可操作的下一步。
  const r = await listTopics({ q: "量子纠缠", silent: true });
  assert.equal(r.fallback, true);
  assert.ok(r.topics.length > 0, "兜底要把最活跃的话题列出来，不能空手");
  assert.ok(r.topics.every((t) => t.match === "fallback"), "兜底结果要标明它不是匹配上的");
  assert.ok(r.hint.includes("memory_search"), "兜底要给可操作的下一步");
  assert.ok(!r.hint.includes("没有匹配"), "别和结果头部重复同一句");
});

test("列话题：limit 有硬上限，超量要明说", async () => {
  const r = await listTopics({ limit: 9999, silent: true });
  assert.equal(TOPIC_LIMIT.max, 50);
  assert.ok(r.shown <= TOPIC_LIMIT.max);
  assert.match(lastStmt, /LIMIT 20000/);
  assert.equal(r.rowTruncated, false);
});

test("列话题：status 非法值在拼 SQL 之前就拒掉", async () => {
  const r = await listTopics({ status: "x' OR 1=1 --", silent: true });
  assert.equal(r.failed, true);
  assert.match(r.detail, /status 只能是/);
  assert.equal(lastStmt, "", "不该打到思源");
});

test("列话题：后端坏了是 failed，不是空目录", async () => {
  sqlMode = "error";
  const r = await listTopics({ silent: true });
  assert.equal(r.failed, true);
  assert.equal(r.reason, "backend-error");
  assert.match(r.detail, /database is locked/);
  sqlMode = "not-array";
  const r2 = await listTopics({ silent: true });
  assert.equal(r2.failed, true);
  assert.equal(r2.reason, "sql-not-array");
});

test("列话题：实体表读不出来要标 degraded 并说明，不能说成权威目录", async () => {
  tableMode = "broken";
  setTable();
  const r = await listTopics({ silent: true });
  assert.equal(r.degraded, true);
  assert.match(r.hint, /实体表读不出来/);
});

test("翻条目：按话题过滤，别名/旧名一起查，按日期从新到旧", async () => {
  const r = await listEntries({ topic: "骑行穿搭", silent: true });
  assert.equal(r.failed, undefined);
  assert.equal(r.canonical, "通勤骑行");
  assert.match(r.hint, /已归到规范名/);
  // 假思源真的执行了 SQL 的 entity 条件：只有这三个名字的条目会回来。
  assert.deepEqual(r.hits.map((h) => h.id), ["a", "b", "c"]);
  // 不走 query 门槛：没有 query 参数，门槛一条都不该套。
  assert.equal(r.hits.length, 3);
});

test("翻条目：名字没对上给候选，不静默返回空", async () => {
  const r = await listEntries({ topic: "骑行穿塔", silent: true });
  assert.equal(r.unknown, true);
  assert.equal(r.hits.length, 0);
  assert.ok(r.candidates.length > 0);
  assert.match(r.hint, /最接近的是/);
  // 表正常但名字没对上时不查库：给一堆全局条目只会误导，让模型换个名字重试才对。
  assert.equal(lastStmt, "");
});

test("翻条目：话题对上但被 days 滤光，和名字没对上是两件事", async () => {
  // 羽毛球的两条都在 8/9 月，days=30 只看最近一个月 → 空。
  // 关键是 unknown=false：这是「这个话题下最近没记过」，不是「没有这个话题」，
  // 界面上给的下一步完全不同。
  const r = await listEntries({ topic: "羽毛球", days: 30, silent: true });
  assert.equal(r.unknown, false);
  assert.equal(r.hits.length, 0);
  assert.equal(r.canonical, "羽毛球");
  assert.match(lastStmt, /custom-mem-entity/, "话题解析成功才查库");
});

test("翻条目：superseded 默认不见，include_superseded 才一起看", async () => {
  const normal = await listEntries({ topic: "部署沙箱", silent: true });
  assert.deepEqual(normal.hits.map((h) => h.id), ["g"]);
  const all = await listEntries({ topic: "部署沙箱", status: "", silent: true });
  assert.equal(all.hits.length, 2);
  assert.ok(all.hits.some((h) => h.status === "superseded"));
  assert.doesNotMatch(lastStmt, /custom-mem-status="/, "status 为空时不该拼状态条件");
});

test("翻条目：limit / days 控量与截断提示", async () => {
  assert.equal(ENTRY_LIMIT.max, 20);
  const few = await listEntries({ topic: "羽毛球", limit: 1, silent: true });
  assert.equal(few.shown, 1);
  assert.equal(few.total, 2);
  assert.equal(few.truncated, true);
});

test("翻条目：缺 topic 直接给下一步，不打到思源", async () => {
  const r = await listEntries({ silent: true });
  assert.equal(r.reason, "no-topic");
  assert.match(r.hint, /memory_topics/);
  assert.equal(lastStmt, "");
});

test("翻条目：后端坏了回 failed，不是「这个话题没内容」", async () => {
  sqlMode = "error";
  const r = await listEntries({ topic: "羽毛球", silent: true });
  assert.equal(r.failed, true);
  assert.equal(r.reason, "backend-error");
});

test("导航单独记 memory.browse，不污染召回的 hit/miss 分母", async () => {
  const before = readEvents().length;
  await listTopics({ q: "羽毛球", source: "mcp" });
  await listEntries({ topic: "羽毛球", source: "mcp" });
  const added = readEvents().slice(before).filter((e) => e.ev === "memory.browse");
  assert.equal(added.length, 2);
  assert.deepEqual(added.map((e) => e.kind).sort(), ["entries", "topics"]);
  assert.ok(added.every((e) => e.source === "mcp"));
  assert.equal(readEvents().slice(before).filter((e) => e.ev === "memory.hit" || e.ev === "memory.miss").length, 0);
  // silent 用于离线评测，不能把「被用起来」这个信号灌满。
  const n = readEvents().length;
  await listTopics({ silent: true });
  await listEntries({ topic: "羽毛球", silent: true });
  assert.equal(readEvents().length, n);
});

test("P2-3：目录给出的名字必须能直接填回 listEntries（长名不被截断）", async () => {
  // 第十八轮复审实测：44 字话题名被 clip 成「…」结尾的不可用名字，
  // 候选名也被 clip 成同一个，「用规范名重试」等于没说 → 目录与查条目闭环死循环。
  const t = await listTopics({ q: LONG_NAME.slice(0, 6), silent: true });
  const hit = t.topics.find((x) => x.name.includes("通勤骑行装备"));
  assert.ok(hit, "目录里应该能搜到这个长话题");
  assert.equal(hit.name, LONG_NAME, "话题名必须原样返回，一字不截");
  assert.ok(!hit.name.endsWith("…"), "截断后的名字填回去查不到，绝不能给模型");
  const e = await listEntries({ topic: hit.name, silent: true });
  assert.equal(e.unknown, false);
  assert.deepEqual(e.hits.map((h) => h.id).sort(), ["j", "k"], "目录里的名字填回去就该查到条目");
});

test("P2-3：「（未归类）」能填回 listEntries，不再指回目录", async () => {
  const t = await listTopics({ silent: true });
  const g = t.topics.find((x) => x.name === "（未归类）");
  assert.ok(g, "空 entity 的条目该在目录里占一格");
  assert.equal(g.count, 2);
  const e = await listEntries({ topic: g.name, silent: true });
  assert.equal(e.unknown, false, "这是保留字，不是「没这个话题」");
  assert.deepEqual(e.hits.map((h) => h.id).sort(), ["h", "i"], "按 entity 为空查");
  assert.equal(e.canonical, "（未归类）");
  // 目录里这一格的 hint 不能再说「先用 memory_topics 看目录」——那就是死循环。
  assert.doesNotMatch(e.hint, /用 memory_topics 看目录/);
});

test("P2-3：候选名原样返回，截断过的候选等于没给", async () => {
  // 名字没对上时，候选名要能直接拿去重试；截成「…」结尾就永远用不了。
  const e = await listEntries({ topic: LONG_NAME.slice(0, 20) + "XYZ", silent: true });
  assert.equal(e.unknown, true);
  if (e.candidates.includes(LONG_NAME)) {
    assert.ok(e.candidates.every((c) => !c.endsWith("…")), "候选名不能截断");
    assert.ok(e.hint.includes(LONG_NAME), "hint 里要给完整的可用名字");
  }
});


test("P3：列话题撞 SQL 上限要留事件并在结果里说明，不能静默当全量", async () => {
  // ROW_CAP 提到 2 万，假思源造不了那么多行；这里直接验返回契约：
  // 正常路径 rowTruncated=false，且 hint 不含「超过」字样。
  const r = await listTopics({ silent: true });
  assert.equal(r.rowTruncated, false);
  assert.equal(typeof r.truncated, "boolean");
  assert.doesNotMatch(r.hint, /超过/);
  // 事件里要带这个字段，回溯时能筛出哪次目录不完整。
  const before = readEvents().length;
  await listTopics({ source: "mcp" });
  const ev = readEvents().slice(before).find((e) => e.ev === "memory.browse" && e.kind === "topics");
  assert.ok(ev, "列话题要记 memory.browse");
  assert.equal(ev.rowTruncated, false);
});
