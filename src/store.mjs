import { createHash } from "node:crypto";
import { SiYuan } from "./siyuan.mjs";
import { loadState, saveState, loadGroups, saveGroups } from "./config.mjs";
import { stripRawLink } from "./raw.mjs";

export const ATTR = {
  status: "custom-mem-status",
  entity: "custom-mem-entity",
  type: "custom-mem-type",
  hash: "custom-mem-hash",
  source: "custom-mem-source",
  session: "custom-mem-session",
  date: "custom-mem-date",
  confidence: "custom-mem-confidence",
  /** 24 字摘要。02-实体 里的块引用锚文本用它，扫一眼就知道那条在说什么。 */
  brief: "custom-mem-brief",
  /** 哪台机器上产生的。多机汇聚之后，没有这一栏就分不清来源。 */
  machine: "custom-mem-machine",
  /**
   * 项目。从会话的 cwd 推出来（见 jobs.projectOf），跟分组标题上那个「项目」是同一个值。
   *
   * 为什么要单独存一份：分组标题只在文档里给人看，SQL 查不到；而「这个项目之前
   * 怎么定的」是召回里最常见的一类问题，靠关键词碰运气命中率很低。
   */
  project: "custom-mem-project",
  /**
   * 原文指针：`assets/mem-raw/Mac/workbuddy/xxx.p1-….jsonl#120-180`。
   * 前半段是附件真实路径（上传时内核会改名，所以必须存下来），后半段是轮次范围。
   * 物理路径指向一个写进去就不再变的文件，所以重写日志、重新切分都不会让指针错位。
   */
  raw: "custom-mem-raw",
  /** 原文那一行在 02-原文 里的块 id。方便从条目跳到索引，不参与定位。 */
  rawpart: "custom-mem-rawpart",
  /** 被谁取代 / 什么时候。链是通的，顺着能走到最新那条。 */
  supersededBy: "custom-mem-superseded-by",
  supersededAt: "custom-mem-superseded-at",
};

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

    // months 是"每个月的条目文档"缓存，init 不能把它冲掉——
    // 冲掉的后果很隐蔽：下次写入 entriesDocFor 找不到缓存，就再建一份同名文档。
    const ids = { notebook: nbId, months: cache.months ?? {} };
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

  /**
   * 这条记忆该写进哪个文档。
   *
   * partition='month' 时按条目日期分：/01-条目/2026-10。按月是因为一个月
   * 150-250 条、4-6 万字，正好在思源舒服的区间；一个文档无限长下去，
   * 大纲、移动端、全文搜索都会变慢。
   *
   * 建的文档 id 记在 state 的 months 里。不能每次按 hpath 查——刚建好的文档
   * 在 SQL 索引里还查不到，下一秒又会建一份一模一样的（这条踩过三次）。
   */
  async entriesDocFor(date) {
    const ids = await this.#ensure();
    if (this.#cfg.siyuan?.partition !== "month") return ids.entries;
    const raw = String(date ?? "");
    const month = /^\d{4}-\d{2}/.test(raw) ? raw.slice(0, 7) : new Date().toISOString().slice(0, 7);
    const hit = ids.months?.[month];
    if (hit) return hit;

    const rootTitle = this.#cfg.siyuan.docs.entries;
    const path = `/${rootTitle}/${month}`;
    let id = await this.#sy.docIdByHPath(ids.notebook, path);
    if (!id) id = await this.#sy.createDocWithMd(ids.notebook, path, "");
    ids.months = { ...(ids.months ?? {}), [month]: id };
    const key = `${this.#cfg.siyuan.baseUrl}#${this.#cfg.siyuan.notebook}`;
    const state = loadState();
    state[key] = ids;
    saveState(state);
    return id;
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
      // 正文留空：文档标题栏已经显示文档名，再写一个 h1 就是同一行字出现两次。
      // 别在这里写技术说明——用户打开笔记第一眼看到的是「custom-mem-status 为 current
      // 才参与召回」，那不是笔记，是数据库的 README。
      return "";
    }
    if (key === "changes") {
      return [`# ${title}`, "", "追加式变更日志，一行一次改动。审阅看这一页，不看全库。", ""].join("\n");
    }
    if (key === "raw") {
      return [
        `# ${title}`,
        "",
        "每个 part 一行，链到 `assets/mem-raw/` 下的 `.jsonl` 原文。",
        "**这一行是附件的保活锚点**：删掉它，附件就变成「未引用资源」，下次清理会一起带走。",
        "条目上的 `custom-mem-raw` 指向具体文件和轮次范围，不是指这里。",
        "",
      ].join("\n");
    }
    if (key === "entities") {
      return [
        `# ${title}`,
        "",
        "一个实体一个段落，内容就是规范名。别名挂在 `custom-mem-aliases`（竖线分隔）。",
        "抽取时会把这批名字带进 prompt，让模型优先复用；新名字由 `entities.mjs` 做归一。",
        "",
      ].join("\n");
    }
    if (key === "digest") {
      return [
        `# ${title}`,
        "",
        "这一页是**给人读的**：按会话分组、按「定了什么 / 是什么 / 偏好什么」分层。",
        "`mem digest` 每次重新生成，改它没用——数据本体在 `01-条目`。",
        "",
      ].join("\n");
    }
    if (key === "pending") {
      // 顺序有讲究：**「待确认」必须放最后**。
      // appendBlock 只会往文档末尾追加，待确认项要落在它自己那节里就不能有东西排在它后面。
      // （第一版把「已否定」放在最后，结果每加一条待确认就跑到已否定下面去了。）
      return [
        `# ${title}`,
        "",
        "打勾 = 合并（`- [X]`），写 `[-]` = 不是同一个，不动 = 继续待确认。",
        "worker 每轮读一次：勾了的合并并删掉，`[-]` 记进否定表也删掉。",
        "",
        "## 已否定（可反悔：把 `[-]` 改回 `[ ]` 就回到待确认）",
        "",
        "## 待确认",
        "",
      ].join("\n");
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

  /**
   * 同一条内容写过就不再写。返回已存在的块 id，或 null。
   *
   * 必须按 notebook 收口：SQL 是全局的，不限定 box 就会拿别的笔记本里的同名条目
   * 当重复，把一条合法记忆挡在库外——而且不报错，只表现为"这条没写进去"。
   */
  async findDuplicate(text) {
    const h = hashOf(text);
    const box = (await this.#ensure()).notebook;
    // 只认 current。被标过时的内容再出现时必须能重新写回来（A 改成 B，后来又改回 A）——
    // 原来不看状态，那把旧的那条还躺在库里，于是"改回来"永远写不进去，库里停在 B。
    const rows = await this.#sy.sql(
      `SELECT id FROM blocks WHERE box='${box}'
         AND ial LIKE '%${ATTR.hash}="${h}"%'
         AND ial LIKE '%${ATTR.status}="current"%' LIMIT 1`
    );
    return rows?.[0]?.id ?? null;
  }

  /**
   * 写一条记忆。返回 {id, duplicate}。
   * @param {{text:string, entity?:string, type?:string, confidence?:number}} entry
   * @param {{source?:string, session?:string, date?:string}} meta
   */
  /**
   * 分组标题。同一会话的条目挂在同一个 `## 日期 · 项目` 下面。
   *
   * 为什么必须分组：五十四条互不相干的句子平铺在一个文档里，人读不下去——
   * 不是句子本身有问题，是失去了「这些话是在聊什么」这个上下文。
   * 分组之后打开文档，先看到的是「哪天、哪个项目」，再往下才是细节。
   */
  /**
   * 写一条，返回落库后的正文块 id。
   *
   * 分组是**标题 + 列表**，不是「列表项 + 同级列表项」。第一版用后者，
   * 分组和条目长得一模一样（同样圆点、同样缩进），只靠加粗区分，
   * 人第一眼会问「这行跟下面是同级，但又不是条目」。
   */
  async #writeInto(entriesDocId, meta, date, text) {
    const session = String(meta.session ?? "");
    // 原文链接挂在**每条**上，指向它自己那几轮（`…jsonl#120-180`），
    // 不是挂在整个会话上。挂在会话上点开是 300 轮，还得自己翻；
    // 而且一条记忆最该能回答的就是「这话当初是在哪说的」。
    const link = meta.raw ? ` [原文](${meta.raw})` : "";
    const body = `${text}${link}`;
    if (!session || this.#cfg.siyuan.groupEntries !== true) {
      return { blockId: await this.#sy.appendBlock(entriesDocId, body, "markdown"), key: "" };
    }
    const groups = loadGroups();
    let g = groups[session];
    // 记录里的分组必须是**这个文档**里的。会话跨月时（10-31 一直聊到 11-01），
    // 新条目该进 2026-11，但记录还指着 2026-10 那份文档里的列表——照着写就是
    // "11 月的条目挂在 10 月的分组标题下"。所以先验归属，不合就本月另起一组。
    //
    // 老记录没有 doc 字段：查一次标题的 root_id 补上（这些块都很旧，索引早稳了）。
    if (g?.list && !g.doc) {
      const doc = await this.#headingDoc(g.heading);
      if (doc) {
        g.doc = doc;
        groups[session] = g;
        saveGroups(groups);
      }
    }
    if (g?.list && g.doc && g.doc !== entriesDocId) g = null;
    // 直接信记录，不查 SQL：块的索引是异步的，刚写完的那条查不到，
    // 一查就会以为锚点没了、又插一个新标题——54 条就插出 54 个标题。
    if (g?.list) {
      const r = await this.#appendOne(g.list, body);
      groups[session].last = r.blockId;
      saveGroups(groups);
      return { blockId: r.blockId, key: session };
    }
    // 标题可能已经在了、只是还没有列表：上一轮这场对话一条都没写出来，
    // 但为原件保活建了标题（见 ensureGroupAnchor）。这时补列表，别再造一个标题。
    // 列表只能靠 previousID 长在标题后面——标题是叶子块，appendBlock 到它身上直接报错。
    const project = String(meta.project || "").trim() || meta.source || "会话";
    const heading = g?.heading ?? (await this.#sy.appendBlock(entriesDocId, `## ${date} · ${project}`, "markdown"));
    await this.#sy.appendBlock(entriesDocId, `- ${body}`, "markdown", { previousID: heading });
    const top = await this.#sy.childBlocks(entriesDocId);
    const at = top.findIndex((b) => b.id === heading);
    const list = top[at + 1];
    if (!list || list.type !== "l") throw new Error("建分组失败：标题后面没出现列表");
    const items = await this.#sy.childBlocks(list.id);
    const first = items[0];
    if (!first) throw new Error("建分组失败：列表是空的");
    const kid = (await this.#sy.childBlocks(first.id))[0];
    const blockId = kid?.id ?? first.id;
    groups[session] = { heading, list: list.id, last: blockId, doc: entriesDocId };
    saveGroups(groups);
    return { blockId, key: session };
  }

  /** 分组标题在哪份文档里。查不到返回空——那就按"不确认"处理，别乱建。 */
  async #headingDoc(headingId) {
    if (!headingId) return "";
    try {
      const rows = await this.#sy.sql(`SELECT root_id FROM blocks WHERE id='${headingId}' LIMIT 1`);
      return rows?.[0]?.root_id ?? "";
    } catch {
      return "";
    }
  }

  /**
   * 只建分组标题、不写条目。用途只有一个：**给原文附件留一个正文引用**。
   *
   * 附件在思源里"被引用"的判定是块正文里出现过这个路径，属性不算。所以一场
   * 对话如果最后一条条目都没写出来（全被 covered，或者压根没抽出东西），
   * 上传的 jsonl 在正文里就没有任何引用，「清理未引用资源」会把它当垃圾扫走。
   *
   * 标题上的链接是会话级的（不带轮次），条目的链接才带各自的轮次范围。
   * 下一轮真写出条目时，#writeInto 会发现标题在、列表没有，补列表就接上了。
   */
  async ensureGroupAnchor(meta = {}, date = "", rawPath = "") {
    const ids = await this.entriesDocFor(date);
    const session = String(meta.session ?? "");
    if (!session || this.#cfg.siyuan.groupEntries !== true) return "";
    const groups = loadGroups();
    const g = groups[session];

    if (g?.heading && (!g.doc || g.doc === ids)) {
      // 标题已存在**不等于**这个 part 已经有引用。老会话（早就写过条目、标题在）
      // 后来又推来一批增量、而这批一条条目都没写出来时，就是这种情况：
      // 标题复用了，新附件仍然没有任何正文引用。
      if (!rawPath) return g.heading;
      const line = String((await this.#sy.getBlockKramdown(g.heading)) ?? "").split("\n")[0].trim();
      if (line.includes(rawPath)) return g.heading;
      // 补一个链接，锚文本带轮次范围（`#675-712` → 「第 675–712 轮」），
      // 不然多个 part 堆在标题上分不清谁是谁。标题没有 custom-mem 属性，改它不丢数据。
      const range = /#(\d+)-(\d+)$/.exec(rawPath);
      const label = range ? `[第 ${range[1]}–${range[2]} 轮](${rawPath})` : `[原文](${rawPath})`;
      await this.#sy.updateBlock(g.heading, `${line} ${label}`, "markdown");
      return g.heading;
    }

    const project = String(meta.project || "").trim() || meta.source || "会话";
    const link = rawPath ? ` [原文](${rawPath})` : "";
    const heading = await this.#sy.appendBlock(ids, `## ${date} · ${project}${link}`, "markdown");
    groups[session] = { heading, list: "", last: heading, doc: ids };
    saveGroups(groups);
    return heading;
  }

  /**
   * 往列表末尾追加一条，返回条目正文块的 id。
   *
   * **不能用 appendBlock 的返回值**：往列表块里插 markdown 列表时，它返回的
   * 是个临时 id，落库之后查不到（实测返回 e0400n3，真实块是 gm6jslt）。
   * 旧代码没踩到，是因为它 append 到列表项、插入的是纯段落，那种情况返回值是真的。
   * 多两次 childBlocks 换一个可靠的 id，比事后发现属性挂在空气上便宜。
   */
  async #appendOne(listId, text) {
    await this.#sy.appendBlock(listId, `- ${text}`, "markdown");
    const items = await this.#sy.childBlocks(listId);
    const last = items[items.length - 1];
    if (!last) throw new Error("列表追加后找不到新项");
    const kids = await this.#sy.childBlocks(last.id);
    return { itemId: last.id, blockId: kids[0]?.id ?? last.id };
  }

  async writeEntry(entry, meta = {}) {
    // 文档按条目日期分，不按"当前那个文档 id"。没有日期（早期调用）才回落到 01-条目。
    const entries = await this.entriesDocFor(meta.date);
    const text = String(entry.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) throw new Error("空条目");

    const h = hashOf(text);
    if (this.#recent.has(h)) return { id: "", duplicate: true };
    const dup = await this.findDuplicate(text);
    if (dup) return { id: dup, duplicate: true };

    const date = meta.date ?? new Date().toISOString().slice(0, 10);
    let blockId;
    try {
      blockId = (await this.#writeInto(entries, meta, date, text)).blockId;
    } catch (e) {
      // 分组标题被手删了（列表跟着没了）：丢掉记录重建一次，再写。
      const session = String(meta.session ?? "");
      if (!session) throw e;
      const groups = loadGroups();
      delete groups[session];
      saveGroups(groups);
      blockId = (await this.#writeInto(entries, meta, date, text)).blockId;
    }
    try {
      await this.#sy.setBlockAttrs(blockId, entryAttrs({ entry, meta, date, hash: h }));
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

  /**
   * 把一条标成被取代。不删，也不动它的原文指针——
   * 改主意的时候最想知道的就是「之前为什么那么想」，那段原话就在旧指针里。
   */
  /**
   * 这个块现在是什么状态。块不存在（或没有这个属性）返回空串。
   * 补偿逻辑靠它判断"还该不该补"，所以不能抛——查不出来交给调用方决定。
   */
  async statusOf(id) {
    if (!id) return "";
    const rows = await this.#sy.sql(
      `SELECT ial FROM blocks WHERE id='${String(id).replace(/'/g, "''")}' LIMIT 1`
    );
    if (!rows?.[0]) return "";
    return attrOf(rows[0].ial, ATTR.status);
  }

  async supersede(id, byId = "") {
    const attrs = { [ATTR.status]: "superseded" };
    if (byId) {
      attrs[ATTR.supersededBy] = byId;
      attrs[ATTR.supersededAt] = new Date().toISOString().slice(0, 10);
    }
    await this.#sy.setBlockAttrs(id, attrs);
    if (this.#cfg.siyuan.logChanges !== false) {
      await this.#logChange(`~ superseded ${id}${byId ? ` → ${byId}` : ""}`);
    }
  }

  /** 各文档的块 id。raw / entities 要往对应文档里写。 */
  async docIds() {
    return await this.#ensure();
  }

  /**
   * 全部 current 条目，判重用。一次读完放在内存里比逐条查 SQL 快得多，
   * 也避开块索引的 3 秒延迟（刚写完的那几条不能靠 SQL 查回来）。
   */
  async listCurrent(limit = 3000) {
    await this.#ensure();
    // 必须按笔记本收口：SQL 是全局的，不收口会把别的笔记本里的条目也读进来，
    // 判重就会去比对不相干的库（实测把 90-记忆 的 864 条读进了试验笔记本）。
    const box = this.#ids?.notebook;
    const rows = await this.#sy.sql(
      `SELECT id, content, ial FROM blocks
        WHERE type='p' AND ial LIKE '%${ATTR.hash}="%'
          AND ial LIKE '%${ATTR.status}="current"%'
          ${box ? `AND box='${box}'` : ""}
        ORDER BY created DESC LIMIT ${limit}`
    );
    return (rows ?? []).map((r) => ({
      id: r.id,
      entity: attrOf(r.ial, ATTR.entity),
      brief: attrOf(r.ial, ATTR.brief),
      // 这份 text 直接喂给判重比相似度，原文路径必须先去掉：同一场会话的条目
      // 共用那串 mem-raw/… 路径，留着会让两条不相干的东西「很像」。
      text: stripRawLink(r.content, attrOf(r.ial, ATTR.raw)).replace(/\s+/g, " ").trim(),
    }));
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
    // 同样按笔记本收口：SQL 不分库，不收口会把别的笔记本的条目算进来。
    const box = this.#ids?.notebook;
    const rows = await this.#sy.sql(
      `SELECT
         SUM(CASE WHEN ial LIKE '%${ATTR.status}="current"%' THEN 1 ELSE 0 END) AS n_current,
         SUM(CASE WHEN ial LIKE '%${ATTR.status}="superseded"%' THEN 1 ELSE 0 END) AS n_superseded,
         COUNT(*) AS n_total
       FROM blocks WHERE type='p' AND ial LIKE '%${ATTR.hash}="%'${box ? ` AND box='${box}'` : ""}`
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

/**
 * 一条记忆的全部属性。抽出来是为了能测：写块要连思源，属性怎么拼不该也得连。
 *
 * 可选项用展开写，不写空串：思源会把 `custom-mem-project=""` 当一个真属性存下来，
 * 于是「没有项目」和「项目是空字符串」变成两种状态，SQL 里查起来就得两个条件。
 */
export function entryAttrs({ entry, meta, date, hash }) {
  return {
    [ATTR.status]: "current",
    [ATTR.entity]: entry.entity || "",
    [ATTR.type]: entry.type || "fact",
    [ATTR.hash]: hash,
    [ATTR.source]: meta.source || "",
    [ATTR.session]: meta.session || "",
    [ATTR.date]: date,
    [ATTR.confidence]: String(entry.confidence ?? 3),
    ...(entry.brief ? { [ATTR.brief]: String(entry.brief) } : {}),
    ...(meta.machine ? { [ATTR.machine]: String(meta.machine) } : {}),
    ...(meta.project ? { [ATTR.project]: String(meta.project) } : {}),
    ...(meta.raw ? { [ATTR.raw]: String(meta.raw) } : {}),
    ...(meta.rawpart ? { [ATTR.rawpart]: String(meta.rawpart) } : {}),
  };
}

/** ial 是 `{: id="..." custom-mem-status="current"}` 这种形式，不是 JSON。 */
export function attrOf(ial, key) {
  const m = String(ial ?? "").match(new RegExp(`${key}="([^"]*)"`));
  return m ? m[1] : "";
}

function toHit(row) {
  const raw = attrOf(row.ial, ATTR.raw);
  return {
    id: row.id,
    // 切掉末尾的原文附件地址：它既是路径又不是正文，留着会让「最近写入」
    // 看上去全是同一串 mem-raw/…，也让判重拿它当相似度。
    text: stripRawLink(row.content, raw),
    raw,
    entity: attrOf(row.ial, ATTR.entity),
    type: attrOf(row.ial, ATTR.type),
    status: attrOf(row.ial, ATTR.status) || "unknown",
    source: attrOf(row.ial, ATTR.source),
    project: attrOf(row.ial, ATTR.project),
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
