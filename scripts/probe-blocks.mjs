/**
 * 思源能力探底 · 第一轮：块模型。
 *
 * 全部在临时笔记本里做，测完就删，不碰正式库。
 * 目的：搞清楚「什么块能装东西」，因为「把条目挂在标题/话题下面」这个
 * 最基本的结构需求，我到现在都是靠猜的（而且猜错了三次）。
 */
const BASE = "http://127.0.0.1:6806";
const NB = "99-能力测试";

const post = async (api, body) => {
  const r = await fetch(BASE + api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try {
    const j = JSON.parse(text);
    if (j.code !== 0) throw new Error(`${api} code=${j.code} ${j.msg}`);
    return j.data;
  } catch (e) {
    if (e.message.includes("code=")) throw e;
    throw new Error(`${api} 返回非 JSON：${text.slice(0, 120)}`);
  }
};
const sql = (stmt) => post("/api/query/sql", { stmt });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out = [];
const log = (s) => {
  console.log(s);
  out.push(s);
};

// ---------- 建临时笔记本 ----------
const books = (await post("/api/notebook/lsNotebooks", {})).notebooks;
const old = books.find((b) => b.name === NB);
if (old) {
  await post("/api/notebook/removeNotebook", { notebook: old.id });
  await sleep(1500);
}
const created = await post("/api/notebook/createNotebook", { name: NB });
const nbId = created?.notebook?.id ?? created?.id;
log(`临时笔记本 ${nbId}`);

const docId = await post("/api/filetree/createDocWithMd", {
  notebook: nbId,
  path: "/块模型",
  markdown: "# 块模型\n\n这是第一段正文。\n",
});
log(`文档 ${docId}`);
await sleep(800);

// ---------- 造各种块 ----------
/** appendBlock 到文档，返回新块 id */
const append = async (parentID, data, previousID) => {
  const d = await post("/api/block/appendBlock", {
    parentID,
    dataType: "markdown",
    data,
    ...(previousID ? { previousID } : {}),
  });
  const tx = Array.isArray(d) ? d[0] : d;
  return tx?.doOperations?.find((o) => o?.action === "insert" && o?.id)?.id;
};

const h2 = await append(docId, "## 二级标题");
const p = await append(docId, "这是一个普通段落。");
const quote = await append(docId, "> 这是一个引述块。");
const list = await append(docId, "- 列表项一\n- 列表项二");
// 超级块：思源的 markdown 语法是 {{{ ... }}}
let superBlock = null;
try {
  superBlock = await append(docId, "{{{\n超级块里的第一段\n\n超级块里的第二段\n}}}");
} catch (e) {
  log(`建超级块失败：${e.message.slice(0, 100)}`);
}
log(`块 id：h2=${h2} p=${p} quote=${quote} list=${list} super=${superBlock ?? "-"}`);

// 拿各种块的 type（列表要取子项）
await sleep(1000);
const types = await sql(
  `SELECT id, type, parent_id FROM blocks WHERE box='${nbId}' AND type!='d' ORDER BY created`
);
const byId = Object.fromEntries((types ?? []).map((r) => [r.id, r]));
const listItem = (types ?? []).find((r) => r.type === "i");
log(`块的 type：${(types ?? []).map((r) => `${r.type}:${r.id.slice(-4)}`).join(" ")}`);

// ---------- 核心测试：谁能当容器 ----------
log("\n=== 谁能当容器（appendBlock 到它） ===");
const cases = [
  ["文档 doc", docId],
  ["标题 h2", h2],
  ["段落 p", p],
  ["引述块 b", quote],
  ["列表项 i", listItem?.id],
  ["列表块 l", list],
  ["超级块 s", superBlock],
].filter(([, id]) => id);

for (const [name, id] of cases) {
  const t = byId[id]?.type ?? "?";
  try {
    const kid = await append(id, `挂在${name}下面的子块`);
    log(`  ✅ ${name.padEnd(10)} type=${t.padEnd(2)} → 子块 ${kid}`);
  } catch (e) {
    log(`  ❌ ${name.padEnd(10)} type=${t.padEnd(2)} → ${e.message.replace(BASE, "").slice(0, 110)}`);
  }
}

// ---------- 结构长什么样 ----------
await sleep(1200);
const tree = await sql(
  `SELECT id, type, parent_id, substr(content,1,18) AS c FROM blocks WHERE box='${nbId}' AND type!='d' ORDER BY created`
);
log("\n=== 最终块树 ===");
for (const t of tree ?? []) {
  const depth = t.parent_id === docId ? 1 : 2;
  log(`${"  ".repeat(depth)}${t.type} ${String(t.c ?? "").slice(0, 18)}`);
}

console.log("\n--- 报告 ---");
console.log(out.join("\n"));
