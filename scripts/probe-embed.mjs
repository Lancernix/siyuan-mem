/**
 * 嵌入块（NodeBlockQueryEmbed）细探。
 *
 * 这是这一轮最有价值的发现：`{{select …}}` 能建出 type=query_embed 的块，
 * 它是**动态执行 SQL 并渲染**的。如果可用，就不用再"重建文档"了——
 * 之前踩的那些坑（createDocWithMd 不覆盖、块索引异步删不干净）全绕开。
 */
import { SiYuan } from "../src/util/siyuan.mjs";

const BASE = "http://127.0.0.1:6806";
const sy = new SiYuan({ baseUrl: BASE, timeoutMs: 20000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (api, body) => {
  const r = await fetch(BASE + api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
};
const NB = "99-嵌入块测试";
const ok = (n, p, note = "") => console.log(`  ${p ? "✓" : "✗"} ${n}${note ? `  ${note}` : ""}`);

async function main() {
  const old = (await post("/api/notebook/lsNotebooks", {})).data.notebooks.find((b) => b.name === NB);
  if (old) await post("/api/notebook/removeNotebook", { notebook: old.id });
  const nb = (await post("/api/notebook/createNotebook", { name: NB })).data;
  const nbId = nb.notebook?.id ?? nb.id;
  const doc = (await post("/api/filetree/createDocWithMd", { notebook: nbId, path: "/t", markdown: "# t\n" })).data;
  await sleep(1000);

  // 造 5 条带属性的块，模拟「记忆条目」
  await post("/api/block/appendBlock", {
    parentID: doc,
    dataType: "markdown",
    data: "索引判据是查询真会发生且当前没索引\n\nTypeScript 锁 6.0.3\n\n路由用路径前缀带仓码\n\nSKU 接口统一扁平 REST\n\n状态码规则 URL 缺失返 404",
  });
  await sleep(3500);
  const ps = (await post("/api/query/sql", { stmt: `SELECT id, content FROM blocks WHERE path LIKE "%${doc}%" AND type="p"` })).data;
  const entities = ["订货系统", "订货系统", "订货系统", "订货系统", "订货系统"];
  const types = ["decision", "fact", "decision", "decision", "decision"];
  for (let i = 0; i < ps.length; i++) {
    await post("/api/attr/setBlockAttrs", {
      id: ps[i].id,
      attrs: {
        "custom-mem-entity": entities[i],
        "custom-mem-type": types[i],
        "custom-mem-date": "2026-10-30",
        "custom-mem-brief": String(ps[i].content).slice(0, 16),
      },
    });
  }
  await sleep(3000);
  console.log("造了", ps.length, "条带属性的块");

  console.log("\n1. 明文 SQL 嵌入");
  {
    const md = `{{select content, ial from blocks where box='${nbId}' and ial like '%custom-mem-entity%' limit 10}}`;
    await post("/api/block/appendBlock", { parentID: doc, dataType: "markdown", data: md });
    await sleep(2500);
    const embeds = (await post("/api/query/sql", { stmt: `SELECT id, type FROM blocks WHERE path LIKE "%${doc}%" AND type="query_embed"` })).data;
    ok("建出 query_embed", embeds.length > 0, `${embeds.length} 个，id=${embeds[0]?.id ?? "-"}`);
    if (embeds.length) {
      const dom = await post("/api/block/getBlockDOM", { id: embeds[0].id });
      const d = String(dom.data?.dom ?? dom.data ?? "");
      ok("DOM 里带查询结果", d.includes("订货系统") || d.includes("索引判据"), d.slice(0, 80));
      const k = await post("/api/block/getBlockKramdown", { id: embeds[0].id });
      console.log("   kramdown:", String(k.data?.kramdown ?? "").slice(0, 120));
    }
  }

  console.log("\n2. 占位符嵌入（只指定 id 和渲染参数）");
  {
    // 思源的嵌入块还有另一种形态：{{select ... }} 之外，块属性里存 stmt + 渲染参数
    const md = `{{select * from blocks where box='${nbId}' and type='p' order by created desc}}`;
    const r = await post("/api/block/appendBlock", { parentID: doc, dataType: "markdown", data: md });
    ok("追加成功", r.code === 0, r.msg ?? "");
    await sleep(2000);
    const embeds = (await post("/api/query/sql", { stmt: `SELECT id FROM blocks WHERE path LIKE "%${doc}%" AND type="query_embed"` })).data;
    if (embeds.length >= 2) {
      const k = await post("/api/block/getBlockKramdown", { id: embeds[1].id });
      console.log("   第二个嵌入块的 ial:", String(k.data?.kramdown ?? "").slice(0, 200));
    }
  }

  console.log("\n3. 嵌入块能不能带层级（列表渲染）");
  {
    // 思源支持 `{{select ... }}` 后跟渲染配置，实测看有没有 list 形态
    const md = `{{select content from blocks where box='${nbId}' and type='p' limit 3}}`;
    const r = await post("/api/block/appendBlock", { parentID: doc, dataType: "markdown", data: md });
    await sleep(2000);
    const dom = await post("/api/block/getBlockDOM", { id: doc });
    const d = String(dom.data?.dom ?? dom.data ?? "");
    const cnt = (d.match(/NodeBlockQueryEmbed/g) ?? []).length;
    ok("文档 DOM 里有嵌入块节点", cnt > 0, `${cnt} 处`);
    // 看渲染出来的表格结构
    const tableIdx = d.indexOf("NodeBlockQueryEmbed");
    if (tableIdx >= 0) console.log("   DOM 片段:", d.slice(tableIdx, tableIdx + 320).replace(/\s+/g, " "));
  }

  console.log("\n清理");
  await post("/api/notebook/removeNotebook", { notebook: nbId });
  await sleep(1500);
  const left = (await post("/api/notebook/lsNotebooks", {})).data.notebooks.filter((b) => b.name === NB);
  ok("已删", left.length === 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
