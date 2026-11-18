/**
 * 毫秒时间戳 → 本地日期（YYYY-MM-DD）。
 *
 * 不能用 toISOString()：那是 UTC，凌晨的会话会落到前一天。用户看到的日子
 * 得跟他聊天记录上的日期对得上。
 *
 * 抽出来单独一份，是因为「会话日期」现在有两个使用方：边缘组包时给整包一个
 * 兜底日期，中心写条目时按条目落在的那一轮取日期。两处算法必须一致。
 */
export function ymd(ms) {
  const t = Number(ms);
  const d = new Date(Number.isFinite(t) && t > 0 ? t : Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
