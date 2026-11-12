/**
 * 召回的两个「说清楚」问题（2026-11-11 第十三轮 CR）。
 *
 * 1. **后端故障不能渲染成「没记过」。** 假思源对 SQL 回 `code:0` 但 `data` 是对象
 *    （思源真实的故障形态），原来 `mem search` 打一句「没找到」、退出码 0——
 *    比报错更糟，因为它看起来像答案。这里从 CLI 进程外面验退出码。
 *
 * 2. **年份查询。** 正文里通常不写年份，证据只在 date 属性上。SQL 不加 date
 *    字段 → 候选池里就没有；内存里不认 date → 进了池也会被 rel/门槛筛掉；
 *    把年份算进门槛 → 任何当年记的条目都能过闸。三层缺一层都等于没修。
 *
 * 假思源只实现两个接口（lsNotebooks / query），SQL 不解析——测的是我们拿到
 * 数据之后怎么判，不是 SQL 本身。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "mem-search-e2e-"));
process.env.HOME = HOME;

const ial = (o) =>
  Object.entries({
    "custom-mem-hash": o.id,
    "custom-mem-status": "current",
    "custom-mem-entity": o.entity ?? "部署沙箱",
    "custom-mem-brief": o.brief ?? "",
    "custom-mem-date": o.date,
    "custom-mem-type": "decision",
    "custom-mem-confidence": "0.8",
    "custom-mem-raw": "",
    "custom-mem-session": "s1",
    "custom-mem-source": "test",
    "custom-mem-project": "",
  })
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");

const ROWS = [
  // 正文里没有「2025」，只有 date 是 2025 —— 纯年份查询唯一能靠的证据。
  { id: "a-2025", date: "2025-03-04", text: "锁不可靠：acquire 放在 try 之外，失败也照跑。" },
  { id: "b-2026", date: "2026-05-01", text: "锁不可靠：重启后 nginx 缓存了上游 IP。" },
  { id: "c-2026", date: "2026-05-02", text: "端口映射改成 7789 了。", entity: "容器" },
  // 补两条 2025 的：一条 11 月，用来验「查 2025-1（1 月）不能返回它」。
  { id: "d-2025", date: "2025-11-20", text: "部署计划改用 compose 编排。" },
  // 型号约束的对照样本：NO.5 条目和 NO.9 查询同月同日，年份不能替它过闸。
  { id: "e-2026", date: "2026-05-03", text: "亚狮龙 NO.5 的价格是 120。", entity: "羽毛球" },
];

let mode = "ok";
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
      if (mode === "not-array") return res.end(JSON.stringify({ code: 0, data: { rows: [] } }));
      if (mode === "error") return res.end(JSON.stringify({ code: 1, msg: "database is locked" }));
      return res.end(
        JSON.stringify({ code: 0, data: applyDateFilter(lastStmt).map((r) => ({ id: r.id, content: r.text, ial: ial(r) })) })
      );
    }
    res.statusCode = 404;
    res.end("{}");
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

mkdirSync(join(HOME, ".siyuan-mem"), { recursive: true });
writeFileSync(
  join(HOME, ".siyuan-mem", "config.json"),
  JSON.stringify({ siyuan: { baseUrl: `http://127.0.0.1:${port}`, notebook: "Mem" } })
);

const { searchEntries } = await import("../src/core/search.mjs");

test.after(() => server.close());

const ids = (r) => r.hits.map((h) => h.id).sort();

/**
 * 假思源也要执行日期条件。
 *
 * 上一版它无条件返回整库，于是「SQL 少补一个零」这种漏召回在测试里完全看不见——
 * 内存层拿到全部候选当然能答对，测试绿、线上空手（第十六轮复审就是这么被抓到的）。
 * 这里只还原 SQL 里日期那一段（OR 宽筛：date 或正文含这串即入选），别的条件不管，
 * 交给内存层。
 */
function applyDateFilter(stmt) {
  const pats = [...stmt.matchAll(/custom-mem-date="%([^"']*)%'/g)].map((m) => m[1]);
  if (!pats.length) return ROWS;
  return ROWS.filter((r) => pats.some((p) => r.date.includes(p) || r.text.includes(p)));
}


/** 读今天所有 memory.* 事件（按写入顺序）。 */
function readEvents() {
  const dir = join(HOME, ".siyuan-mem", "logs");
  return readdirSync(dir)
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.ev?.startsWith("memory."));
}


test("纯年份查询：正文没有年份也能靠 date 找到", async () => {
  const r = await searchEntries({ q: "2025", limit: 5, silent: true });
  assert.deepEqual(ids(r), ["a-2025", "d-2025"]);
  // SQL 层必须给年份词加上 date 字段，否则候选池里根本没有这条。
  assert.match(lastStmt, /custom-mem-date/, "年份查询的 SQL 要带上 date 字段");
});

test("年份当过滤器，不当门槛：不能靠「2026」把当年所有条目捞回来", async () => {
  const r = await searchEntries({ q: "2025 锁", limit: 5, silent: true });
  assert.deepEqual(ids(r), ["a-2025"], "2026 那条也含「锁」，但年份不对，必须挡掉");
  const y = await searchEntries({ q: "2026", limit: 5, silent: true });
  assert.deepEqual(ids(y), ["b-2026", "c-2026", "e-2026"]);
});

test("非年份词不去匹配 date：否则查「11」会命中所有 11 月记的条目", async () => {
  await searchEntries({ q: "端口", limit: 5, silent: true });
  assert.doesNotMatch(lastStmt, /custom-mem-date/);
});

test("后端返回非数组：带 failed 回来，不能当「没记过」", async () => {
  mode = "not-array";
  try {
    const r = await searchEntries({ q: "部署计划", limit: 5, silent: true });
    assert.equal(r.failed, true);
    assert.equal(r.reason, "sql-not-array");
    assert.equal(r.hits.length, 0);
  } finally {
    mode = "ok";
  }
});

test("SQL 直接报错也是 failed，带着原因", async () => {
  mode = "error";
  try {
    const r = await searchEntries({ q: "部署计划", limit: 5, silent: true });
    assert.equal(r.failed, true);
    assert.equal(r.reason, "backend-error");
    assert.match(r.detail, /database is locked/);
  } finally {
    mode = "ok";
  }
});

test("CLI：后端故障退出码非零，并说「这不代表没记过」", async () => {
  mode = "not-array";
  try {
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, ["src/cli/cli.mjs", "search", "部署计划"], {
        cwd: new URL("..", import.meta.url).pathname,
        env: { ...process.env, HOME },
      });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (c) => (stdout += c));
      p.stderr.on("data", (c) => (stderr += c));
      p.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(out.code, 1, `退出码必须是 1，实际 ${out.code}；stdout=${out.stdout}`);
    assert.match(out.stderr, /检索失败/);
    assert.match(out.stderr, /不代表没记过/);
    assert.doesNotMatch(out.stdout, /没找到/, "「没找到」是答案，故障不是答案");
  } finally {
    mode = "ok";
  }
});

test("「这句话全是泛词」和「真的没有」分开说，并且保留检索词", async () => {
  const r = await searchEntries({ q: "我的的", limit: 5, silent: true });
  assert.equal(r.reason, "no-meaningful-terms");
  assert.ok(r.terms.length > 0, "要给调用方留着，才能解释是哪几个词不承载信息");
});

test("空手事件带 reason：自检按它分桶，后端故障不能算进空手率", async () => {
  const dir = join(HOME, ".siyuan-mem", "logs");
  const files = readdirSync(dir);
  assert.ok(files.length >= 1);
  const events = files
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.ev === "memory.miss");
  assert.ok(events.some((e) => e.reason === "sql-not-array"), "故障要留痕");
  assert.ok(events.every((e) => e.reason), "每条空手都要带 reason，缺省值不能再背故障的锅");
});

test("完整日期和年月也能查：不能只认四位年份", async () => {
  // `2026-11-06` 被 termsOf 整段保留，是锚但不是「年份」——上一版只给四位年份
  // 加 date 字段，于是这种查询候选池为空（第十四轮复审实测 0 条）。
  for (const q of ["2025-03-04", "2025-03", "2025/03/04"]) {
    const r = await searchEntries({ q, limit: 5, silent: true });
    assert.deepEqual(ids(r), ["a-2025"], `${q} 应该靠 date 命中`);
    assert.match(lastStmt, /custom-mem-date/, `${q} 的 SQL 要带上 date 字段`);
  }
  // 月份不对的不能混进来：2026-05 的条目不是 2025-03。
  const m = await searchEntries({ q: "2025-05", limit: 5, silent: true });
  assert.deepEqual(ids(m), []);
});

test("单位数月是按数值比的：查 1 月不能返回 11 月", async () => {
  // 库里补零存 2025-11-20，字符串前缀比的话 "2025-11-20".startsWith("2025-1") 为真，
  // 而真正的 1 月 2025-01 反而为假——多召回错的、漏掉对的。
  const jan = await searchEntries({ q: "2025-1", limit: 5, silent: true });
  assert.deepEqual(ids(jan), [], "1 月没有条目，不能把 11 月当成 1 月");
  const mar = await searchEntries({ q: "2025-3", limit: 5, silent: true });
  assert.deepEqual(ids(mar), ["a-2025"], "单位数月份要和补零的库值对上（SQL 层就得补零）");
  // 日也要补零：库值 2026-05-01，查询写 2026-5-1 / 2026/5/1。
  for (const q of ["2026-5-1", "2026/5/1"]) {
    const r = await searchEntries({ q, limit: 5, silent: true });
    assert.deepEqual(ids(r), ["b-2026"], `${q} 应该命中 2026-05-01`);
  }
  const nov = await searchEntries({ q: "2025-11", limit: 5, silent: true });
  assert.deepEqual(ids(nov), ["d-2025"]);
});

test("型号 + 日期：年份不能替 NO.9 过闸", async () => {
  // 假库里有 NO.5 的条目，日期也是 2026 —— 日期锚如果还走 .some()，
  // 「亚狮龙 NO.9 2026 价格」就会拿 NO.5 来答（第十五轮复审 P2）。
  const r = await searchEntries({ q: "亚狮龙 NO.9 2026 价格", limit: 5, silent: true });
  assert.deepEqual(ids(r), [], "问 NO.9 不能拿 NO.5 来答，宁可空手");
  const ok = await searchEntries({ q: "亚狮龙 NO.5 2026 价格", limit: 5, silent: true });
  assert.deepEqual(ids(ok), ["e-2026"], "问 NO.5 还是要正常命中");
});

test("「没问出词」也要留事件：不然 status 的 trivial 桶永远是 0", async () => {
  const before = readEvents().length;
  const r = await searchEntries({ q: "我的的", limit: 5, source: "cli" });
  assert.equal(r.reason, "no-meaningful-terms");
  const added = readEvents().slice(before);
  assert.ok(added.some((e) => e.ev === "memory.miss" && e.reason === "no-meaningful-terms"));
  assert.ok(added.some((e) => e.source === "cli"));

  const before2 = readEvents().length;
  await searchEntries({ q: "？？？", limit: 5, source: "ui" });
  const added2 = readEvents().slice(before2);
  assert.ok(added2.some((e) => e.ev === "memory.miss" && e.reason === "no-terms" && e.source === "ui"));
});

test("P2-1：scoreTerms 是生产真正打分的词集，含日期查询与离线重排一致", async () => {
  // 第十八轮复审：eval-rank 原来用 r.terms（含日期词）离线重排，算出线上从没
  // 算过的分数。searchEntries 现在返回 scoreTerms(= wordGate)，日期词被摘出去。
  const { RANK_WEIGHTS } = await import("../src/core/search.mjs");
  const withDate = await searchEntries({ q: "2025 部署计划", limit: 5, silent: true });
  assert.deepEqual(withDate.scoreTerms, ["部署", "署计", "计划"], "日期词不参与正文打分");
  assert.ok(withDate.terms.includes("2025"), "terms 仍然保留日期词，给人看检索词");

  const pure = await searchEntries({ q: "2025", limit: 5, silent: true });
  assert.deepEqual(pure.scoreTerms, [], "纯日期查询没有正文打分词，只按新近排");

  // 用 scoreTerms 复算，分数必须与生产 score 完全一致（eval-rank 的 base）。
  const recompute = (h, gate) => {
    let s = 0;
    for (const t of gate) {
      const low = String(t).toLowerCase();
      s += Math.min(String(h.text ?? "").toLowerCase().split(low).length - 1, RANK_WEIGHTS.textCap) * RANK_WEIGHTS.textPerHit;
      if (String(h.entity ?? "").toLowerCase().includes(low)) s += RANK_WEIGHTS.entity;
      if (String(h.brief ?? "").toLowerCase().includes(low)) s += RANK_WEIGHTS.brief;
    }
    const days = h.date ? Math.max(0, (Date.now() - Date.parse(h.date + "T00:00:00")) / 86400000) : 60;
    return s - Math.min(days * RANK_WEIGHTS.daily, RANK_WEIGHTS.cap);
  };
  for (const h of withDate.hits) {
    assert.ok(Math.abs(recompute(h, withDate.scoreTerms) - h.score) < 1e-6, `${h.id} 离线分数必须等于生产`);
  }
});

test("P2-1：早退和失败路径也返回 scoreTerms，下游不会拿到 undefined", async () => {
  const trivial = await searchEntries({ q: "？？？", limit: 5, silent: true });
  assert.deepEqual(trivial.scoreTerms, []);
  mode = "not-array";
  const bad = await searchEntries({ q: "部署计划", limit: 5, silent: true });
  assert.ok(Array.isArray(bad.scoreTerms), "失败路径也要守同一份返回契约");
  mode = "ok";
});
