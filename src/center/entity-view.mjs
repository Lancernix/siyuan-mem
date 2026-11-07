/**
 * 实体视图：以话题为骨架，把结论挂在它下面。
 *
 * 结构就两层，全部用思源原生语法：
 *
 * ```
 * - **订货系统**（14）
 *   - ((块id "订货系统 改索引要三处同步 + EXPLAIN 验证"))
 *   - ((块id "订货系统 接口统一扁平 REST，用 :id 定位"))
 * ```
 *
 * - 用**列表**：列表项是容器（标题和段落都是叶子块，装不了东西）。
 * - 用**块引用**：点一下跳到 01-条目 里的原块，鼠标悬停看全文；数据只有一份，
 *   改条目这里自动跟着变。
 * - 锚文本用抽取时给的 `brief`（≤24 字），不是截断——截断只给出句子的前半截，
 *   摘要才让人扫一眼就知道这条在说什么。
 */
import { ATTR } from "./store.mjs";

const TYPE_LABEL = { decision: "定下来的", fact: "事实", preference: "偏好", reference: "参考" };

function plain(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function attrOf(ial, key) {
  return new RegExp(`${key}="([^"]*)"`).exec(ial ?? "")?.[1] ?? "";
}

/** 锚文本里不能有双引号，否则会把 `((id "…"))` 的语法弄断。 */
function anchor(s) {
  return String(s ?? "").replace(/["\n]/g, " ").trim().slice(0, 40);
}

/** 读所有 current 条目，按话题分组。 */
export async function groupByEntity({ sy, ids }) {
  const rows = await sy.sql(
    `SELECT id, content, ial FROM blocks
      WHERE box = (SELECT box FROM blocks WHERE id='${ids.entries}')
        AND ial LIKE '%${ATTR.hash}="%'
        AND ial LIKE '%${ATTR.status}="current"%'
      ORDER BY created ASC
      -- 必须显式写 LIMIT：思源 SQL 不写的话默认只回 64 行，
      -- 库一过 64 条，视图就只剩最早那 64 条，而且它不报错。
      LIMIT 5000`
  );
  const map = new Map();
  for (const r of rows ?? []) {
    const text = plain(r.content);
    if (!text) continue;
    const entity = attrOf(r.ial, ATTR.entity) || "未归类";
    const list = map.get(entity) ?? [];
    list.push({
      id: r.id,
      text,
      brief: attrOf(r.ial, ATTR.brief) || text.slice(0, 30),
      type: attrOf(r.ial, ATTR.type) || "fact",
      date: attrOf(r.ial, ATTR.date),
    });
    map.set(entity, list);
  }
  return Array.from(map.entries())
    .map(([entity, items]) => ({ entity, items }))
    .sort((a, b) => b.items.length - a.items.length || a.entity.localeCompare(b.entity, "zh"));
}

export function render(groups, { total } = {}) {
  // 不写 # 02-实体：文档标题栏已经显示文档名了，正文再来一个 h1 就是同一行字出现两次。
  const out = [
    `${groups.length} 个话题 · ${total} 条结论。括号里是条数，点条目能跳到它本身。`,
    "",
  ];
  for (const g of groups) {
    out.push(`- **${g.entity}**（${g.items.length}）`);
    // 同一话题内先「定下来的」，再事实、偏好、参考——读的人关心「定了什么」。
    const order = ["decision", "fact", "preference", "reference"];
    const sorted = [...g.items].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    for (const it of sorted) {
      const label = it.brief ? it.brief : it.text;
      // 4 空格缩进：Lute 不认 2 空格，会当成新的顶层列表项（实测）。
      out.push(`    - ((${it.id} "${anchor(label)}"))`);
    }
  }
  return out.join("\n");
}

/**
 * 从 kramdown 里抠顶层块的 id（属性行单独一行、不带缩进；文档自己那行带 type="doc"）。
 * 不查 SQL：块索引有 3 秒延迟，刚写完查不到会导致「没删掉又追加一份」。
 */
export function topBlockIds(kramdown) {
  const ids = [];
  for (const line of String(kramdown ?? "").split("\n")) {
    if (/^\s/.test(line)) continue;
    const m = /^\{: id="([^"]+)"([^}]*)\}/.exec(line);
    if (!m || /type="doc"/.test(m[2])) continue;
    ids.push(m[1]);
  }
  return ids;
}

/** 清空文档（保留文档本身），用 kramdown 找顶层块，删父块级联带走子块。 */
export async function clearDoc({ sy, docId }) {
  const ids = topBlockIds(await sy.getBlockKramdown(docId));
  for (const id of ids) await sy.deleteBlock(id).catch(() => {});
  return ids.length;
}

export async function writeEntities({ sy, ids, log = () => {} }) {
  const groups = await groupByEntity({ sy, ids });
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const md = render(groups, { total });
  const removed = await clearDoc({ sy, docId: ids.entities });
  await sy.appendBlock(ids.entities, md, "markdown");
  log(`    02-实体：${groups.length} 个话题 / ${total} 条，清掉旧块 ${removed} 个`);
  return { groups: groups.length, total };
}
