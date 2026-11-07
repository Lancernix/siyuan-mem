/**
 * 阅读层：把原子条目重新组织成「人看着像记忆」的样子。
 *
 * 为什么需要它：`01-条目` 是**数据层**——一条一句话、带属性、可检索、可去重，
 * 那是给机器用的形态。直接从思源打开它，看到的是五十几条互不相干的句子，
 * 没人读得下去。这不是抽取坏了，是两层的职责不同。
 *
 * 这一层只读不写数据：每次跑都重新渲染，不参与去重、不参与检索。
 * 删掉它不影响任何东西，随时可以再生成。
 */
import { ATTR } from "./store.mjs";
import { parsePtr } from "../shared/raw.mjs";

const TYPE_LABEL = {
  decision: "定下来的",
  fact: "事实",
  preference: "偏好与原则",
  reference: "参考",
};

/** 块内容里的 HTML 标签和实体符号清掉，只留文字。 */
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

function fmtDay(d) {
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "未知日期";
}

/**
 * 读全部 current 条目并分组。
 *
 * 分两级：先按会话（一批结论来自同一段对话，天然有共同上下文），
 * 会话内再按类型（定下来的 / 事实 / 偏好）——同一段对话里，
 * 「定了什么」比「聊到什么」更值得先看到。
 */
export async function collect({ sy, ids }) {
  const rows = await sy.sql(
    `SELECT id, content, ial FROM blocks
      WHERE box = (SELECT box FROM blocks WHERE id='${ids.entries}')
        AND ial LIKE '%${ATTR.hash}="%'
        AND ial LIKE '%${ATTR.status}="current"%'
      ORDER BY created ASC LIMIT 5000`
  );

  const bySession = new Map();
  for (const r of rows ?? []) {
    const text = plain(r.content);
    if (!text) continue;
    const session = attrOf(r.ial, ATTR.session) || "manual";
    const e = bySession.get(session) ?? {
      session,
      day: fmtDay(attrOf(r.ial, ATTR.date)),
      harness: attrOf(r.ial, ATTR.source) || "未知",
      machine: attrOf(r.ial, ATTR.machine),
      items: [],
    };
    e.items.push({
      id: r.id,
      text,
      entity: attrOf(r.ial, ATTR.entity),
      type: attrOf(r.ial, ATTR.type) || "fact",
      confidence: Number(attrOf(r.ial, ATTR.confidence)) || 3,
      raw: attrOf(r.ial, ATTR.raw),
    });
    bySession.set(session, e);
  }

  const groups = Array.from(bySession.values()).map((g) => {
      const byType = new Map();
      for (const it of g.items) {
        const k = TYPE_LABEL[it.type] ? it.type : "fact";
        (byType.get(k) ?? byType.set(k, []).get(k)).push(it);
      }
      // 高置信度排前面；同一置信度里保持写入顺序。
      for (const list of byType.values()) list.sort((a, b) => b.confidence - a.confidence);
    return { ...g, byType, total: g.items.length };
  });

  // 项目名从原文的 meta 行取（那里存着 cwd）。会话 id 前 8 位对人没有意义，
  // 「这个项目」才是分组时想看到的东西。取不到就退回 harness 名，不影响渲染。
  await Promise.all(
    groups.map(async (g) => {
      const first = g.items.find((it) => it.raw);
      if (!first) return;
      try {
        const p = parsePtr(first.raw);
        const text = await sy.getAsset(p.path);
        if (!text) return;
        const head = JSON.parse(text.slice(0, text.indexOf("\n")) || "{}");
        g.project = String(head.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
      } catch {
        // 读不到就算了，标题退回 harness 名
      }
    })
  );

  // 有日期的按日期倒序，没日期的（早期手动记的）沉到最后。
  const known = groups.filter((g) => /^\d{4}-/.test(g.day)).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.total - a.total));
  const unknown = groups.filter((g) => !/^\d{4}-/.test(g.day)).sort((a, b) => b.total - a.total);
  return [...known, ...unknown];
}

/** 会话标题：日期 · 项目（取不到就 harness）· 条数。id 不上了，对人没用。 */
function groupTitle(g) {
  const tag = g.session === "manual" ? "手动记的" : g.project || g.harness;
  return `${g.day} · ${tag}`;
}

export function render(groups, { total, now = new Date() } = {}) {
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  const out = [
    "# 记忆摘要",
    "",
    `共 ${total} 条，来自 ${groups.length} 个会话。最后更新 ${stamp}。`,
    "",
    "给人读的一层：按会话分组、按「定了什么 / 是什么 / 偏好什么」分层。",
    "数据本体在 01-条目，一条一句、带属性，那是给检索和去重用的。",
    "",
  ];

  for (const g of groups) {
    const meta = [g.harness, g.session === "manual" ? "手动" : `会话 ${g.session.slice(0, 8)}`, `${g.total} 条`].filter(Boolean).join(" · ");
    out.push(`## ${groupTitle(g)}`, "", meta, "");
    // 固定顺序：先「定下来的」，再事实，再偏好，最后参考。
    for (const type of ["decision", "fact", "preference", "reference"]) {
      const list = g.byType.get(type);
      if (!list?.length) continue;
      out.push(`### ${TYPE_LABEL[type]}`, "");
      for (const it of list) out.push(`- ${it.text}`);
      out.push("");
    }
  }
  return out.join("\n");
}

/**
 * 只渲染给人看，不往思源里写。
 *
 * 试过写成 `06-记忆摘要` 文档，两个坑：
 *   1. 思源没有「覆盖文档内容」的接口，`createDocWithMd` 同 path 会新建一份，
 *      不是覆盖——实测一次就建出三个同名文档。
 *   2. 想靠「删块再写」绕开，但块的 SQL 索引是异步的，刚建完查不到子块，
 *      于是删了个空、又追加一份，跑两次就有两份内容。
 * 视图是派生数据，做不到可靠的「整体替换」就不该写进库。留在终端输出，
 * 思源那边用原生属性视图，两边都不脏。
 */
export async function print({ sy, ids, out = console.log } = {}) {
  const groups = await collect({ sy, ids });
  const total = groups.reduce((n, g) => n + g.total, 0);
  out(render(groups, { total }));
  return { total, sessions: groups.length };
}
