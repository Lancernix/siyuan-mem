import { createHash } from "node:crypto";
import { SiYuan } from "./siyuan.mjs";
import { loadState, saveState } from "./config.mjs";

export const ATTR = {
  status: "custom-mem-status",
  entity: "custom-mem-entity",
  type: "custom-mem-type",
  hash: "custom-mem-hash",
  source: "custom-mem-source",
  session: "custom-mem-session",
  date: "custom-mem-date",
  confidence: "custom-mem-confidence",
};

const esc = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export function hashOf(text) {
  return createHash("sha1").update(String(text).trim()).digest("hex").slice(0, 12);
}

export class Store {
  #sy;
  #cfg;
  #ids = null;
  /** 本进程内已写过的内容哈希。SQL 索引是异步的，刚写完查不到，靠它挡同批重复。 */
  #recent = new Set();

  constructor(sy, cfg) {
    this.#sy = sy;
    this.#cfg = cfg;
  }

  /**
   * 建笔记本和三个文档，已存在就复用。返回各文档 id。
   *
   * 三级解析：本地缓存的 id → 按 hpath 查 → 才新建。
   * 必须有缓存这一级：思源的文档索引是异步更新的，createDocWithMd 刚返回时
   * 用 hpath 查还是空，于是下一次调用又会建一份一模一样的文档。
   */
  async init({ force = false } = {}) {
    const name = this.#cfg.siyuan.notebook;
    const state = loadState();
    // 缓存要按"实例 + 笔记本"隔离。只按 baseUrl 存的话，改了 config 里的笔记本名，
    // 缓存的还是旧笔记本的文档 id，接着往旧笔记本里写——实测踩过一次。
    const key = `${this.#cfg.siyuan.baseUrl}#${name}`;
    const cache = force ? {} : state[key] ?? {};
    // --force 的语义是"从思源重新解析"，不是"再建一套"。所以它只读不建：
    // 解析不到就报错，让人去看库里到底有几份同名文档。
    if (force) await new Promise((r) => setTimeout(r, 1500));

    let nbId = cache.notebook;
    if (!nbId || !(await this.#exists(nbId))) {
      const nb = (await this.#sy.listNotebooks()).find((n) => n.name === name);
      nbId = nb?.id ?? (await this.#sy.createNotebook(name));
    }

    const ids = { notebook: nbId };
    for (const [docKey, title] of Object.entries(this.#cfg.siyuan.docs)) {
      const hpath = `/${title}`;
      let id = cache[docKey];
      // 缓存命中一般直接用，不再回查：刚创建的文档在 SQL 索引里还查不到，一查就会重复建。
      // 但老缓存要验一次归属：文档可能被删了，也可能属于另一个同名笔记本。
      if (id && !(await this.#inNotebook(id, nbId))) id = "";
      if (!id) {
        id = await this.#sy.docIdByHPath(nbId, hpath);
        if (!id && force) {
          throw new Error(`在 ${name} 里找不到 ${hpath}。--force 只解析不新建，先确认文档还在。`);
        }
        if (!id) id = await this.#sy.createDocWithMd(nbId, hpath, this.#docSeed(docKey, title));
      }
      ids[docKey] = id;
    }

    state[key] = ids;
    saveState(state);
    this.#ids = ids;
    return ids;
  }

  /** 块还在不在。缓存会过期：用户可能在思源里把文档删了。 */
  async #exists(id) {
    const rows = await this.#sy.sql(`SELECT id FROM blocks WHERE id='${id}' LIMIT 1`);
    return Boolean(rows?.length);
  }

  /** 这个块是不是真在这本笔记本里。blocks.box 就是笔记本 id。 */
  async #inNotebook(id, nbId) {
    const rows = await this.#sy.sql(`SELECT box FROM blocks WHERE id='${id}' LIMIT 1`);
    return rows?.[0]?.box === nbId;
  }

  #docSeed(key, title) {
    if (key === "entries") {
      return [
        `# ${title}`,
        "",
        "每条记忆是一个段落，属性挂在块上。`custom-mem-status` 为 `current` 才参与召回，",
        "`superseded` 表示被后来的结论取代——不删，因为「为什么改了」的答案就在旧条目里。",
        "",
      ].join("\n");
    }
    if (key === "changes") {
      return [`# ${title}`, "", "追加式变更日志，一行一次改动。审阅看这一页，不看全库。", ""].join("\n");
    }
    return "";
  }

  async #ensure() {
    if (!this.#ids) await this.init();
    return this.#ids;
  }

  async entriesDocId() {
    return (await this.#ensure()).entries;
  }

  async #logChange(line) {
    const id = (await this.#ensure()).changes;
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
    await this.#sy.appendBlock(id, `- ${stamp} ${line}`, "markdown");
  }

  /** 同一条内容写过就不再写。返回已存在的块 id，或 null。 */
  async findDuplicate(text) {
    const h = hashOf(text);
    const rows = await this.#sy.sql(
      `SELECT id FROM blocks WHERE ial LIKE '%${ATTR.hash}="${h}"%' LIMIT 1`
    );
    return rows?.[0]?.id ?? null;
  }

  /**
   * 写一条记忆。返回 {id, duplicate}。
   * @param {{text:string, entity?:string, type?:string, confidence?:number}} entry
   * @param {{source?:string, session?:string, date?:string}} meta
   */
  async writeEntry(entry, meta = {}) {
    const { entries } = await this.#ensure();
    const text = String(entry.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) throw new Error("空条目");

    const h = hashOf(text);
    if (this.#recent.has(h)) return { id: "", duplicate: true };
    const dup = await this.findDuplicate(text);
    if (dup) return { id: dup, duplicate: true };

    const date = meta.date ?? new Date().toISOString().slice(0, 10);
    const blockId = await this.#sy.appendBlock(entries, text, "markdown");
    try {
      await this.#sy.setBlockAttrs(blockId, {
        [ATTR.status]: "current",
        [ATTR.entity]: entry.entity || "",
        [ATTR.type]: entry.type || "fact",
        [ATTR.hash]: h,
        [ATTR.source]: meta.source || "",
        [ATTR.session]: meta.session || "",
        [ATTR.date]: date,
        [ATTR.confidence]: String(entry.confidence ?? 3),
      });
    } catch (e) {
      // 建块和设属性不是一次事务。属性没写成，这个块就是没有身份的孤儿：
      // 查不到、审不到、也不会被去重挡住。宁可删掉让上层重试。
      await this.#sy.deleteBlock(blockId).catch(() => {});
      throw e;
    }
    this.#recent.add(h);
    if (this.#cfg.siyuan.logChanges !== false) {
      await this.#logChange(`+ [${entry.entity || "-"}] ${text.slice(0, 40)}`);
    }
    return { id: blockId, duplicate: false };
  }

  /** 把一条标成被取代。不删。 */
  async supersede(id, byId = "") {
    await this.#sy.setBlockAttrs(id, { [ATTR.status]: "superseded" });
    if (this.#cfg.siyuan.logChanges !== false) {
      await this.#logChange(`~ superseded ${id}${byId ? ` → ${byId}` : ""}`);
    }
  }

  /**
   * 查记忆。先精确匹配 entity，再退到全文包含。
   * 只返回 current，除非 includeSuperseded。
   */
  async search(query, { limit = 10, includeSuperseded = false } = {}) {
    await this.#ensure();
    // 只认带 hash 属性的块。变更日志和临时段落也在同一个库里，靠文档隔离不可靠。
    const isEntry = ` AND ial LIKE '%${ATTR.hash}="%'`;
    const status = includeSuperseded ? "" : ` AND ial LIKE '%${ATTR.status}="current"%'`;
    const words = String(query).trim().split(/\s+/).filter(Boolean).slice(0, 4);
    if (!words.length) return [];

    const likeEntity = words
      .map((w) => `ial LIKE '%${ATTR.entity}="%${esc(w)}%'`)
      .join(" AND ");
    const exact = await this.#sy.sql(
      `SELECT id, content, ial, created FROM blocks
        WHERE type='p'${isEntry} AND ${likeEntity}${status}
        ORDER BY created DESC LIMIT ${limit}`
    );
    if (exact?.length) return exact.map(toHit);

    const likeText = words.map((w) => `content LIKE '%${esc(w)}%'`).join(" AND ");
    const loose = await this.#sy.sql(
      `SELECT id, content, ial, created FROM blocks
        WHERE type='p'${isEntry} AND ${likeText}${status}
        ORDER BY created DESC LIMIT ${limit}`
    );
    return (loose ?? []).map(toHit);
  }

  /** 最近写入的 N 条，供人工扫一眼。 */
  async review(limit = 20) {
    await this.#ensure();
    const rows = await this.#sy.sql(
      `SELECT id, content, ial, created FROM blocks
        WHERE type='p' AND ial LIKE '%${ATTR.hash}="%'
        ORDER BY created DESC LIMIT ${limit}`
    );
    return (rows ?? []).map(toHit);
  }

  async stats() {
    await this.#ensure();
    const rows = await this.#sy.sql(
      `SELECT
         SUM(CASE WHEN ial LIKE '%${ATTR.status}="current"%' THEN 1 ELSE 0 END) AS n_current,
         SUM(CASE WHEN ial LIKE '%${ATTR.status}="superseded"%' THEN 1 ELSE 0 END) AS n_superseded,
         COUNT(*) AS n_total
       FROM blocks WHERE type='p' AND ial LIKE '%${ATTR.hash}="%'`
    );
    // 别名不能用 current / total：前者是 SQL 关键字，查得出来但取不到字段。
    const r = rows?.[0] ?? {};
    return {
      current: Number(r.n_current) || 0,
      superseded: Number(r.n_superseded) || 0,
      total: Number(r.n_total) || 0,
    };
  }
}

/** ial 是 `{: id="..." custom-mem-status="current"}` 这种形式，不是 JSON。 */
export function attrOf(ial, key) {
  const m = String(ial ?? "").match(new RegExp(`${key}="([^"]*)"`));
  return m ? m[1] : "";
}

function toHit(row) {
  return {
    id: row.id,
    text: String(row.content ?? "").replace(/<[^>]+>/g, "").trim(),
    entity: attrOf(row.ial, ATTR.entity),
    type: attrOf(row.ial, ATTR.type),
    status: attrOf(row.ial, ATTR.status) || "unknown",
    source: attrOf(row.ial, ATTR.source),
    date: attrOf(row.ial, ATTR.date),
    confidence: Number(attrOf(row.ial, ATTR.confidence)) || 0,
    created: row.created,
  };
}

export function formatHits(hits) {
  if (!hits.length) return "（没有命中）";
  return hits
    .map((h) => {
      const tag = [h.entity, h.type, h.date].filter(Boolean).join(" · ");
      const mark = h.status === "superseded" ? " [已过时]" : "";
      return `- ${h.text}${mark}\n  ${tag}${h.source ? ` · ${h.source}` : ""}  ${h.id}`;
    })
    .join("\n");
}
