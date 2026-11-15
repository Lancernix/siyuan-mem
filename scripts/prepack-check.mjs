// 发版前拦一道：本机可能有 deploy/data/（思源 token、模型 key、ingest token），
// files 白名单收窄后仍不放心，直接在 tarball 清单里查一遍再放行。
// --ignore-scripts 防自己递归调起 prepack。
import { execFileSync } from "node:child_process";

let files;
try {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  files = JSON.parse(raw)[0].files.map((f) => f.path);
} catch {
  // 清单读不出来就别发：宁可挡住一次，也不能在看不见内容的情况下 publish。
  console.error("prepack: 拿不到 tarball 清单，拒绝发版");
  process.exit(1);
}

const bad = files.filter((p) =>
  /^deploy\/(sandbox\/)?data\//.test(p) ||
  /(^|\/)\.env(\..*)?$/.test(p) ||
  /(^|\/)(secrets?|credentials|tokens?)[^/]*\.(json|ya?ml|toml|txt)$/i.test(p) ||
  (/(^|\/)config\.json$/.test(p) && !/example/i.test(p))
);

if (bad.length) {
  console.error("prepack: tarball 里有真实配置，拒绝发版 → " + bad.join(", "));
  process.exit(1);
}
// 只走 stderr：stdout 是 npm pack --json 的数据通道，混一行日志就把清单解析搞坏。
console.error(`prepack: ${files.length} 个文件，无真实配置`);
