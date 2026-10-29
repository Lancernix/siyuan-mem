/**
 * 思源内核的 HTTP 客户端。
 *
 * 只走 HTTP，不走 CLI：CLI 每次要起一个内核进程，实测 150ms 对 7ms，
 * 而且它直接开工作区数据库，跟正在运行的 app 抢同一个 SQLite，长期会有锁冲突。
 * CLI 留给人手敲和 --dry-run 验证。
 */

const esc = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/'/g, "''");

export class SiYuanError extends Error {
  constructor(api, code, msg) {
    super(`${api} 失败（code=${code}）：${msg || "无错误信息"}`);
    this.api = api;
    this.code = code;
  }
}

export class SiYuan {
  #base;
  #token;
  #timeoutMs;

  constructor({ baseUrl, token = "", timeoutMs = 5000 }) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#token = token;
    this.#timeoutMs = timeoutMs;
  }

  async #post(api, payload = {}, timeoutMs = this.#timeoutMs) {
    const headers = { "Content-Type": "application/json" };
    if (this.#token) headers.Authorization = `Token ${this.#token}`;
    let res;
    try {
      res = await fetch(this.#base + api, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const reason = e.name === "TimeoutError" ? `超时 ${timeoutMs}ms` : e.message;
      throw new Error(`连不上思源（${this.#base}${api}）：${reason}`);
    }
    if (!res.ok) throw new Error(`${api} HTTP ${res.status}`);
    const body = await res.json();
    // 思源遇到不支持的语句也返回 code:0，所以返回值要按调用方语义再校验一次。
    if (body.code !== 0) throw new SiYuanError(api, body.code, body.msg);
    return body.data;
  }

  version() {
    return this.#post("/api/system/version");
  }

  listNotebooks() {
    return this.#post("/api/notebook/lsNotebooks").then((d) => d?.notebooks ?? []);
  }

  /** 返回新笔记本的 id。接口包了一层 data.notebook，直接把 data 当 id 会传给后面的接口报类型错。 */
  async createNotebook(name) {
    const data = await this.#post("/api/notebook/createNotebook", { name });
    const id = data?.notebook?.id ?? data?.id;
    if (!id) throw new Error(`createNotebook 没有返回 id：${JSON.stringify(data).slice(0, 120)}`);
    return id;
  }

  removeNotebook(id) {
    return this.#post("/api/notebook/removeNotebook", { notebook: id });
  }

  /** 用 markdown 建文档，path 是文档在笔记本里的路径，例如 "/01-条目"。 */
  createDocWithMd(notebook, path, markdown = "") {
    return this.#post("/api/filetree/createDocWithMd", { notebook, path, markdown });
  }

  /**
   * 在文档末尾追加一个块，返回新块 id。
   *
   * 返回值不是 id，是一个 transaction 数组：`[{doOperations:[{action:"insert", id:"..."}]}]`。
   * 直接当字符串用会静默变成 undefined，后面的 setBlockAttrs 才报错，排查会绕远。
   */
  async appendBlock(parentID, data, dataType = "markdown") {
    const r = await this.#post("/api/block/appendBlock", { parentID, dataType, data });
    const tx = Array.isArray(r) ? r[0] : r;
    const op = tx?.doOperations?.find((o) => o?.action === "insert" && o?.id);
    if (!op?.id) throw new Error(`appendBlock 没有返回块 id：${JSON.stringify(r).slice(0, 120)}`);
    return op.id;
  }

  deleteBlock(id) {
    return this.#post("/api/block/deleteBlock", { id });
  }

  setBlockAttrs(id, attrs) {
    return this.#post("/api/attr/setBlockAttrs", { id, attrs });
  }

  getBlockAttrs(id) {
    return this.#post("/api/attr/getBlockAttrs", { id });
  }

  sql(stmt) {
    return this.#post("/api/query/sql", { stmt });
  }

  /**
   * 按人类可读路径找文档，`/01-条目` 这种。
   *
   * 不能用 path 字段：它是 `/20261029095926-367glk8.sy` 这种带块 id 的内部路径，
   * 中文名只存在 hpath 里。用 path 查永远返回空，于是每次 init 都新建一份同名文档，
   * 二十几分钟就能堆出六十个空文档。
   */
  async docIdByHPath(notebookId, hpath) {
    const rows = await this.sql(
      `SELECT id FROM blocks WHERE type='d' AND box='${notebookId}' AND hpath='${esc(hpath)}'
        ORDER BY created ASC LIMIT 1`
    );
    return rows?.[0]?.id ?? null;
  }
}
