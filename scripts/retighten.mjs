/**
 * 把存量条目的粗原文指针收窄到真正出处的那几轮。
 *
 * 新写入的条目在 jobs.mjs 里已经按锚点收窄；这本脚本补的是**之前写进去的那些**——
 * 抽取是「一批一次模型调用」，那批抽出来的 4–10 条共用一个 from/to，指针常常横跨
 * 几十轮、三万多字，点开等于没指。
 *
 * 只改 `custom-mem-raw` 一个属性，不动正文、hash、status，所以判重和状态链不受影响。
 * 收窄是保守的：跨轮归纳、锚点分散、证据掉太多，一律保持原指针（见 raw.mjs）。
 *
 * ⚠️ 2026-11-11 随机抽检 20 条，3–4 条指偏或存疑；存量迁移已整体回滚，新写入
 * 默认关闭收窄。这个脚本留作实验工具，跑之前请先 dry、再随机抽 20 条人工核对，
 * 确认结论的事实确实落在窗口里。另外它只改属性，正文里的 `[原文](assets/…)`
 * 链接不会跟着变，两者会不一致，不适合直接在生产存量上用。
 *
 * 状态：FROZEN / 实验性。收窄默认关闭、存量已全量回滚，这个脚本只留作记录，
 * 不再新增功能。要做精确出处请改抽取阶段（让它直接产出轮次指针），别在这里继续调。
 *
 * 用法：
 *   node scripts/retighten.mjs             只报告，不改
 *   node scripts/retighten.mjs --apply     真改（分批 40 条，只记成功批次）
 *   node scripts/retighten.mjs --rollback  读备份把旧指针写回去
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, HOME_DIR, ensureDirs } from "../src/util/config.mjs";
import { SiYuan, resolveNotebookId } from "../src/util/siyuan.mjs";
import { parsePtr, narrowAnchor, stripRawLink } from "../src/util/raw.mjs";

const APPLY = process.argv.includes("--apply");
const ROLLBACK = process.argv.includes("--rollback");
const cfg = loadConfig();
const sy = new SiYuan({ baseUrl: cfg.siyuan.baseUrl, token: cfg.siyuan.token, timeoutMs: 30000 });
const box = await resolveNotebookId(sy, cfg);

/** 原子写：写一半崩了留下的是能解析的旧文件，不是半截 JSON。 */
function writeAtomic(path, body) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
}

const BACKUP_PREFIX = "retighten-backup-";
const listBackups = () =>
  readdirSync(HOME_DIR)
    .filter((x) => x.startsWith(BACKUP_PREFIX) && x.endsWith(".json"))
    .sort(); // 文件名带 ISO 时间戳，字典序就是时间序

ensureDirs();
// 现值快照：写之前比对。服务端已经改了但客户端超时的话，不比对就会在下次跑时
// 把「已收窄的指针」当成原始值再缩一次，并把缩过的值记成 old —— 回滚就回不去了。
const rows = await sy.sql(
  `SELECT id, content, ial FROM blocks WHERE box='${box}' AND type='p' AND ial LIKE '%custom-mem-raw="%' LIMIT 5000`
);
const currentRaw = new Map(
  rows.map((r) => [r.id, String(r.ial).match(/custom-mem-raw="([^"]*)"/)?.[1] ?? ""])
);
const done = new Set();
const originals = new Map();
const latest = new Map();
// 每次收窄的产物 -> {id, old}。跨次运行的关键：某批服务端改成功了、客户端却超时，
// 备份里没有它；下次跑 SQL 读到的是「已收窄的 P1」，会把它当原始值再缩成 P2，
// 并把 P1 记成 old，真原始值 P0 就永久丢了。用这个索引认出「现值其实是某次产物」。
// 键必须是 (块 id, 指针串)，不能只按指针串：一批 4–10 条共用一个 from/to，
// 收窄后证据同处的条目会收敛到同一个窗口，指针串碰撞是真实存在的。只按串做键，
// 会把别人的 old 记到这块头上，回滚时改坏一个从没动过的块。
const byNow = new Map();
// .sort() 不能省：文件名带 ISO 时间戳，字典序即时间序；originals 靠先到先得
// 取「最早那个 old」，readdir 顺序不保证，乱序会让回滚回到中间态。
for (const f of readdirSync(HOME_DIR).filter((x) => x.startsWith("retighten-") && x.endsWith(".json")).sort()) {
  try {
    const active = f.startsWith(BACKUP_PREFIX);
    for (const u of JSON.parse(readFileSync(join(HOME_DIR, f), "utf8"))) {
      if (!u?.id) continue;
      if (typeof u.now === "string" && typeof u.old === "string")
        byNow.set(`${u.id}\u0000${u.now}`, u.old);
      if (!active) continue; // 归档（已回滚）的不算「已处理」，也不进 originals/latest
      done.add(u.id);
      // 同一块可能被多份备份记着（重跑过），回滚要回到**最早**那个 old。
      if (!originals.has(u.id)) originals.set(u.id, u.old);
      latest.set(u.id, u.now);
    }
  } catch {
    /* 坏备份不该让主流程挂掉 */
  }
}

if (ROLLBACK) {
  if (!originals.size) {
    console.log("没有找到可回滚的备份，什么都没做。");
    process.exit(0);
  }
  // 只回滚「现值确实等于备份里 now」的。等于 old = 已经回滚过；其他值 = 期间
  // 流水线或人改过，不能盲写覆盖，报冲突留着备份。
  // currentRaw 只有 LIMIT 5000 内的块。查不到的 id 未必是真删了，可能只是超出快照；
  // 定向再查一次，把「有块但没进快照」补回来，否则这些块会被当成 gone 直接归档，
  // 备份一归档就再也回滚不了。
  const unknown = [...originals.keys()].filter((id) => !currentRaw.has(id));
  const unverified = new Set();
  for (let i = 0; i < unknown.length; i += 40) {
    const chunk = unknown.slice(i, i + 40);
    const ids = chunk.map((x) => `'${x}'`).join(",");
    try {
      const rs = await sy.sql(`SELECT id, ial FROM blocks WHERE id IN (${ids})`);
      for (const x of rs) {
        currentRaw.set(x.id, String(x.ial).match(/custom-mem-raw="([^"]*)"/)?.[1] ?? "");
      }
    } catch {
      // 补查失败 ≠ 确认块不存在。一次瞬时锁库就把真实存在的块归档掉，
      // 之后 --rollback 再也够不着，而操作者看到的是绿色退出码。
      for (const x of chunk) unverified.add(x);
    }
  }
  const items = [];
  let already = 0;
  let conflict = 0;
  let gone = 0;
  for (const [id, old] of originals) {
    if (typeof old !== "string") continue;
    const cur = currentRaw.get(id);
    const now = latest.get(id);
    // 块被删、type 变了、或落在 LIMIT 5000 之外 -> cur 是 undefined。
    // 这不是「值被改过」，不能算冲突，否则备份永远归档不了、退出码永远是 1。
    if (cur === undefined) {
      // 未验证的既不写回、也不算「块已不存在」，留到下次重跑再判。
      if (unverified.has(id)) continue;
      gone++;
      continue;
    }
    if (cur === old) { already++; continue; }
    if (now && cur !== now) { conflict++; continue; }
    items.push([id, old]);
  }
  let ok = 0;
  let bad = 0;
  for (let i = 0; i < items.length; i += 40) {
    const chunk = items.slice(i, i + 40).map(([id, old]) => ({ id, attrs: { "custom-mem-raw": old } }));
    try {
      await sy.setBlockAttrsBatch(chunk);
      ok += chunk.length;
    } catch (e) {
      bad += chunk.length;
      console.log(`  回滚批量失败（第 ${i}–${i + chunk.length} 条）：${e.message}`);
    }
  }
  console.log(
    `回滚 ${ok} 条，本就已回滚 ${already} 条，块已不存在 ${gone} 条，补查失败未验证 ${unverified.size} 条，冲突跳过 ${conflict} 条，失败 ${bad} 条`
  );
  if (!bad && !conflict && !unverified.size) {
    // 回滚完成后备份不能再充作「已处理」清单，否则重新 --apply 会整批跳过。
    for (const f of listBackups()) {
      renameSync(join(HOME_DIR, f), join(HOME_DIR, `retighten-rolledback-${f}`));
    }
    console.log("备份已归档为 retighten-rolledback-*，重新 --apply 会从头算。");
  } else {
    console.log("有失败批次 / 冲突 / 补查未验证，备份保留，修好之后可以再跑一次 --rollback。");
  }
  process.exit(bad || conflict || unverified.size ? 1 : 0);
}

/** 同一份附件只下一次。返回 全局轮次号 → {text}。 */
const cache = new Map();
async function linesOf(path) {
  if (!cache.has(path)) {
    const text = await sy.getAsset(path);
    const map = new Map();
    for (const line of String(text ?? "").split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r.type !== "session" && Number.isFinite(Number(r.i))) map.set(Number(r.i), { text: String(r.text ?? "") });
      } catch {
        /* 坏一行不连累别的 */
      }
    }
    cache.set(path, map);
  }
  return cache.get(path);
}

const charSpan = (lines, a, b) => {
  let n = 0;
  for (const [i, o] of lines) if (i >= a && i <= b) n += o.text.length;
  return n;
};

// 幂等：备份文件里记着「哪些块**真的**改成功了」，全部跳过。
//
// 不做这个的话，重复跑会继续缩：窗口两边各扩了一行作上下文，下一轮又从新窗口里
// 找峰值、再扩一行……每次都满足安全约束，但指针会被一点点蚕食到只剩三行。
const updates = [];
const reasons = {};
let beforeRows = 0;
let afterRows = 0;
let beforeChars = 0;
let afterChars = 0;
let missing = 0;
let skipped = 0;
let processed = 0;
const samples = [];

const preApplied = [];
for (const r of rows) {
  if (done.has(r.id)) {
    skipped++;
    continue;
  }
  const m = String(r.ial).match(/custom-mem-raw="([^"]*)"/);
  if (!m) continue;
  // 现值正好是某份备份记过的「收窄产物」：这次别再缩，按那次的真 old 记账。
  // 这是防二次收窄的唯一有效位置——写前比对用的是同一份快照，恒真，防不住。
  const curPtr = currentRaw.get(r.id);
  const priorOld = curPtr ? byNow.get(`${r.id}\u0000${curPtr}`) : undefined;
  if (priorOld !== undefined) {
    preApplied.push({ id: r.id, old: priorOld, ptr: curPtr });
    continue;
  }
  const p = parsePtr(m[1]);
  if (p.from == null || p.to == null) continue;
  const lines = await linesOf(p.path).catch(() => new Map());
  if (!lines.size) {
    missing++;
    continue;
  }
  // 稀疏数组：下标就是全局轮次号，跟指针里的 from/to 同坐标系。
  const turns = [];
  for (const [i, obj] of lines) turns[i] = obj;
  const text = stripRawLink(r.content, m[1]);
  const out = narrowAnchor(text, turns, p.from, p.to);
  reasons[out.reason] = (reasons[out.reason] ?? 0) + 1;
  processed++;
  beforeRows += p.to - p.from + 1;
  afterRows += out.to - out.from + 1;
  beforeChars += charSpan(lines, p.from, p.to);
  afterChars += charSpan(lines, out.from, out.to);
  if (!out.narrowed) continue;
  updates.push({ id: r.id, ptr: `${p.path}#${out.from}-${out.to}`, old: m[1] });
  if (samples.length < 6) {
    samples.push(
      `${p.to - p.from + 1} 行 → ${out.rows} 行  #${p.from}-${p.to} → #${out.from}-${out.to}  ${text.slice(0, 40)}`
    );
  }
}

const pct = (a, b) => (b ? `${(((b - a) / b) * 100).toFixed(0)}%` : "-");
console.log(`带原文指针的条目 ${rows.length} 条，附件 ${cache.size} 份，附件读不出 ${missing} 条，已收窄过跳过 ${skipped} 条`);
if (preApplied.length) console.log(`检测到 ${preApplied.length} 条「已落盘但没记账」：按备份里的原始 old 补记，不再二次收窄`);
console.log(`本次可收窄 ${updates.length} 条；判定分布：`, JSON.stringify(reasons));
if (processed) {
  console.log(
    `本次处理 ${processed} 条：平均轮次 ${(beforeRows / processed).toFixed(1)} → ${(afterRows / processed).toFixed(1)} 行` +
      `，原文字符 ${Math.round(beforeChars / processed)} → ${Math.round(afterChars / processed)}（省 ${pct(afterChars, beforeChars)}）`
  );
}
if (samples.length) {
  console.log("\n=== 样例 ===");
  for (const s of samples) console.log("  " + s);
}

if (!APPLY) {
  console.log("\n（dry，没改。加 --apply 真写；--rollback 可回退）");
  process.exit(0);
}

// 备份跟写入同批推进：**只有成功批次**才进备份。原来先写全量备份再分批写，
// 某批失败后那些 id 已在备份里，下次跑被当成「已处理」跳过，永远不会重试。
const backup = join(HOME_DIR, `${BACKUP_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const committed = [...preApplied];
const record = () =>
  writeAtomic(
    backup,
    JSON.stringify(committed.map((u) => ({ id: u.id, old: u.old, now: u.ptr })), null, 2) + "\n"
  );

// 注：setBlockAttrs 会刷新块的 updated，而检索取候选是 ORDER BY updated DESC LIMIT 5000。
// 当前 1500 条远没撞上限，且相关度打分用的是 custom-mem-date 不是 updated，所以
// 这次批量改属性不会改变召回排序；库长到 5000 以上再跑就要重新掂量这一条。
let ok = 0;
let bad = 0;
for (let i = 0; i < updates.length; i += 40) {
  const batch = updates.slice(i, i + 40);
  const writable = [];
  for (const u of batch) {
    const cur = currentRaw.get(u.id);
    // 防御性检查：快照之后、写入之前有人动过就别硬写。注意 cur === u.old 在正常
    // 路径下恒真（两者同源），真正防二次收窄的是上面的 byNow 和下面失败后的重读。
    if (cur !== u.old) {
      console.log(`  ! 跳过 ${u.id}：现值已不是快照里的值，期间被改过`);
      continue;
    }
    writable.push(u);
  }
  if (writable.length) {
    const chunk = writable.map((u) => ({ id: u.id, attrs: { "custom-mem-raw": u.ptr } }));
    try {
      await sy.setBlockAttrsBatch(chunk);
      committed.push(...writable);
      ok += chunk.length;
    } catch (e) {
      // 服务端可能已经改了、客户端却超时。重读这批块的现值：落了就记账
      // （old 仍是本次快照里的真原始值），没落的留到下次重试。
      let landed = 0;
      try {
        const ids = writable.map((u) => `'${u.id}'`).join(",");
        const rs = await sy.sql(`SELECT id, ial FROM blocks WHERE id IN (${ids})`);
        const now = new Map(
          rs.map((x) => [x.id, String(x.ial).match(/custom-mem-raw="([^"]*)"/)?.[1] ?? ""])
        );
        for (const u of writable) {
          if (now.get(u.id) === u.ptr) {
            committed.push(u);
            landed++;
          }
        }
      } catch {
        /* 重读失败就整批当没落，下次重试 */
      }
      bad += writable.length - landed;
      console.log(
        `  批量失败（第 ${i}–${i + chunk.length} 条）：${e.message}；重读确认已落盘 ${landed} 条，${writable.length - landed} 条下次重试`
      );
    }
  }
  if (committed.length) record(); // 每批原子重写一次；中途崩了只丢最后一批的记账
}
// updates 为空但 preApplied 非空时，上面的循环一次都不执行，备份就永远不会落盘，
// 而日志已经说了「补记」。循环外兜底一次，别让补记变成空话。
if (committed.length) record();
console.log(
  `\n改了 ${ok} 条，失败 ${bad} 条${existsSync(backup) ? `；备份 ${backup}` : "（没有成功批次，未创建备份）"}`
);
// 写库全失败不能报成功：脚本常被 `&&` 串在后面，退出 0 会让后续步骤误以为数据已改。
// 回滚路径早已是非零退出，apply 侧跟上。
process.exitCode = bad ? 1 : 0;
