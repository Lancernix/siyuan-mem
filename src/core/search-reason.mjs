/**
 * 「为什么没查到」只有一套说法。
 *
 * 「查不到」「没问出词」「后端坏了」在界面上必须分开：第一个是答案，第二个换句话
 * 就有救，第三个重试就好。这里只拼字符串，CLI / MCP / 中心 / 自检四处共用。
 */

/** 后端故障：重试有意义，绝不能渲染成「库里没有」。 */
const BACKEND = new Set(["sql-not-array", "backend-error"]);

/** 查询本身没问出东西：换一句话就有救，和召回质量无关。 */
const TRIVIAL = new Set(["no-terms", "no-meaningful-terms"]);

export const isBackendFailure = (reason) => BACKEND.has(String(reason ?? ""));

export const isTrivialQuery = (reason) => TRIVIAL.has(String(reason ?? ""));

/** 后端故障的人话说明。 */
export function failureText(reason, detail = "") {
  if (reason === "sql-not-array") return "思源返回的数据格式不对（不是一个列表）";
  return String(detail || "后端暂时不可用").slice(0, 200);
}

/** 空结果里「为什么空」的补充说明；真的查过没有，返回空串。 */
export function emptyText(reason, terms = []) {
  if (reason === "no-terms") return "这句话里没有可检索的字词（只有标点或空白）。";
  if (reason === "no-meaningful-terms") {
    // 整句拆完有十几个 2-gram，全列出来是一堵墙；挑前几个说明「都是这类词」就够。
    const shown = terms.slice(0, 6).join(" / ");
    return `这句话里没有能定位的词${shown ? `（${shown}）` : ""}——都是「怎么样」「多少」这类不区分主题的词，换个具体的说法。`;
  }
  return "";
}
