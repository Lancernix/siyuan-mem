/**
 * 思源能力探底 · 第二轮：AV 视图、资源引用、索引延迟、渲染支持。
 * 仍然只在 99-能力测试 里折腾。
 */
const BASE = "http://127.0.0.1:6806";
const NB = "99-能力测试";

const raw = async (api, body) => {
  const r = await fetch(BASE + api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
};
const post = async (api, body) => {
  const { text } = await raw(api, body);
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`${api} 非 JSON：${text.slice(0, 100)}`);
  }
  if (j.code !== 0) throw new Error(`${api} code=${j.code} ${String(j.msg).slice(0, 120)}`);
  return j.data;
};
const sql = (stmt) => post("/api/query/sql", { stmt });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nb = (await post("/api/notebook/lsNotebooks", {})).notebooks.find((b) => b.name === NB);
const docId = (await sql(`SELECT id FROM blocks WHERE box='${nb.id}' AND type='d' AND hpath='/块模型'`))[0].id;

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

/* ---------- 1. AV（属性视图） ---------- */
console.log("=== 1. AV 视图 ===");
for (const api of ["/api/av/addAVBlock", "/api/av/insertAttributeViewBlock"]) {
  const { status, text } = await raw(api, { parentID: docId });
  console.log(`  ${api} → HTTP ${status}  ${text.slice(0, 160)}`);
}
const avs = await sql(`SELECT id, type FROM blocks WHERE box='${nb.id}' AND type='av'`);
console.log(`  库里现有 av 块：${avs.length}`);
if (avs.length) {
  const view = await raw("/api/av/getAttributeView", { id: avs[0].id });
  console.log(`  getAttributeView → ${view.text.slice(0, 300)}`);
}

/* ---------- 2. 索引延迟 ---------- */
console.log("\n=== 2. 建块后多久能被 SQL 查到 ===");
const t0 = Date.now();
const fresh = await append(docId, `延迟测试 ${t0}`);
let seen = -1;
for (let i = 0; i < 40; i++) {
  const r = await sql(`SELECT id FROM blocks WHERE id='${fresh}'`);
  if (r?.length) {
    seen = Date.now() - t0;
    break;
  }
  await sleep(200);
}
console.log(`  块 ${fresh} → ${seen < 0 ? "8 秒内仍未出现" : `${seen}ms 后可见`}`);

/* ---------- 3. 资源引用判定 ---------- */
console.log("\n=== 3. 块里的 assets 链接算不算「被引用」 ===");
const buf = Buffer.from('{"test":1}\n', "utf8");
const form = new FormData();
form.append("assetsDirPath", "/assets/probe-ref/");
form.append("file[]", new Blob([buf], { type: "application/x-ndjson" }), "ref-test.jsonl");
const up = await (await fetch(BASE + "/api/asset/upload", { method: "POST", body: form })).json();
const assetPath = up.data?.succFiles?.[0]?.path;
console.log(`  上传到 ${assetPath}`);

const unusedApi = async () => {
  const r = await post("/api/asset/getUnusedAssets", {});
  return (r?.unusedAssets ?? []).map((a) => a.path ?? a).filter(Boolean);
};
const before = await unusedApi();
console.log(`  未引用列表里有它：${before.includes(assetPath) ? "是" : "否"}`);

// 在块正文里放一个链接
const linkBlock = await append(docId, `[原文](${assetPath})`);
await sleep(1500);
const afterLink = await unusedApi();
console.log(`  正文里加链接后，还在未引用列表里：${afterLink.includes(assetPath) ? "是（链接不算引用）" : "否（链接算引用）"}`);

// 对比：放进块属性
const attrBlock = await append(docId, "只有属性没有链接");
await post("/api/attr/setBlockAttrs", { id: attrBlock, attrs: { "custom-probe-asset": assetPath } });
await sleep(1500);
const afterAttr = await unusedApi();
console.log(`  只放进块属性后，还在未引用列表里：${afterAttr.includes(assetPath) ? "是（属性不算引用）" : "否（属性算引用）"}`);
console.log(`  （链接块 ${linkBlock} / 属性块 ${attrBlock}）`);

/* ---------- 4. 渲染支持 ---------- */
console.log("\n=== 4. markdown 渲染支持 ===");
const samples = {
  "表格": "| 列1 | 列2 |\n|---|---|\n| a | b |",
  "任务列表": "- [ ] 未做\n- [X] 已做",
  "块引用": `((${linkBlock} "指向上面的链接块"))`,
  "公式": "$$E=mc^2$$",
  "代码块": "```js\nconst a = 1;\n```",
  "mermaid": "```mermaid\ngraph TD\nA-->B\n```",
  "HTML": "<div style='color:red'>红色</div>",
  "脚注": "正文[^1]\n\n[^1]: 脚注内容",
  "高亮": "==高亮==",
  "标签": "#标签/测试#",
};
const made = {};
for (const [name, md] of Object.entries(samples)) {
  try {
    made[name] = await append(docId, md);
    console.log(`  ✅ ${name}`);
  } catch (e) {
    console.log(`  ❌ ${name}：${e.message.slice(0, 80)}`);
  }
}

await sleep(2500);
console.log("\n=== 5. 这些块在库里的真实 type / subtype ===");
for (const [name, id] of Object.entries(made)) {
  const r = await sql(`SELECT type, subtype, length(content) AS len FROM blocks WHERE id='${id}'`);
  console.log(`  ${name.padEnd(6)} type=${r[0]?.type ?? "?"} subtype=${r[0]?.subtype ?? "-"}`);
}

/* ---------- 6. 文档整体替换 ---------- */
console.log("\n=== 6. 文档内容能不能整体替换 ===");
const before6 = await sql(`SELECT count(*) AS n FROM blocks WHERE path LIKE '%${docId}%' AND type!='d'`);
try {
  const again = await post("/api/filetree/createDocWithMd", { notebook: nb.id, path: "/块模型", markdown: "覆盖测试" });
  console.log(`  createDocWithMd 同 path 返回新 id ${again}（${again === docId ? "同一个文档" : "新建了一份"}）`);
} catch (e) {
  console.log(`  createDocWithMd 同 path 报错：${e.message.slice(0, 100)}`);
}
await sleep(500);
const docs = await sql(`SELECT id FROM blocks WHERE box='${nb.id}' AND type='d' AND hpath='/块模型'`);
console.log(`  同名文档数：${docs.length}（之前 ${before6[0].n} 个内容块）`);
