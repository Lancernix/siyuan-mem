/**
 * 命令行参数解析。
 *
 * 单独一个文件是为了能测：`--limit=5` 和 `--limit 5` 必须等价，这条曾经写错，
 * 而错了不报错——命令照跑，限制和过滤悄悄失效，是最难发现的一类。
 */

/** 这些键要吃后面那个值；不在表里的 `--xxx` 一律当布尔开关。 */
const VALUED = new Set([
  "entity", "type", "confidence", "limit", "format", "n", "interval", "key", "name", "wire",
  "port", "to", "token", "machine", "quiet", "every", "bind", "alias", "chars", "base",
  // search 的三个过滤条件。漏了它们，`--days 30` 会把 30 当成检索词拼进查询。
  "topic", "days", "status",
]);

export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    // `--k=v` 与 `--k v` 两种都认。
    const raw = a.slice(2);
    const eq = raw.indexOf("=");
    const key = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : null;
    const next = argv[i + 1];
    if (inline != null) {
      flags[key] = inline;
    } else if (VALUED.has(key) && next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { flags, rest };
}
