/**
 * 端到端验证：原文归档 → 指针 → 读回 → 实体归一 → 待确认执行。
 *
 * 跑在独立的测试笔记本里，不碰正式库；结束删掉整本。
 * 不调模型（没 key），所以抽取用不到，条目是手写进去的。
 */
import { loadConfig } from "../src/shared/config.mjs";
import { SiYuan } from "../src/shared/siyuan.mjs";
import { Store, ATTR } from "../src/center/store.mjs";
import { archive, readRange, listParts, knownParts, loadRawIndex, saveRawIndex } from "../src/shared/raw.mjs";
import { resolveEntities, loadEntities, applyPending, parsePending, similarity, norm } from "../src/center/entities.mjs";

const NB = "99-记忆测试";
const base = loadConfig();
const cfg = { ...base, siyuan: { ...base.siyuan, notebook: NB } };
const sy = new SiYuan({ baseUrl: cfg.siyuan.baseUrl, timeoutMs: 15000 });
const store = new Store(sy, cfg);

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  ${extra}` : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? `  ${extra}` : ""}`);
  }
};

const turns = [];
const push = (role, text) => turns.push({ role, text });
push("user", "京东京造风盾500 这条裤子防风够吗？北京冬天骑车穿");
push("assistant", "风盾500 的防风靠织物本身密度，不是涂层，洗涤不会衰减；零下五度以内配一条抓绒内搭够用。");
push("user", "那风盾 500 和 500pro 是同一款吗");
push("assistant", "同一款，官方文案写法不一致，参数表完全一样。");
push("user", "洗涤要注意什么");
push("assistant", "冷水加洗衣凝珠、装洗衣袋单独洗就行，别用柔顺剂，会堵住织物孔隙。");
push("user", "UTO 速干衣能内搭吗");
push("assistant", "可以，UTO 这套是聚酯加氨纶，透气比棉好，出汗后不贴背。");
push("user", "骑行通勤单程 10km 够不够");
push("assistant", "单程十公里没问题，回程如果出汗多建议带一件干的内搭换。");
push("user", "裤脚会不会卷进链条");
push("assistant", "直筒版型有风险，建议用束脚带或者选收口款，实测束脚带最省事。");

const session = "e2e-" + Date.now().toString(36);

console.log("1. 建测试笔记本");
const ids = await store.init();
ok("五个文档都在", Boolean(ids.notebook && ids.entries && ids.raw && ids.entities && ids.pending));

console.log("\n2. 归档原文");
const parts = await archive({
  sy,
  cfg,
  ids,
  payload: {
    session_id: session,
    harness: "workbuddy",
    machine: "Mac",
    cwd: "/tmp/e2e",
    date: "2026-10-29",
    turnFrom: 1,
    turns,
  },
  log: (l) => console.log("   " + l),
});
ok("产出一个 part", parts.length === 1 && Boolean(parts[0].path), parts[0]?.path);
ok("轮次 1-12", parts[0]?.from === 1 && parts[0]?.to === 12, `${parts[0]?.from}-${parts[0]?.to}`);

console.log("\n3. 幂等：再归档同一段");
const again = await archive({ sy, cfg, ids, payload: { session_id: session, harness: "workbuddy", machine: "Mac", date: "2026-10-29", turnFrom: 1, turns }, log: () => {} });
ok("第二次不重复上传", again[0]?.skip === true);

console.log("\n4. 本地索引与属性");
const known = await knownParts(sy, ids.raw, { machine: "Mac", harness: "workbuddy", session });
ok("本地索引记下了", known.length === 1 && known[0].path === parts[0].path, JSON.stringify(known));
await new Promise((r) => setTimeout(r, 4000));
const listed = await listParts(sy, ids.raw, session);
ok("思源 SQL 里也能查到（索引异步，等 4 秒）", listed.length === 1, JSON.stringify(listed));
ok("range 与 path 都在属性里", listed[0]?.from === 1 && listed[0]?.to === 12 && listed[0]?.path === parts[0].path);

console.log("\n5. 写一条带指针的条目，再读回原文");
const ptr = `${parts[0].path}#3-4`;
const w = await store.writeEntry(
  { text: "风盾500 和 500pro 是同一款，只是文案不同", entity: "风盾500", type: "fact", confidence: 4 },
  { source: "workbuddy", session, date: "2026-10-29", machine: "Mac", raw: ptr }
);
ok("条目写入", Boolean(w.id) && !w.duplicate, w.id);

const back = await readRange(sy, ptr, { maxChars: 4000 });
ok("按指针读回 2 轮", back.turns.length === 2, `拿到 ${back.turns.length}`);
ok("内容是那一轮的原话", /同一款/.test(back.turns[1]?.text ?? ""), (back.turns[1]?.text ?? "").slice(0, 30));
ok("轮次号对得上", back.turns[0]?.i === 3 && back.turns[1]?.i === 4);

const attrs = await sy.getBlockAttrs(w.id);
ok("条目上有 custom-mem-raw", attrs?.[ATTR.raw] === ptr, attrs?.[ATTR.raw]);

console.log("\n6. 指针失效要能说清");
const gone = await readRange(sy, "assets/mem-raw/nope/gone.jsonl#1-5");
ok("缺失返回 missing 而不是抛错", gone.missing === true);

console.log("\n7. 实体归一（无模型，同一批内也要互相比）");
const localTable = [];
const r1 = await resolveEntities({
  sy, cfg, ids,
  names: ["风盾500", "京造风盾500", "风盾 500", "风盾500pro"],
  useModel: false,
  table: localTable,
  log: (l) => console.log("   " + l),
});
const canon = r1.map.get("风盾500");
ok("三个写法归成一个名字", r1.map.get("京造风盾500") === canon && r1.map.get("风盾 500") === canon, canon);
ok("pro 不合并，独立成实体", r1.map.get("风盾500pro") === "风盾500pro", r1.map.get("风盾500pro"));
ok("建了两个实体块", r1.created.length === 2, r1.created.join(","));
ok("pro 进了待确认", r1.weak.length === 1 && r1.weak[0].name === "风盾500pro", `${r1.weak.length} 组`);

console.log("\n8. 再抽一次，别名要精确命中，且不重复建块");
const r2 = await resolveEntities({ sy, cfg, ids, names: ["风盾 500"], useModel: false, table: localTable });
ok("精确命中，不新建", r2.created.length === 0 && r2.map.get("风盾 500") === canon, String(r2.map.get("风盾 500")));

console.log("\n9. 待确认三态解析");
const table = localTable;
console.log(`   规范名是「${canon}」`);
const md = [
  `- {: id="20260101000000-aaaaaaa"} [ ] 甲 ← ${canon}`,
  `- {: id="20260101000000-bbbbbbb"} [X] 风盾500pro ← ${canon}`,
  `- {: id="20260101000000-ccccccc"} [-] 乙 ← ${canon}`,
  `- {: id="20260101000000-ddddddd"} [X] 没有箭头的一行`,
].join("\n");
const parsed = parsePending(md);
ok("解析出 3 条（没有箭头的忽略）", parsed.length === 3, `${parsed.length}`);
ok("三态都认", parsed.map((p) => p.state).join(",") === "todo,merge,reject", parsed.map((p) => p.state).join(","));
ok("块 id 抠出来了", parsed.every((p) => /^2026/.test(p.blockId)));

console.log("\n10. 相似度打分（回归用）");
ok("包含关系算强命中", similarity("风盾500", "京造风盾500").score >= 0.85, String(similarity("风盾500", "京造风盾500").score));
ok("空格不影响", similarity("风盾500", "风盾 500").score >= 0.85, String(similarity("风盾500", "风盾 500").score));
ok("pro 不自动合并", similarity("风盾500", "风盾500pro").score < 0.85, String(similarity("风盾500", "风盾500pro").score));
ok("完全无关不候选", similarity("风盾500", "UTO速干衣").score < 0.55, String(similarity("风盾500", "UTO速干衣").score));

console.log("\n11. 合并回填");
await new Promise((r) => setTimeout(r, 3000));
const before = await sy.sql(`SELECT id FROM blocks WHERE ial LIKE '%custom-mem-entity="京造风盾500"%'`);
const m = await store.writeEntry({ text: "京造风盾500 这条裤子洗过三次没起球", entity: "京造风盾500", type: "fact" }, { session: session + "-b", machine: "Mac" });
await new Promise((r) => setTimeout(r, 4000));
const merged = await (await import("../src/center/entities.mjs")).mergeEntities(sy, ids.entities, "京造风盾500", canon, { log: (l) => console.log("   " + l) });
ok("回填了条目", merged.changed >= 1, `${merged.changed} 条`);
const after = await sy.getBlockAttrs(w.id);
ok("原条目不受影响", after?.[ATTR.entity] === "风盾500");

console.log("\n清理");
await sy.removeNotebook(ids.notebook);
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
