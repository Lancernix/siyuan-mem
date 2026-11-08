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

  /**
   * 改笔记本的名字。id 不变，块、属性、引用全不动。
   *
   * 单独给个方法而不是让人去点界面：改名之后配置里那份名字就过期了，
   * 而 mem 现在靠 notebookId 认路，所以这件事可以完全在命令行里闭环。
   */
  renameNotebook(id, name) {
    return this.#post("/api/notebook/renameNotebook", { notebook: id, name });
  }

  removeNotebook(id) {
    return this.#post("/api/notebook/removeNotebook", { notebook: id });
  }

  /** 用 markdown 建文档，path 是文档在笔记本里的路径，例如 "/01-条目"。 */
  /**
   * 建文档。刚建完笔记本、或刚重启内核时，思源的后台索引还没跟上，这里会返回
   * `document metadata is not ready`。以前是把这个错直接抛给用户，让人"等几秒再跑一次"——
   * 初始化流程里连着建四个文档，每次都靠人手重跑一遍很蠢。这里自己重试。
   */
  async createDocWithMd(notebook, path, markdown = "") {
    let lastErr;
    for (let i = 0; i < 6; i++) {
      try {
        return await this.#post("/api/filetree/createDocWithMd", { notebook, path, markdown });
      } catch (e) {
        lastErr = e;
        if (!/not ready|metadata/i.test(e.message ?? "")) throw e;
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
    throw lastErr;
  }

  /**
   * 在文档末尾追加一个块，返回新块 id。
   *
   * 返回值不是 id，是一个 transaction 数组：`[{doOperations:[{action:"insert", id:"..."}]}]`。
   * 直接当字符串用会静默变成 undefined，后面的 setBlockAttrs 才报错，排查会绕远。
   */
  async appendBlock(parentID, data, dataType = "markdown", { previousID } = {}) {
    // 标题（h1-h6）在思源里是**叶子块**，不能有子块：appendBlock 传 parentID=标题
    // 会直接报 "heading is a leaf block and cannot have children"。
    // 想让内容落在某个标题下面，只能传 previousID，把块插在它后面。
    const payload = { parentID, dataType, data };
    if (previousID) payload.previousID = previousID;
    const r = await this.#post("/api/block/appendBlock", payload);
    const tx = Array.isArray(r) ? r[0] : r;
    const op = tx?.doOperations?.find((o) => o?.action === "insert" && o?.id);
    if (!op?.id) throw new Error(`appendBlock 没有返回块 id：${JSON.stringify(r).slice(0, 120)}`);
    return op.id;
  }

  deleteBlock(id) {
    return this.#post("/api/block/deleteBlock", { id });
  }

  /**
   * 直接子块。**实时**，不走 SQL 索引——刚写完的结构只能靠这个看，
   * SQL 那边要等三秒，而且列表的层级在 ial 里看不出来。
   */
  async childBlocks(id) {
    const d = await this.#post("/api/block/getChildBlocks", { id });
    return Array.isArray(d) ? d : [];
  }

  /**
   * 通用事务。搬块、加列、写属性视图单元格都走它——前端也是这么调的。
   *
   * `reqId` 必填：漏了会报 "Field [reqId] is required"，而且这个错误很容易
   * 被当成"这个接口不支持该操作"。
   */
  transaction(doOperations, undoOperations = []) {
    const reqId = Date.now() + Math.floor(Math.random() * 1000);
    return this.#post("/api/transactions", {
      reqId,
      transactions: [{ doOperations, undoOperations }],
    }, 30000);
  }

  /**
   * 改已有块的正文。
   *
   * 注意：这个接口会**重写整块的 IAL**，块上挂的 custom-* 属性会一并消失。
   * 所以只能用在没有属性的块上（分组标题），条目一律不许走这条路——改一条
   * 属性全丢，而且不报错。真要改条目，先用 getBlockAttrs 存一份再补回去。
   */
  updateBlock(id, data, dataType = "markdown") {
    return this.#post("/api/block/updateBlock", { id, dataType, data });
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

/**
 * 配置里的笔记本 → 真正的 id。
 *
 * 为什么两种都认：id 是身份，名字是给人看的。只认名字的话，改一次名就得把每台
 * 机器的配置全改一遍（中心和边缘各一份）；只认 id 的话，第一次上手得先去库里
 * 抄一个 20 位的串，没人愿意。所以：配了 id 就用 id，没配就按名字找。
 *
 * id 失效（笔记本被删了重建）时退回按名字找，而不是直接报错——库里只有一个叫
 * 这名字的笔记本时，"按名字找到的那个"显然是用户想要的那个。
 */
export async function resolveNotebookId(sy, cfg) {
  const wantId = String(cfg?.siyuan?.notebookId ?? "").trim();
  const name = String(cfg?.siyuan?.notebook ?? "").trim();
  const list = (await sy.listNotebooks()) ?? [];

  if (wantId) {
    if (list.some((n) => n.id === wantId)) return wantId;
    // 配了 id 但库里没有：可能是换了库、或者笔记本被删了。退回名字，别把整条链断掉。
  }
  if (!name) throw new Error("配置里没写笔记本：siyuan.notebook 或 siyuan.notebookId");
  const hit = list.find((n) => n.name === name);
  if (!hit) {
    const names = list.map((n) => n.name).slice(0, 8).join("、");
    throw new Error(`找不到笔记本「${name}」（库里是：${names || "空"}）`);
  }
  return hit.id;
}
