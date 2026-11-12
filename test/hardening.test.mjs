/**
 * 第二轮复审（Qoder）里那几条的回归测试。
 *
 * 每一条都对应一个「看不出来」的故障：
 *   - 写库结果未知就重写 → 库里多一条一样的记忆，而且它连 hash 都没有；
 *   - 检索在整段 ial 上匹配 → 查 Mac 能把大半个库翻出来，看着有结果其实全不相干；
 *   - 面板只查 Origin 不查 Host → DNS rebinding 能读到 /api/state；
 *   - 队列非原子写 → 半截 JSON 占住队头，后面的会话永远轮不到；
 *   - 摘要为了一个分组标题去下整个原文附件。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

process.env.HOME = mkdtempSync(join(tmpdir(), "mem-hard-"));

/* ---------------- 检索：相关度下限 ---------------- */

const { relevanceOf, scoreOf, RANK_WEIGHTS } = await import("../src/core/search.mjs");

test("相关度：词只落在原文路径里（已被切掉）就不算命中", () => {
  // 实况：拷一条正文里没有「Mac」、但原文指针里有 /mem-raw/laptop/ 的条目。
  // 修好之后内容里的路径已经被 stripRawLink 切掉，相关度就是 0。
  const row = { text: "端口映射改成 7789 了", brief: "容器端口", date: "2026-11-01" };
  assert.equal(relevanceOf(row, ["Mac"], ""), 0);
  // 正文一次（+2）+ 摘要「容器端口」里也有（+brief 权重）
  assert.equal(relevanceOf(row, ["端口"], ""), 2 + RANK_WEIGHTS.brief);
});

test("总分可以是负的，但相关度不能——负分照样会排在结果里", () => {
  const old = { text: "跟查询无关的一句话", brief: "", date: "2025-01-01" };
  assert.equal(relevanceOf(old, ["bwrap"], ""), 0);
  assert.ok(scoreOf(old, ["bwrap"], "") < 0, "旧条目总分是负的（这是排序用的，不是过滤用的）");
});

/* ---------------- 面板：Host 校验 ---------------- */

const { startUi } = await import("../src/core/ui.mjs");

function get(port, path, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { host: hostHeader } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("面板：Host 不是本机的就拒——DNS rebinding 挡在这里", async () => {
  const ui = startUi({ port: 0 });
  await new Promise((r) => setTimeout(r, 30));
  try {
    const ok = await get(ui.port, "/", `127.0.0.1:${ui.port}`);
    assert.equal(ok.status, 200);
    // 攻击者把 evil.com 解析到 127.0.0.1：浏览器认为同源，读取不受限，
    // 但 Host 头老老实实写着 evil.com。
    const bad = await get(ui.port, "/", `evil.com:${ui.port}`);
    assert.equal(bad.status, 403);
    assert.match(bad.body, /Host/);
    // /api/state 是纯 GET、没有 Origin 可以查，正是原来最容易被读走的那一个。
    const state = await get(ui.port, "/api/state", "evil.com");
    assert.equal(state.status, 403);
    const localhost = await get(ui.port, "/", `localhost:${ui.port}`);
    assert.equal(localhost.status, 200);
  } finally {
    await ui.close();
  }
});

/* ---------------- 队列：原子写 ---------------- */

const { drop } = await import("../src/core/inbox.mjs");
const { INBOX_DIR, GROUPS_PATH } = await import("../src/util/config.mjs");

test("队列写入是原子的：不留下半截文件，权限 0600", () => {
  const { file } = drop({ session_id: "s-atomic", turns: [{ role: "user", text: "x" }] });
  assert.ok(!readdirSync(INBOX_DIR).some((f) => f.includes(".tmp")), "临时文件要 rename 掉");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).session_id, "s-atomic");
  assert.equal(statSync(file).mode & 0o077, 0, "队列里是会话原文，同机其他用户不该能读");
});

/* ---------------- 写库：结果未知时不许重写 ---------------- */

const { Store } = await import("../src/core/store.mjs");

const cfgOf = () => ({
  siyuan: {
    baseUrl: "http://fake:6806",
    token: "",
    notebook: "Mem",
    notebookId: "nb1",
    docs: { entries: "01-条目", entities: "02-实体", pending: "03-实体待确认" },
    groupEntries: true,
    partition: "none",
    logChanges: false,
  },
});

/**
 * 假思源。`failTailOnce` 用来造「appendBlock 成功了、读回来那一步卡住」：
 * 这是最恶心的一种失败——写进去了但调用方不知道。
 *
 * 行为按真思源来：往文档追加 `- 内容` 且带 previousID 时，长出来的是一个**列表块**，
 * 列表里是第一项，项下面挂段落。占位 id 之类的细节不影响这里要验的东西。
 */
function fakeSy({ failTailOnce = false } = {}) {
  const seq = [];
  const kids = new Map();
  const texts = new Map();
  let tailFailed = false;
  const push = (parent, block) => kids.set(parent, [...(kids.get(parent) ?? []), block]);
  const sy = {
    calls: seq,
    listNotebooks: async () => [{ id: "nb1", name: "Mem" }],
    docIdByHPath: async () => null,
    createDocWithMd: async (_nb, path) => `doc:${path}`,
    sql: async () => [],
    updateBlock: async () => {},
    setBlockAttrs: async () => {},
    getBlockAttrs: async () => ({}),
    deleteBlock: async () => {},
    getAsset: async () => {
      throw new Error("有 project 属性就不该去下附件");
    },
    appendBlock: async (parent, data, _dt, opts) => {
      seq.push({ parent, data });
      if (parent === "l-gone") throw new Error("tree not found");
      const n = seq.length;
      if (data.startsWith("- ") && opts?.previousID) {
        const listId = `l${n}`;
        push(parent, { id: listId, type: "l" });
        const itemId = `i${n}`;
        push(listId, { id: itemId, type: "i" });
        texts.set(itemId, data);
        const paraId = `${itemId}p`;
        push(itemId, { id: paraId, type: "p" });
        texts.set(paraId, data);
        return listId;
      }
      const id = `b${n}`;
      push(parent, { id, type: data.startsWith("- ") ? "i" : "h" });
      texts.set(id, data);
      if (data.startsWith("- ")) push(id, [{ id: `${id}p`, type: "p" }]);
      return id;
    },
    childBlocks: async (id) => {
      // 只让「列表读回来」失败一次：正好是 append 成功之后那一步。
      if (failTailOnce && !tailFailed && id.startsWith("l") && (kids.get(id)?.length ?? 0) > 0) {
        tailFailed = true;
        throw new Error("读回来超时 5000ms");
      }
      return kids.get(id) ?? [];
    },
    getBlockKramdown: async (id) => texts.get(id) ?? "",
  };
  return sy;
}

test("写进去但读回来的那一步卡住：认领它，不能再写一条", async () => {
  const sy = fakeSy({ failTailOnce: true });
  const store = new Store(sy, cfgOf());
  await store.init();

  const meta = { session: "sess-1", project: "proj", date: "2026-11-10" };
  const a = await store.writeEntry({ text: "第一条结论", entity: "proj" }, meta);
  assert.ok(a.id && !a.duplicate);

  const before = sy.calls.length;
  const b = await store.writeEntry({ text: "第二条结论", entity: "proj" }, meta);
  assert.ok(b.id, "要么写成功，要么认领回来——不能抛出去");
  // 修好之前走的是「重建分组再写一遍」：多两条 appendBlock（标题 + 条目），
  // 库里就是两条一模一样的「第二条结论」，而且都没有 custom-mem-hash。
  assert.equal(sy.calls.length - before, 1, "只该有那一次追加，不该重建分组");
});

test("锚点确实没了（分组标题被手删）：仍然要重建，不能把这一条丢在门外", async () => {
  const sy = fakeSy();
  const store = new Store(sy, cfgOf());
  await store.init();
  // 预置一条指向已删列表的分组记录：不是本进程写的，所以不会被「刚写过」的
  // 宽限期挡住，走的正是「查一下、真没了、重建」那条路。
  writeFileSync(GROUPS_PATH, JSON.stringify({ "sess-gone": { heading: "h-gone", list: "l-gone", doc: "doc:/01-条目" } }));

  const before = sy.calls.length;
  const r = await store.writeEntry({ text: "第二条结论" }, { session: "sess-gone", project: "proj", date: "2026-11-10" });
  assert.ok(r.id, "重建分组后应该写成功");
  assert.ok(sy.calls.length - before >= 2, "重建 = 新标题 + 新条目");
});

/* ---------------- 摘要：项目名读属性，不下附件 ---------------- */

const { collect } = await import("../src/core/digest.mjs");

test("摘要的项目名直接读属性：不再为标题下载整个原文附件", async () => {
  const sy = {
    sql: async () => [
      {
        id: "p1",
        content: "端口映射改成 7789 了",
        ial: 'custom-mem-hash="h1" custom-mem-status="current" custom-mem-session="s1" custom-mem-project="siyuan-mem" custom-mem-date="2026-11-10" custom-mem-raw="assets/mem-raw/laptop/dsh/s1.p1.jsonl#1-20"',
      },
    ],
    getAsset: async () => {
      throw new Error("有 project 属性就不该去下附件");
    },
  };
  const groups = await collect({ sy, ids: { entries: "doc-e" } });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].project, "siyuan-mem");
});
