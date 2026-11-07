/**
 * 召回：从记忆库里查东西。
 *
 * 在这之前整套系统只有写没有读——所有"回忆"都是人手写 SQL 去翻。
 * 这一层补的就是读：给一句话，返回最相关的若干条记忆，带话题、摘要、日期和原文指针。
 *
 * 为什么先用 SQL LIKE 而不是向量、也不走思源的 FTS 接口：
 *
 *   1. 语料是中文短条目，LIKE 的子串匹配对中文本来就是对的（FTS 还要分词）；
 *   2. 我们真正要过滤的是块属性（status/hash/entity），这些只在 ial 里，
 *      先 FTS 再回表反而多一跳；
 *   3. 库现在七百条，LIKE 扫一遍是毫秒级。等上万条再谈索引，那时也该先量一下。
 *
 * 排序不靠"像不像"，靠三件事：词命中次数、话题是否命中、日期新旧。
 * 判重那套（bigram + 模型）在这里没用——那是判"是不是同一件事"，
 * 这里是判"哪几条跟这句话有关"，两回事。
 */
import { loadConfig } from "../shared/config.mjs";
import { SiYuan } from "../shared/siyuan.mjs";
import { event } from "../shared/log.mjs";
import { stripRawLink } from "../shared/raw.mjs";

const ATTR = {
  hash: "custom-mem-hash",
  status: "custom-mem-status",
  entity: "custom-mem-entity",
  brief: "custom-mem-brief",
  date: "custom-mem-date",
  type: "custom-mem-type",
  confidence: "custom-mem-confidence",
  raw: "custom-mem-raw",
  session: "custom-mem-session",
  source: "custom-mem-source",
  project: "custom-mem-project",
};

const attr = (ial, k) => new RegExp(k + '="([^"]*)"').exec(ial ?? "")?.[1] ?? "";
const plain = (s, raw = "") => stripRawLink(s, raw);

/** 把一句话拆成检索词。中文不分词，按空格和标点切，去掉太短的。 */
export function termsOf(q) {
  return String(q ?? "")
    .split(/[\s，。、；：？！,.;:?!()（）\[\]【】"'“”‘’/|]+/)
    .map((t) => t.trim())
    // 英文虚词和单字母没意义，但**单个汉字是有意义的**（"车""书""钱"）。
    // 原来一律要求 ≥2 字，于是 `mem search 车` 拆出空数组，SQL 里没有任何检索条件，
    // 退化成"按更新时间返回最新几十条"——召回全错，还看不出来。
    .filter((t) => (/^[a-z]+$/i.test(t) ? t.length >= 2 : t.length >= 1))
    .filter((t) => !/^(the|and|for|with|that|this)$/i.test(t))
    .slice(0, 6);
}

function scoreOf(row, terms, entity) {
  const text = row.text ?? "";
  let score = 0;
  for (const t of terms) {
    const lower = t.toLowerCase();
    const inText = text.toLowerCase().split(lower).length - 1;
    score += Math.min(inText, 5) * 2;
    if (String(entity).toLowerCase().includes(lower)) score += 6;
    if (String(row.brief).toLowerCase().includes(lower)) score += 3;
  }
  // 新的略微靠前，但不能盖过相关性：一天 -0.05，最多 -5。
  const days = row.date ? Math.max(0, (Date.now() - Date.parse(row.date + "T00:00:00")) / 86400000) : 60;
  score -= Math.min(days * 0.05, 5);
  return score;
}

/**
 * 检索。返回按相关度排好的条目。
 *
 * @param {{q:string, limit?:number, topic?:string, type?:string, status?:string, days?:number}} opts
 */
export async function searchEntries(opts = {}) {
  const cfg = loadConfig();
  const sy = new SiYuan({ baseUrl: cfg.siyuan.baseUrl, token: cfg.siyuan.token, timeoutMs: 8000 });
  const notebook = await resolveNotebook(sy, cfg.siyuan.notebook);
  const terms = termsOf(opts.q);
  const limit = Math.min(Math.max(Number(opts.limit) || 8, 1), 50);
  // 全是标点/空白时没有检索词。这时候不能往下走：SQL 里没有任何 LIKE 条件，
  // 结果会变成"按更新时间排序的最新 N 条"，看着有结果，其实一条都不相关。
  if (!terms.length) return { terms: [], hits: [], reason: "no-terms" };

  const conds = [`box='${notebook}'`, "type='p'", `ial LIKE '%${ATTR.hash}="%'`];
  // status 传空串表示"过时的也要"（`mem search --all`）。
  // **必须白名单**：这个字段原来直接拼进 SQL，而 /api/search 会把外部请求的
  // status 原样透传进来。`status = "x' OR 1=1 -- "` 就能注释掉后面所有条件，
  // 绕过 box / type / hash 收口去读全库。转义不够——非法值本来就该拒绝。
  const status = opts.status === "" ? "" : opts.status || "current";
  if (status && status !== "current" && status !== "superseded") {
    throw new Error(`status 只能是 current / superseded / 空，收到「${String(status).slice(0, 30)}」`);
  }
  if (status) conds.push(`ial LIKE '%${ATTR.status}="${status}"%'`);
  if (opts.topic) conds.push(`ial LIKE '%${ATTR.entity}="${String(opts.topic).replace(/'/g, "''")}"%'`);
  if (opts.project) conds.push(`ial LIKE '%${ATTR.project}="${String(opts.project).replace(/'/g, "''")}"%'`);
  if (opts.type) conds.push(`ial LIKE '%${ATTR.type}="${String(opts.type).replace(/'/g, "''")}"%'`);
  // 日期不在 SQL 里比：ial 里是字符串，SQL 比大小要额外解析；
  // 拿回来在内存里筛更直接（候选最多 300 条）。
  const since = opts.days
    ? new Date(Date.now() - Number(opts.days) * 86400000).toISOString().slice(0, 10)
    : "";
  // 每个词都要出现（AND），但允许出现在正文或属性里——摘要和话题都在属性里。
  for (const t of terms) {
    const esc = t.replace(/'/g, "''");
    conds.push(`(content LIKE '%${esc}%' OR ial LIKE '%${esc}%')`);
  }

  // 这个 LIMIT 是**取候选**的上限，不是结果数。给得太小会静默漏召回：
  // 排序和日期过滤都在内存里做，先被 SQL 砍掉的那些再也回不来。
  const rows = await sy.sql(
    `SELECT id, content, ial FROM blocks WHERE ${conds.join(" AND ")}
       ORDER BY updated DESC LIMIT 2000`
  );
  if (!Array.isArray(rows)) return { terms, hits: [] };

  const hits = rows
    .map((r) => {
      const entity = attr(r.ial, ATTR.entity);
      const brief = attr(r.ial, ATTR.brief);
      const date = attr(r.ial, ATTR.date);
      const raw = attr(r.ial, ATTR.raw);
      // 先切掉原文路径再算分：不切的话，同一场会话的条目会因为共用同一串
      // 路径而互相「像」，排序就变成了「同一场会话的条目聚在一起」。
      const text = plain(r.content, raw);
      return {
        id: r.id,
        entity,
        brief,
        date,
        type: attr(r.ial, ATTR.type),
        confidence: attr(r.ial, ATTR.confidence),
        text,
        raw,
        session: attr(r.ial, ATTR.session),
        source: attr(r.ial, ATTR.source),
        project: attr(r.ial, ATTR.project),
        score: scoreOf({ text, brief, date }, terms, entity),
      };
    })
    .filter((h) => !since || (h.date && h.date >= since))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // 记一次命中，按话题去重（同一轮里同一话题只算一次）。
  // 这是"这条记忆还活着"的唯一真实信号：它被想起来过。
  try {
    const topics = [...new Set(hits.map((h) => h.entity).filter(Boolean))];
    if (topics.length) event("memory.hit", { q: String(opts.q ?? "").slice(0, 60), topics, n: hits.length });
  } catch {
    /* 日志失败不影响检索 */
  }

  return { terms, hits, notebook };
}
