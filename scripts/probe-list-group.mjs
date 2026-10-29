/** 验证：列表项能不能当容器，把条目挂在它下面。 */
const BASE = "http://127.0.0.1:6806";
const post = async (api, body) => {
  const r = await fetch(BASE + api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  const j = JSON.parse(t);
  if (j.code !== 0) throw new Error(`${api} code=${j.code} ${j.msg}`);
  return j.data;
};
const sql = (s) => post("/api/query/sql", { stmt: s });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const books = (await post("/api/notebook/lsNotebooks", {})).notebooks;
const nb = await post("/api/notebook/createNotebook", { name: "99-列表测试" });
const nbId = nb?.notebook?.id ?? nb?.id;
const doc = await post("/api/filetree/createDocWithMd", { notebook: nbId, path: "/t", markdown: "# t\n" });
await sleep(800);

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

const group = await append(doc, "- 2026-10-29 · MiniWMS（测试）");
console.log("分组项 id:", group);
await sleep(600);

try {
  const a = await append(group, "第一条记忆正文");
  const b = await append(group, "第二条记忆正文");
  console.log("子块:", a, b);
} catch (e) {
  console.log("挂子块失败:", e.message.slice(0, 140));
}

await sleep(3000);
const tree = await sql(
  `SELECT id,type,parent_id,subtype,substr(content,1,22) AS c FROM blocks WHERE box='${nbId}' AND type!='d' ORDER BY created`
);
console.log("块树:");
for (const t of tree) {
  console.log(" ", `${t.type}${t.subtype ? "/" + t.subtype : ""}`.padEnd(5), t.id.slice(-5), "parent=" + String(t.parent_id).slice(-5), "|", String(t.c ?? "").slice(0, 22));
}

// 再验证：在分组项后面插一条同级条目（不该进组）
const sibling = await append(doc, "这条应该在组外面", group);
console.log("同级项:", sibling);
await sleep(2000);
const tree2 = await sql(`SELECT id,type,parent_id,substr(content,1,22) AS c FROM blocks WHERE box='${nbId}' AND type!='d' ORDER BY created`);
console.log("\n插同级后:");
for (const t of tree2) {
  console.log(" ", t.type.padEnd(2), t.id.slice(-5), "parent=" + String(t.parent_id).slice(-5), "|", String(t.c ?? "").slice(0, 22));
}

await post("/api/notebook/removeNotebook", { notebook: nbId });
console.log("\n已清理测试笔记本");
