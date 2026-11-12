/**
 * eval-rank 的取池逻辑，单独抽出来是为了能被测试锁住。
 *
 * 第十八轮复审 P2-1：脚本原来拿 `r.terms` 当打分词集，但生产用的是
 * `wordGate`（日期词被摘出去）。含日期查询会算出线上从没算过的分数，
 * 连顺序都不同。修法是 searchEntries 返回 `scoreTerms`，这里只认它。
 *
 * 这个函数**不许**自己 filter 日期词：那就是「两处各一套日期规则」，
 * 日期那三轮连着踩的正是这个坑。
 */
export function poolGate(r, q = "") {
  if (r.failed) throw new Error(`检索失败（${q}）：${r.reason}`);
  if (!Array.isArray(r.scoreTerms)) {
    throw new Error(`检索层没有返回 scoreTerms（${q}）：离线重排会失真，先升级 searchEntries`);
  }
  return { c: null, label: null, q, gate: r.scoreTerms, rows: r.hits ?? [] };
}
