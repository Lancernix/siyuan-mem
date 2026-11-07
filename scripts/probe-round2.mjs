/**
 * 第二轮探底：验证第一轮没覆盖的几条。
 *
 * 全部在临时笔记本里做，跑完自删，不碰正式库。
 * 每条结论都打印实测依据，方便以后复查。
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

const ok = (name, pass, note = "") => console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? `  ${note}` : ""}`);
const NB = "99-能力测试2";

async function main() {
  const old = (await post("/api/notebook/lsNotebooks", {})).data.notebooks.find((b) => b.name === NB);
  if (old) await post("/api/notebook/removeNotebook", { notebook: old.id });
  const nb = await post("/api/notebook/createNotebook", { name: NB });
  const nbId = nb.data?.notebook?.id ?? nb.data?.id;
  const doc = await post("/api/filetree/createDocWithMd", { notebook: nbId, path: "/probe", markdown: "# probe\n" });
  await sleep(1000);
  console.log("临时库:", nbId, "文档:", doc.data);

  const sql = (stmt) => post("/api/query/sql", { stmt }).then((r) => r.data ?? []);

  /* ---- 1. 嵌入块：SQL 驱动、自动更新的动态视图 ---- */
  console.log("\n1. 嵌入块（动态查询）");
  {
    // 在 99 库里造两条带属性的块
    const a = await post("/api/block/appendBlock", {
      parentID: doc.data,
      dataType: "markdown",
      data: "条目甲\n\n条目乙",
    });
    await sleep(1500);
    const kids = await sql(`SELECT id, content FROM blocks WHERE path LIKE "%${doc.data}%" AND type="p"`);
    await post("/api/attr/setBlockAttrs", {
      id: kids[0].id,
      attrs: { "custom-probe": "yes" },
    });
    const embed = `{{select content from blocks where box='${nbId}' and ial like '%custom-probe%'}}`;
    try {
      await post("/api/block/appendBlock", { parentID: doc.data, dataType: "markdown", data: embed });
      await sleep(2000);
      const rows = await sql(`SELECT type, count(*) AS n FROM blocks WHERE path LIKE "%${doc.data}%" GROUP BY type`);
      ok("嵌入块语法 {{select …}}", true, JSON.stringify(rows));
      // 看渲染出来有没有内容
      const dom = await post("/api/block/getBlockDOM", { id: doc.data });
      ok("嵌入块渲染成节点", String(dom.data ?? "").includes("NodeBlockQueryEmbed"), "含 NodeBlockQueryEmbed");
    } catch (e) {
      ok("嵌入块语法", false, e.message.slice(0, 80));
    }
  }

  /* ---- 2. 引述块 / 超级块 能否当容器 ---- */
  console.log("\n2. 引述块与超级块当容器");
  {
    const quoteMd = "> 引述块第一行\n>\n> 引述块第二行";
    try {
      const qid = await post("/api/block/appendBlock", { parentID: doc.data, dataType: "markdown", data: quoteMd });
      await sleep(1200);
      const qblocks = await sql(`SELECT id, type FROM blocks WHERE path LIKE "%${doc.data}%" AND type="b"`);
      ok("引述块 b 建出来了", qblocks.length > 0, JSON.stringify(qblocks[0] ?? {}));
      if (qblocks.length) {
        const r = await post("/api/block/appendBlock", {
          parentID: qblocks[0].id,
          dataType: "markdown",
          data: "往引述块里塞一行",
        });
        ok("引述块可以当 parent 挂子块", r.code === 0, r.code !== 0 ? r.msg : "");
      }
    } catch (e) {
      ok("引述块", false, e.message.slice(0, 80));
    }

    const superMd = "{{{row\n第一栏\n---\n第二栏\n}}}";
    try {
      await post("/api/block/appendBlock", { parentID: doc.data, dataType: "markdown", data: superMd });
      await sleep(1500);
      const sb = await sql(`SELECT id, type FROM blocks WHERE path LIKE "%${doc.data}%" AND type="s"`);
      ok("超级块 s 建出来了", sb.length > 0, JSON.stringify(sb[0] ?? {}));
    } catch (e) {
      ok("超级块", false, e.message.slice(0, 80));
    }
  }

  /* ---- 3. 块属性里的资源路径算不算被引用 ---- */
  console.log("\n3. 属性里的资源路径 vs 正文链接");
  {
    // 上传两个文件，一个只放属性、一个只放正文
    const mk = async (name) => {
      const blob = new Blob([`probe ${name} ${Date.now()}`], { type: "text/plain" });
      const fd = new FormData();
      fd.append("assetsDirPath", "/assets/probe2/");
      fd.append("file[]", blob, `${name}.txt`);
      const r = await fetch(BASE + "/api/asset/upload", { method: "POST", body: fd });
      const j = await r.json();
      return j.data?.succFiles?.[0]?.path ?? "";
    };
    const p1 = await mk("attr-only");
    const p2 = await mk("body-link");
    console.log("   上传:", p1, "|", p2);

    const b = await post("/api/block/appendBlock", {
      parentID: doc.data,
      dataType: "markdown",
      data: `只放属性\n\n[正文链接](${p2})`,
    });
    await sleep(1500);
    const ps = await sql(`SELECT id, content FROM blocks WHERE path LIKE "%${doc.data}%" AND type="p" ORDER BY created`);
    if (ps.length >= 2) {
      await post("/api/attr/setBlockAttrs", { id: ps[0].id, attrs: { "custom-probe-asset": p1 } });
    }
    await sleep(3000);
    const out = await fetch(BASE + "/api/asset/getUnusedAssets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((r) => r.json());
    const list = JSON.stringify(out.data ?? []);
    ok("正文链接不算未引用", !list.includes("body-link"), list.includes("body-link") ? "被列入未引用" : "");
    ok("属性里的路径算未引用（保守假设成立）", list.includes("attr-only"), list.includes("attr-only") ? "" : "也未被列入，说明属性也算引用");
  }

  /* ---- 4. 跨笔记本块引用 ---- */
  console.log("\n4. 跨笔记本块引用");
  {
    const other = await post("/api/notebook/createNotebook", { name: `${NB}-b` });
    const otherId = other.data?.notebook?.id ?? other.data?.id;
    const docB = await post("/api/filetree/createDocWithMd", { notebook: otherId, path: "/b", markdown: "# b\n" });
    await sleep(1200);
    const rows = await sql(`SELECT id FROM blocks WHERE path LIKE "%${doc.data}%" AND type="p" LIMIT 1`);
    if (rows.length) {
      await post("/api/block/appendBlock", {
        parentID: docB.data,
        dataType: "markdown",
        data: `跨库引用 ((${rows[0].id} "跨库"))`,
      });
      await sleep(1500);
      const dom = await post("/api/block/getBlockDOM", { id: docB.data });
      ok("跨库块引用能渲染", String(dom.data ?? "").includes("NodeBlockRef"), "");
    }
    await post("/api/notebook/removeNotebook", { notebook: otherId });
  }

  /* ---- 5. 清理 ---- */
  console.log("\n清理");
  await post("/api/notebook/removeNotebook", { notebook: nbId });
  const left = (await post("/api/notebook/lsNotebooks", {})).data.notebooks.filter((b) => b.name.startsWith(NB));
  ok("临时库已删", left.length === 0, left.map((b) => b.name).join(","));
}

main().catch((e) => {
  console.error("探测失败:", e);
  process.exit(1);
});
