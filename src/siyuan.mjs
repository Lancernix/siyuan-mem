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

  /** 批量设属性。回填一整批条目的实体名时用，几十次单发太慢。 */
  async setBlockAttrsBatch(pairs) {
    // pairs: [{ id, attrs }]。空数组会被内核当参数错误，直接跳过。
    if (!pairs?.length) return null;
    return this.#post("/api/attr/batchSetBlockAttrs", { blockAttrs: pairs }, 30000);
  }

  /** 读块的 kramdown（含属性注释）。读待确认文档用这个，比拼 SQL 稳。 */
  async getBlockKramdown(id) {
    const d = await this.#post("/api/block/getBlockKramdown", { id });
    return d?.kramdown ?? "";
  }

  /**
   * 上传附件到 data/assets 下的子目录，返回 assets 相对路径（`assets/xxx/yyy.jsonl`）。
   *
   * 两个必须知道的：内核会自动给文件名加时间戳和随机后缀，所以路径必须以返回值为准，
   * 不能按传入的文件名推；同名文件不会被覆盖，只会变成另一个新名字。
   * 返回的是相对路径，站内访问要拼 baseUrl，例如 `GET /assets/xxx/yyy.jsonl`。
   */
  async uploadAsset(dirPath, filename, buffer, mime = "application/octet-stream") {
    const form = new FormData();
    // 结尾的斜杠不能省：内核把它当 "assets/子目录/"，省了会落到 assets/ 根下。
    form.append("assetsDirPath", dirPath.endsWith("/") ? dirPath : `${dirPath}/`);
    form.append("file[]", new Blob([buffer], { type: mime }), filename);

    const headers = {};
    if (this.#token) headers.Authorization = `Token ${this.#token}`;

    let res;
    try {
      res = await fetch(`${this.#base}/api/asset/upload`, {
        method: "POST",
        headers,
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      const reason = e.name === "TimeoutError" ? "超时 120s" : e.message;
      throw new Error(`上传附件失败（${filename}）：${reason}`);
    }
    if (!res.ok) throw new Error(`上传附件 HTTP ${res.status}（${filename}）`);
    const body = await res.json();
    if (body.code !== 0) throw new SiYuanError("/api/asset/upload", body.code, body.msg);
    const failed = body.data?.failedFiles ?? body.data?.errFiles;
    if (failed?.length) throw new Error(`上传附件失败（${filename}）：${JSON.stringify(failed).slice(0, 200)}`);
    const path = body.data?.succFiles?.[0]?.path;
    if (!path) throw new Error(`上传附件没有返回路径：${JSON.stringify(body.data).slice(0, 200)}`);
    return path;
  }

  /** 按 assets 相对路径取回文本。只用于读原文，二进制不要走这里。 */
  async getAsset(path) {
    const url = `${this.#base}/${String(path).replace(/^\/+/, "")}`;
    const headers = {};
    if (this.#token) headers.Authorization = `Token ${this.#token}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`读取附件 HTTP ${res.status}（${path}）`);
    return await res.text();
  }

  removeDoc(id) {
    // 注意：这个接口返回 code:0 之后，SQL 索引里还要几秒才消失。
    return this.#post("/api/filetree/removeDocByID", { id });
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
