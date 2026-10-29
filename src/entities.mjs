/**
 * 实体归一。
 *
 * 问题：模型抽 entity 是自由的，同一款裤子会变成「风盾500」「风盾 500」「京造风盾500」。
 * 检索取的是 entity 字段，名字一散，查一个漏两个。
 *
 * 做法是三道闸，从便宜到贵：
 *   1. 抽取时把已有实体清单塞进 prompt —— 从源头减少新名字（预防）
 *   2. 抽完在本地做字符串匹配 —— 包含关系、编辑距离、公共子串，零成本（兜底）
 *   3. 有候选但拿不准的，攒一批问一次模型，只回答下标（判重）
 *
 * 判出来之后不是自动合并：合并错了要重灌才能修，代价远高于留两个名字。
 * 所以「模型说 same 但字面差得远」的进 05-实体待确认，等人勾一下。
 * 人勾选已经在思源里做完判断，合并本身是纯机械操作，不再调模型。
 */

import { chat } from "./llm.mjs";
import { hasModel } from "./llm.mjs";
import { NEGATIVES_PATH, ensureDirs } from "./config.mjs";
import { readFileSync, writeFileSync } from "node:fs";

/** 强命中阈值：到这个分就直接当同一个东西，不问模型。 */
const STRONG = 0.85;
/** 弱命中阈值：到这儿才值得问一次模型。 */
const WEAK = 0.55;

/**
 * 型号后缀。`风盾500` / `风盾500pro` 字面上只差三个字母，但 pro、max、mini
 * 这些后缀通常意味着**另一个 SKU**，合并错了要重灌才能修。
 * 所以「包含关系」遇到型号后缀时降级成弱候选，交给人判。
 */
const MODEL_SUFFIX = /^(?:pro|max|mini|plus|ultra|se|air|lite|neo|s|青春版|标准版|旗舰版|\d+)$/i;

/**
 * 规范化。只做「一定不改变语义」的变形：
 * 小写、去空白与连接符、去括注、去标点。
 * 不动数字和字母——「风盾500」的 500 和「风盾500pro」的 pro 正是区别所在。
 */
export function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[\s\u3000·・\-—_/\\]+/g, "")
    .replace(/[，,。.、:：;；!！?？'"“”‘’《》<>【】[\]]/g, "")
    .trim();
}

/** 编辑距离。名字都短，直接二维 DP，不值得上优化。 */
export function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** 最长公共子串长度（不是子序列）。用来量「字面上有多少是重合的」。 */
export function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 两个名字像不像。返回 0-1，附带理由（调试和日志用）。
 *
 * 刻意不做「去掉京东京造这类前缀」这种领域规则：什么算品牌前缀没法穷举，
 * 与其猜，不如让阈值低一点、把不确定的交给人和模型。
 */
export function similarity(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return { score: 0, why: "空" };
  if (x === y) return { score: 1, why: "规范化后相同" };

  const short = x.length <= y.length ? x : y;
  const long = x.length > y.length ? x : y;
  const diff = long.length - short.length;

  if (long.includes(short) && diff <= 4) {
    // 多出来的部分是型号后缀还是品牌前缀，结论完全不同：
    // 「京造风盾500」是同一款的全称，「风盾500pro」是另一个 SKU。
    const tail = long.startsWith(short) ? long.slice(short.length) : "";
    const head = long.endsWith(short) ? long.slice(0, long.length - short.length) : "";
    const extra = tail || head;
    if (MODEL_SUFFIX.test(extra)) return { score: 0.6, why: `多出型号后缀「${extra}」` };
    return { score: 0.92, why: `包含，差 ${diff} 字` };
  }

  const d = editDistance(x, y);
  if (d <= 1 && Math.min(x.length, y.length) >= 4) return { score: 0.88, why: `编辑距离 ${d}` };

  const lcs = longestCommonSubstring(x, y);
  const cover = lcs / short.length;
  if (cover >= 0.6 && diff <= 6) return { score: 0.6 + cover * 0.2, why: `公共子串 ${lcs}/${short.length}` };

  // 首字都不一样且没有公共前缀，基本可以排除：中文实体的第一个字几乎总是有信息的。
  if (x[0] !== y[0] && lcs <= 1) return { score: 0, why: "首字不同且几乎无重合" };
  return { score: cover * 0.5, why: `公共子串 ${lcs}/${short.length}` };
}

/* ---------- 实体表 ---------- */

/**
 * 读实体表。一个实体一个段落块，内容就是规范名，别名挂在属性上。
 *
 * 为什么存思源而不是本地 JSON：这张表需要人改（模型判错了要能立刻修），
 * 思源里能打开、能搜、能双链，手机上也能改。本地缓存只做进程内加速。
 *
 * 按 box（笔记本）查而不是按 parent_id：`appendBlock(docId, …)` 建出来的块，
 * parent 是文档的**标题块**，不是文档本身（实测：doc → h1 → p）。
 * 按 parent_id 查永远空，于是每次都会以为表是空的。
 */
export async function loadEntities(sy, entitiesDocId) {
  const rows = await sy.sql(
    `SELECT id, content, ial FROM blocks
      WHERE box = (SELECT box FROM blocks WHERE id='${entitiesDocId}')
        AND type='p' AND ial LIKE '%custom-mem-kind="entity"%'
      ORDER BY created ASC`
  );
  return (rows ?? [])
    .filter((r) => /custom-mem-kind="entity"/.test(r.ial ?? ""))
    .map((r) => ({
      id: r.id,
      name: String(r.content ?? "").trim(),
      aliases: (/custom-mem-aliases="([^"]*)"/.exec(r.ial ?? "")?.[1] ?? "")
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean),
      status: /custom-mem-status="([^"]*)"/.exec(r.ial ?? "")?.[1] ?? "active",
      mergedInto: /custom-mem-merged-into="([^"]*)"/.exec(r.ial ?? "")?.[1] ?? "",
    }))
    .filter((e) => e.name);
}

/** 精确命中：规范名或别名，返回那个实体。 */
export function lookup(table, name) {
  const n = norm(name);
  if (!n) return null;
  for (const e of table) {
    if (e.status === "merged") continue;
    if (norm(e.name) === n) return e;
    if (e.aliases.some((a) => norm(a) === n)) return e;
  }
  return null;
}

/** 按相似度找候选，降序。只留过 WEAK 线的。 */
export function findCandidates(name, table, { limit = 3 } = {}) {
  const out = [];
  for (const e of table) {
    if (e.status === "merged") continue;
    let best = { score: 0, why: "" };
    for (const candidate of [e.name, ...e.aliases]) {
      const s = similarity(name, candidate);
      if (s.score > best.score) best = s;
    }
    if (best.score >= WEAK) out.push({ entity: e, score: best.score, why: best.why });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function addEntity(sy, entitiesDocId, name, { aliases = [], source = "" } = {}) {
  const clean = String(name).trim();
  if (!clean) throw new Error("实体名不能为空");
  const blockId = await sy.appendBlock(entitiesDocId, clean, "markdown");
  try {
    await sy.setBlockAttrs(blockId, {
      "custom-mem-kind": "entity",
      "custom-mem-aliases": aliases.join("|"),
      "custom-mem-status": "active",
      "custom-mem-first-seen": new Date().toISOString().slice(0, 10),
      ...(source ? { "custom-mem-source": source } : {}),
    });
  } catch (e) {
    await sy.deleteBlock(blockId).catch(() => {});
    throw e;
  }
  return blockId;
}

/**
 * 合并：把 fromName 归到 intoName 名下。
 *
 * 顺序是「先写表，再改条目」：表是真相，条目属性是派生物。
 * 反过来的话，改完条目属性再写表失败，下次抽取又会造一个新实体，
 * 而那一批被改过的条目已经指向新名字了，两边对不上。
 */
export async function mergeEntities(sy, entitiesDocId, fromName, intoName, { log = () => {} } = {}) {
  const table = await loadEntities(sy, entitiesDocId);
  const target = lookup(table, intoName);
  if (!target) throw new Error(`找不到实体「${intoName}」，先用 mem entity add 建一个`);
  const src = table.find((e) => e.name === fromName || e.aliases.includes(fromName));
  if (src && src.name === target.name) return { changed: 0, aliases: target.aliases, note: "已经是同一个" };

  // 1) 别名并进去（含 from 自己，以及它名下的别名）
  const add = new Set([fromName, ...(src?.aliases ?? [])]);
  add.delete(target.name);
  const aliases = Array.from(new Set([...target.aliases, ...add]));
  await sy.setBlockAttrs(target.id, { "custom-mem-aliases": aliases.join("|") });

  // 2) 回填条目：把 entity 是这些名字的条目改成规范名
  const names = [fromName, ...(src?.aliases ?? [])].filter(Boolean);
  let changed = 0;
  if (names.length) {
    const cond = names.map((n) => `ial LIKE '%custom-mem-entity="${n.replace(/"/g, '\\"')}"%'`).join(" OR ");
    const rows = await sy.sql(`SELECT id FROM blocks WHERE (${cond}) AND ial LIKE '%custom-mem-hash="%'`);
    const pairs = (rows ?? []).map((r) => ({ id: r.id, attrs: { "custom-mem-entity": target.name } }));
    if (pairs.length) {
      await sy.setBlockAttrsBatch(pairs);
      changed = pairs.length;
    }
  }

  // 3) 源实体标成 merged，不删：历史条目里可能还有它的名字，留着能查
  if (src) {
    await sy.setBlockAttrs(src.id, {
      "custom-mem-status": "merged",
      "custom-mem-merged-into": target.name,
    });
  }
  log(`    合并 ${fromName} → ${target.name}，回填 ${changed} 条`);
  return { changed, aliases };
}

/* ---------- 弱候选：问一次模型 ---------- */

const JUDGE_PROMPT = `判断这些名字对，哪些指同一个具体对象。
同一个 = 同一款产品 / 同一个人 / 同一个项目，不是同一类。
型号后缀（pro、max、mini）通常意味着不同型号，别合并。

只输出 JSON：{"same":[下标,…]}，没有就 {"same":[]}`;

async function judgePairs(cfg, pairs, tag = "entity") {
  if (!pairs.length) return new Set();
  const text = pairs.map((p, i) => `${i}. ${p.a} / ${p.b}`).join("\n");
  const r = await chat(cfg, {
    messages: [
      { role: "system", content: JUDGE_PROMPT },
      { role: "user", content: text },
    ],
    json: true,
    tag,
  });
  const raw = String(r.text ?? "");
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        obj = JSON.parse(raw.slice(s, e + 1));
      } catch {
        obj = null;
      }
    }
  }
  // 解析不出来就一个都不合并：宁可用两个名字，也不猜。
  if (!obj || !Array.isArray(obj.same)) return new Set();
  return new Set(obj.same.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < pairs.length));
}

/* ---------- 否定表（本地） ---------- */

export function loadNegatives() {
  try {
    return JSON.parse(readFileSync(NEGATIVES_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveNegatives(o) {
  ensureDirs();
  writeFileSync(NEGATIVES_PATH, JSON.stringify(o, null, 2) + "\n");
}

const negKey = (a, b) => [norm(a), norm(b)].sort().join("|");

export function isNegated(a, b) {
  return Boolean(loadNegatives()[negKey(a, b)]);
}

export function addNegative(a, b) {
  const o = loadNegatives();
  o[negKey(a, b)] = new Date().toISOString().slice(0, 10);
  saveNegatives(o);
}

/* ---------- 归一主流程 ---------- */

/**
 * 把一批模型给的实体名归一成表里的规范名。
 *
 * 返回 { map, created, weak }：
 *   map    原始名 → 规范名（写条目时用）
 *   created 这次新建的实体
 *   weak   已经进了待确认的对
 */
export async function resolveEntities({ sy, cfg, ids, names, useModel = true, table: given = null, log = () => {} }) {
  // 回灌时一轮要处理十几个会话，每个会话都重新查一遍表没意义，而且刚建的实体
  // 在 SQL 索引里还查不到（异步），下一个会话会把它当成新的再造一份。
  // 所以调用方可以把表传进来，本函数负责把新建的追加进去。
  const table = given ?? (await loadEntities(sy, ids.entities));
  const map = new Map();
  const created = [];
  const weak = [];
  const negatives = loadNegatives();
  /**
   * 本批新建的实体，还没落库。
   *
   * 必须在同一批内互相比：一次抽取里同时出现「风盾500」和「京造风盾500」是常态
   * （同一段对话里两种叫法都有提到），只看已有表的话两个都会被当成新实体，
   * 结果一批就造出两份。
   */
  const local = [];

  for (const raw of names) {
    const name = String(raw ?? "").trim();
    if (!name || map.has(name)) continue;

    const pool = local.length ? [...table, ...local] : table;
    const hit = lookup(pool, name);
    if (hit) {
      map.set(name, hit.name);
      continue;
    }

    const cands = findCandidates(name, pool).filter((c) => !negatives[negKey(name, c.entity.name)]);
    const strong = cands.find((c) => c.score >= STRONG);
    if (strong) {
      map.set(name, strong.entity.name);
      continue;
    }

    // 先用自己，等判完再改。这样即使模型挂了，写进库的名字也是原样的，不会凭空造一个。
    local.push({ id: "", name, aliases: [], status: "active", mergedInto: "" });
    map.set(name, name);
    if (cands.length) weak.push({ name, candidates: cands });
  }

  // 弱候选一次问完。问之前先按「新名 / 已有名」拍平成对。
  if (weak.length && useModel && hasModel(cfg)) {
    const pairs = [];
    for (const w of weak) {
      for (const c of w.candidates) pairs.push({ a: w.name, b: c.entity.name, w, c });
    }
    try {
      const same = await judgePairs(cfg, pairs);
      pairs.forEach((p, i) => {
        if (!same.has(i)) return;
        // 模型说 same，但字面差得远的，不自动合——那是最容易错的一类。
        if (p.c.score >= STRONG) map.set(p.w.name, p.c.entity.name);
        else p.w.needsHuman = true;
        p.w.modelSaidSame = true;
      });
    } catch (e) {
      log(`    · 实体判重没跑成（${e.message}），新名字先按原样记`);
      for (const w of weak) w.needsHuman = true;
    }
  } else {
    for (const w of weak) w.needsHuman = true;
  }

  // 新建：本批里最终落在「自己」这个名字上、表里又没有的，建一个实体块。
  // 被合并掉的那些（map 指向别人）不建，否则会多出一堆只有一次提及的孤立实体。
  for (const e of local) {
    const finalName = map.get(e.name) ?? e.name;
    if (finalName !== e.name) continue;
    if (lookup(table, finalName)) continue;
    try {
      const blockId = await addEntity(sy, ids.entities, finalName);
      created.push(finalName);
      table.push({ id: blockId, name: finalName, aliases: [], status: "active", mergedInto: "" });
    } catch (e2) {
      log(`    ! 建实体失败：${finalName}（${e2.message}）`);
    }
  }

  // 进待确认：所有「判过但没合并」的对
  const toPending = weak.filter((w) => w.needsHuman || map.get(w.name) === w.name);
  if (toPending.length && ids.pending) {
    try {
      await appendPending(sy, ids.pending, toPending);
    } catch (e) {
      log(`    ! 待确认写不进去：${e.message}`);
    }
  }

  return { map, created, weak: toPending };
}

/* ---------- 05-实体待确认 ---------- */

/** 三态。思源只有 `[ ]` 和 `[X]`（`[x]` 会被内核存成大写），否定用 `[-]`。 */
const ITEM_RE = /^-\s*(?:\{:([^}]*)\})?\s*\[([ Xx-])\]\s*(.*)$/;

/** 从 `{: id="..." updated="..."}` 里抠块 id。 */
function attrId(s) {
  return /id="([^"]+)"/.exec(s ?? "")?.[1] ?? "";
}

/**
 * 解析待确认区。
 *
 * kramdown 里一行是这样：`- {: id="2026…"} [ ] 风盾500 ← 风盾500pro`，
 * 后面还跟着子块自己的属性行（没有 `-` 开头），忽略即可。
 * 块 id 必须留着：执行完要按 id 删那一行，按行号删会误伤。
 */
export function parsePending(kramdown) {
  const out = [];
  for (const line of String(kramdown ?? "").split("\n")) {
    const m = ITEM_RE.exec(line.trim());
    if (!m) continue;
    const [, attrs, mark, body] = m;
    const pair = /^(.+?)\s*(?:←|<-|<—|〈-)\s*(.+?)\s*$/.exec(body);
    if (!pair) continue;
    const a = pair[1].trim();
    const b = pair[2].replace(/\s*（[^）]*）\s*$/, "").trim();
    if (!a || !b) continue;
    out.push({
      blockId: attrId(attrs),
      state: mark === "-" ? "reject" : mark === "X" || mark === "x" ? "merge" : "todo",
      a,
      b,
      raw: body,
    });
  }
  return out;
}

/** 往待确认区追加。已存在同一对就不重复写。 */
export async function appendPending(sy, pendingDocId, items) {
  const kramdown = await sy.getBlockKramdown(pendingDocId);
  const existing = parsePending(kramdown);
  const seen = new Set(existing.map((x) => `${norm(x.a)}|${norm(x.b)}`));
  for (const w of items) {
    const key = `${norm(w.name)}|${norm(w.candidates[0].entity.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cand = w.candidates[0];
    const note = w.modelSaidSame ? "（模型认为是同一个，但字面差得远，得你定）" : "";
    await sy.appendBlock(pendingDocId, `- [ ] ${w.name} ← ${cand.entity.name}${note}`, "markdown");
  }
}

/**
 * 读取并执行待确认区。
 *
 * 只删 `type='i'` 的块：思源里一个列表的 kramdown 会在第一个 `-` 上带**列表块**的 id，
 * 拿它去 deleteBlock 会把整个列表删掉。这是实测过的形状，不是猜的。
 */
export async function applyPending({ sy, cfg, ids, log = () => {}, dry = false }) {
  const kramdown = await sy.getBlockKramdown(ids.pending);
  const items = parsePending(kramdown);
  const stat = { todo: 0, merged: 0, rejected: 0, skipped: 0, failed: 0 };
  const merged = [];
  const rejected = [];

  for (const it of items) {
    if (it.state === "todo") {
      stat.todo++;
      continue;
    }
    if (!it.blockId) {
      stat.skipped++;
      continue;
    }
    if (it.state === "merge") {
      if (dry) {
        merged.push(it);
        continue;
      }
      try {
        const r = await mergeEntities(sy, ids.entities, it.a, it.b, { log });
        stat.merged++;
        merged.push({ ...it, changed: r.changed });
        await deleteItem(sy, it.blockId);
      } catch (e) {
        stat.failed++;
        log(`    ! 合并失败 ${it.a} → ${it.b}：${e.message}`);
      }
      continue;
    }
    // reject：记进否定表，以后不再问
    if (dry) {
      rejected.push(it);
      continue;
    }
    addNegative(it.a, it.b);
    stat.rejected++;
    rejected.push(it);
    await deleteItem(sy, it.blockId);
  }
  return { stat, merged, rejected };
}

/** 删一行之前先确认它是列表项。不是就跳过——宁可留一行，也不误删整个列表。 */
async function deleteItem(sy, blockId) {
  const rows = await sy.sql(`SELECT type FROM blocks WHERE id='${blockId}' LIMIT 1`);
  if (rows?.[0]?.type !== "i") return false;
  await sy.deleteBlock(blockId);
  return true;
}

/** 抽取时塞进 prompt 的清单。按名字长度升序（短的更可能是通用名，复用价值高）。 */
export function shotList(table, limit = 300) {
  return table
    .filter((e) => e.status !== "merged")
    .slice(0, limit)
    .map((e) => (e.aliases.length ? `${e.name}（别名：${e.aliases.join("、")}）` : e.name));
}
