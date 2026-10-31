/**
 * 补偿账本：写新条目成功、标旧条目过时失败时，把「该标谁」记下来，下一轮补做。
 *
 * 为什么需要它：supersede 是第二次写（setBlockAttrs），天然可能失败——思源忙、
 * 网络抖、进程被杀。失败了不补，库里就是新旧两条同时 `current`，而且看不出来：
 * 一条说 A、一条说 B，检索时都返回，人以为是两个阶段的事实。
 *
 * 靠"重跑抽一次"补不上：新一轮同样的文字会命中 hash 判重被跳过，`covered` 分支
 * 里根本没有"该标谁"的信息。所以要落盘。
 *
 * 记在最前面、补在最前面：先记账再动，中间挂了也不会漏。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./config.mjs";
import { event } from "./log.mjs";

const PATH = join(HOME_DIR, "pending-supersede.json");
/** 超过这个天数的欠账直接丢：多半是两边块都被手删了，再补也是错。 */
const MAX_AGE_DAYS = 30;

export function loadPending() {
  if (!existsSync(PATH)) return [];
  try {
    const rows = JSON.parse(readFileSync(PATH, "utf8"));
    return Array.isArray(rows) ? rows.filter((r) => r && r.old) : [];
  } catch {
    // 坏文件不能就地当空掩盖过去：挪到旁边留证，人还得能看见它。
    try {
      renameSync(PATH, `${PATH}.broken-${Date.now()}`);
    } catch {
      /* 挪不动就算了 */
    }
    return [];
  }
}

/**
 * 写账本。先写临时文件再 rename——半截的 JSON 读出来是空数组，
 * 那等于把所有待补的取代悄悄丢掉，而且没人会知道。
 */
function save(list) {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    const tmp = `${PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 1) + "\n");
    renameSync(tmp, PATH);
  } catch {
    /* 记账失败不该挡住写库 */
  }
}

/** 记一笔欠账。同一个 old 只留最后一次（新的覆盖旧的）。 */
export function notePending({ old: oldId, new: newId, entity = "" }) {
  if (!oldId || !newId || oldId === newId) return;
  const list = loadPending().filter((r) => r.old !== oldId);
  list.push({ old: oldId, new: newId, entity, at: Date.now() });
  save(list);
}

export function dropPending(oldId) {
  const list = loadPending();
  const next = list.filter((r) => r.old !== oldId);
  if (next.length !== list.length) save(next);
}

/**
 * 把欠账补完。返回补成功的条数。
 *
 * 三种情况直接销账：旧块没了、旧块已经是 superseded、两边是同一块。
 */
export async function flushPending(store, { log = () => {} } = {}) {
  const list = loadPending();
  if (!list.length) return 0;

  const keep = [];
  let fixed = 0;
  for (const r of list) {
    const age = (Date.now() - Number(r.at ?? 0)) / 86400_000;
    if (age > MAX_AGE_DAYS) continue;

    let status = "";
    try {
      status = await store.statusOf(r.old);
    } catch {
      keep.push(r); // 查不出来：既不能说它好了，也不能扔，留着下轮再试
      continue;
    }
    if (!status) continue; // 块没了
    if (status === "superseded") continue; // 已经标过

    try {
      await store.supersede(r.old, r.new);
      fixed++;
      event("entry.replace", { old: r.old, new: r.new, entity: r.entity, retried: true });
    } catch (e) {
      keep.push(r);
      log(`  · 还有一条取代没补上（${e.message}），下轮再试`);
    }
  }

  if (fixed || keep.length !== list.length) save(keep);
  return fixed;
}
