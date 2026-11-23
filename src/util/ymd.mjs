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
  let t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) t = Date.now();
  // 秒级时间戳（10 位）比毫秒级小三个数量级，不换算会落到 1970。
  if (t < 1e12) t *= 1000;
  // 2000 年前 / 未来一天后当脏数据：退回当天，别把时间线污染到 1970。
  if (t < 946684800000 || t > Date.now() + 86400000) t = Date.now();
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
