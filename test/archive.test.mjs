/**
 * 归档：状态语义 + 选范围 + 两个刹车。
 *
 * 这里测的不是「能不能写进去」（那要连思源），是三件更容易写错的事：
 * 1. archived 必须和 superseded 分开，撤销要回到归档前的状态——一条被取代过的
 *    条目撤销成 current，等于把旧结论复活；
 * 2. 整话题 / 整会话超过 10 条必须先给清单，不能因为模型「顺手」就清空一个话题；
 * 3. 没对上条目、没给范围、后端出错，三种结局必须互相分得开——把它们都渲染成
 *    「没有」的话，模型会告诉用户「确实没记过」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "mem-archive-"));

const { Store } = await import("../src/core/store.mjs");
const { archiveEntries, shortRef } = await import("../src/core/archive.mjs");

const cfgOf = () => ({
  siyuan: {
    baseUrl: "http://fake:6806",
    token: "",
    notebook: "Mem",
    notebookId: "nb1",
    // 关掉变更日志：开了就要解析三个文档 id，和这里要验的东西无关。
    logChanges: false,
    docs: { entries: "01-条目", entities: "02-实体", pending: "03-实体待确认" },
  },
});

/** 假思源：只认归档用到的几种查询，写属性记下来。 */
function fakeSy(rows = []) {
  const writes = [];
  const sqls = [];
  return {
    writes,
    sqls,
    listNotebooks: async () => [{ id: "nb1", name: "Mem" }],
    createNotebook: async () => "nb1",
    docIdByHPath: async () => null,
    createDocWithMd: async (_nb, path) => `doc:${path}`,
    updateBlock: async () => {},
    appendBlock: async () => {},
    setBlockAttrs: async (id, attrs) => void writes.push({ id, attrs }),
    sql: async (q) => {
      sqls.push(q);
      const suf = q.match(/substr\(id, -(\d+)\)='([^']+)'/);
      if (suf) return rows.filter((r) => r.id.slice(-Number(suf[1])) === suf[2]).map((r) => ({ id: r.id }));
      const exact = q.match(/AND id='([^']+)' LIMIT 2/);
      if (exact) return rows.filter((r) => r.id === exact[1]).map((r) => ({ id: r.id }));
      const inList = q.match(/id IN \(([^)]+)\)/);
      if (inList) {
        const ids = [...inList[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
        return rows.filter((r) => ids.includes(r.id));
      }
      if (/SUM\(CASE/.test(q)) return [{ n_current: 1, n_superseded: 2, n_archived: 3, n_total: 6 }];
      // 选范围（按话题/会话）走的就是这一条：全量返回，条数由 fixture 决定。
      if (/FROM blocks\s+WHERE box=/.test(q)) return rows;
      // 剩下的（#inNotebook 之类）：当作「没有」。
      return [];
    },
  };
}

const row = (id, entity, status = "current", extra = "") => ({
  id,
  content: `${entity} 的结论 原文 assets/mem-raw/x.jsonl#1-2`,
  ial: `{: id="${id}" custom-mem-hash="h${id.slice(-3)}" custom-mem-status="${status}" custom-mem-entity="${entity}" custom-mem-date="2026-11-1${id.slice(-1)}" custom-mem-brief="${entity}摘要"${extra}}`,
});

test("归档写 status / priorStatus / 原因，已经是 archived 的跳过", async () => {
  const sy = fakeSy([row("20261118160331-aaaaaaa", "骑行"), row("20261118160332-bbbbbbb", "骑行", "archived")]);
  const store = new Store(sy, cfgOf());
  const r = await store.archive(["20261118160331-aaaaaaa", "20261118160332-bbbbbbb"], { reason: "试用" });

  assert.deepEqual(r.changed, ["20261118160331-aaaaaaa"]);
  assert.equal(r.skipped.length, 1);
  const w = sy.writes[0];
  assert.equal(w.attrs["custom-mem-status"], "archived");
  // 归档前的状态必须记下来：撤销要靠它回到原位。
  assert.equal(w.attrs["custom-mem-prior-status"], "current");
  assert.equal(w.attrs["custom-mem-archive-reason"], "试用");
  assert.match(w.attrs["custom-mem-archived-at"], /^\d{4}-\d{2}-\d{2}$/);
});

test("撤销回到归档前的状态：被取代过的不能变回 current", async () => {
  const sy = fakeSy([
    row("20261118160331-ccccccc", "骑行", "archived", ' custom-mem-prior-status="superseded"'),
    row("20261118160332-ddddddd", "骑行", "archived", ' custom-mem-prior-status="current"'),
    row("20261118160333-eeeeeee", "骑行", "current"),
  ]);
  const store = new Store(sy, cfgOf());
  const r = await store.restore(["20261118160331-ccccccc", "20261118160332-ddddddd", "20261118160333-eeeeeee"]);

  assert.deepEqual(r.changed, ["20261118160331-ccccccc", "20261118160332-ddddddd"]);
  assert.equal(r.skipped.length, 1, "没归档的不能撤销");
  assert.equal(sy.writes[0].attrs["custom-mem-status"], "superseded");
  assert.equal(sy.writes[1].attrs["custom-mem-status"], "current");
  // 归档痕迹要清掉，否则「状态是 current 但带归档原因」的记录会骗过下次审计。
  assert.equal(sy.writes[0].attrs["custom-mem-archive-reason"], "");
});

test("短引用解析：全 id、末 7 位、对不上、撞车分得开", async () => {
  const sy = fakeSy([
    row("20261118160331-aaaaaaa", "A"),
    row("20261118160332-bbbbbbb", "B"),
    row("20261118160333-aaaaaaa", "C"),
  ]);
  const store = new Store(sy, cfgOf());

  const one = await store.resolveIds(["20261118160331-aaaaaaa", "bbbbbbb"]);
  assert.deepEqual(one.ids, ["20261118160331-aaaaaaa", "20261118160332-bbbbbbb"]);
  assert.deepEqual(one.bad, []);

  const two = await store.resolveIds(["zzzzzzz"]);
  assert.deepEqual(two.bad, ["zzzzzzz"]);

  const three = await store.resolveIds(["aaaaaaa"]);
  assert.deepEqual(three.dup, ["aaaaaaa"], "撞车必须报歧义，不能挑一条");
});

test("stats 里单独给 archived 一栏，否则「记忆怎么少了」对不上账", async () => {
  const store = new Store(fakeSy([]), cfgOf());
  const s = await store.stats();
  assert.deepEqual(s, { current: 1, superseded: 2, archived: 3, total: 6 });
});

// ---- 选范围与两个刹车（open 注入，不碰网络） ----

function fakeOpen(rows, { archived = [] } = {}) {
  const calls = { archive: [], restore: [] };
  const store = {
    docIds: async () => ({ notebook: "nb1" }),
    resolveIds: async (refs) => {
      const ids = [];
      const bad = [];
      const dup = [];
      for (const r of refs) {
        const key = String(r).replace(/^#/, "");
        const hit = rows.filter((x) => x.id === key || shortRef(x.id) === key);
        if (hit.length === 1) ids.push(hit[0].id);
        else if (hit.length > 1) dup.push(key);
        else bad.push(key);
      }
      return { ids, bad, dup };
    },
    archive: async (ids, { reason }) => {
      calls.archive.push({ ids, reason });
      return { changed: ids, skipped: [] };
    },
    restore: async (ids) => {
      calls.restore.push(ids);
      return { changed: ids, skipped: [] };
    },
    listArchived: async () => archived,
  };
  return { deps: { open: () => ({ store, sy: fakeSy(rows), cfg: cfgOf() }) }, calls };
}

const many = (n) =>
  Array.from({ length: n }, (_, i) => row(`2026111816${String(1000 + i)}-a${String(i).padStart(6, "0")}`, "小账本"));

test("整话题超过 10 条：只回预览，不写", async () => {
  const rows = many(12);
  const { deps, calls } = fakeOpen(rows);
  const r = await archiveEntries({ topic: "小账本" }, deps);

  assert.equal(r.mode, "preview");
  assert.equal(r.needsConfirm, true);
  assert.equal(r.count, 12);
  assert.equal(r.items.length, 10, "预览只列前 10 条，别把上下文塞满");
  assert.equal(calls.archive.length, 0, "没确认就不许写");
  assert.match(r.note, /confirm/);
});

test("带 confirm 才真的写，原因一路带到属性里", async () => {
  const { deps, calls } = fakeOpen(many(12));
  const r = await archiveEntries({ topic: "小账本", reason: "试用", confirm: true }, deps);

  assert.equal(r.mode, "archive");
  assert.equal(r.count, 12);
  assert.equal(calls.archive.length, 1);
  assert.equal(calls.archive[0].reason, "试用");
});

test("用 ids 点名时不设门槛：用户指到哪条就是哪条", async () => {
  const rows = many(12);
  const { deps, calls } = fakeOpen(rows);
  const ids = rows.slice(0, 11).map((x) => shortRef(x.id));
  const r = await archiveEntries({ ids }, deps);

  assert.equal(r.mode, "archive");
  assert.equal(r.count, 11);
  assert.equal(calls.archive.length, 1);
});

test("话题走实体名（含别名）：SQL 里落到 custom-mem-entity 上", async () => {
  const rows = [row("20261118160331-aaaaaaa", "骑行")];
  const { deps } = fakeOpen(rows);
  const r = await archiveEntries({ topic: "骑行" }, deps);
  assert.equal(r.mode, "archive");
  assert.equal(r.count, 1);
});

test("一条都没对上：说清楚是哪个范围空的，别装成「归档成功」", async () => {
  const { deps, calls } = fakeOpen([]);
  const r = await archiveEntries({ topic: "不存在的" }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.count, 0);
  assert.match(r.note, /话题「不存在的」/);
  assert.equal(calls.archive.length, 0);
});

test("什么范围都没给：直接拒绝，绝不落到全库", async () => {
  const { deps, calls } = fakeOpen(many(3));
  const r = await archiveEntries({}, deps);
  assert.equal(r.ok, false);
  assert.match(r.note, /ids/);
  assert.equal(calls.archive.length, 0);
});

test("撤销必须点名，不许按话题整批捞回来", async () => {
  const { deps, calls } = fakeOpen(many(3));
  const r = await archiveEntries({ undo: true }, deps);
  assert.equal(r.ok, false);
  assert.equal(calls.restore.length, 0);

  const ok = await archiveEntries({ undo: true, ids: [shortRef(many(3)[0].id)] }, deps);
  assert.equal(ok.mode, "undo");
  assert.equal(calls.restore.length, 1);
});

test("列归档带短引用和原因，方便照着撤销", async () => {
  const { deps } = fakeOpen([], {
    archived: [
      { id: "20261118160331-aaaaaaa", entity: "小账本", date: "2026-11-01", brief: "试用", reason: "噪音", archivedAt: "2026-11-18", text: "" },
    ],
  });
  const r = await archiveEntries({ list: true }, deps);
  assert.equal(r.mode, "list");
  assert.equal(r.items[0].ref, "aaaaaaa");
  assert.equal(r.items[0].reason, "噪音");
});

test("后端出错走 failed：调用方要报错，不能渲染成「没有这些条目」", async () => {
  const deps = {
    open: () => ({
      store: { docIds: async () => { throw new Error("连不上思源"); } },
      sy: fakeSy([]),
      cfg: cfgOf(),
    }),
  };
  const r = await archiveEntries({ topic: "x" }, deps);
  assert.equal(r.failed, true);
  assert.match(r.detail, /连不上思源/);
});
