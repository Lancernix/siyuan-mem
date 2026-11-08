#!/usr/bin/env node
// 出一个自带运行时（bun）的单文件 mem，装到 ~/.siyuan-mem/mem。
//
// 关键不是编译，是编译之后还认不认字：bun 的 node:zlib/fs 是重实现的，
// 我们被"zstdDecompressSync 只解第一帧、1MB 解出 243 字节还不报错"坑过一次。
// 所以产物必须先跑一遍 audit --all，跟 node 的结果逐字对上才允许落盘。
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// 交叉编译：中心是 Linux 服务器时，本机编出来的 darwin 产物没用。
// 用法：node scripts/dist.mjs --target=bun-linux-x64
const targetArg = process.argv.find((a) => a.startsWith("--target="));
const target = targetArg ? targetArg.slice("--target=".length) : "";
const nativeTarget = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const cross = Boolean(target) && !target.includes(nativeTarget);

const OUT =
  process.env.MEM_BIN ?? join(homedir(), ".siyuan-mem", cross ? `mem-${target}` : "mem");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, ...opts });
}

function findBun() {
  if (process.env.BUN) return process.env.BUN;
  try {
    return run("bash", ["-lc", "command -v bun"]).trim();
  } catch {
    throw new Error("找不到 bun。装一个（mise use -g bun@latest）或设 BUN=/path/to/bun");
  }
}

const bun = findBun();
const bunVer = run(bun, ["-v"]).trim();
const staging = mkdtempSync(join(tmpdir(), "mem-dist-"));
const candidate = join(staging, "mem");

try {
  console.log(`bun ${bunVer}  打包中…`);
  const t0 = Date.now();
  run(
    bun,
    ["build", "src/cli/cli.mjs", "--compile", ...(target ? [`--target=${target}`] : []), `--outfile=${candidate}`],
    { stdio: "inherit" }
  );
  const size = (statSync(candidate).size / 1048576).toFixed(0);
  console.log(`  产物 ${size}MB，用时 ${Date.now() - t0}ms${target ? `  target=${target}` : ""}`);

  if (cross) {
    // 交叉编译的产物在本机跑不起来，自证这一步只能留给目标机器。
    // 所以不覆盖默认路径，文件名带 target，避免有人拿它当本机版本用。
    copyFileSync(candidate, OUT);
    chmodSync(OUT, 0o755);
    console.log(`交叉编译，跳过对账（本机跑不了 ${target}）。已放 ${OUT}`);
    console.log(`  到目标机器上先跑：${OUT} status && ${OUT} audit --all（跟那边的 node 对一遍）`);
    process.exit(0);
  }

  // 对账：同一份代码、同一批会话，两边必须逐字相同。
  console.log("对账中（node vs 产物，全部会话）…");
  const ref = run(process.execPath, ["src/cli/cli.mjs", "audit", "--all"]);
  const got = run(candidate, ["audit", "--all"]);

  if (ref !== got) {
    const a = ref.split("\n");
    const b = got.split("\n");
    const lines = Math.max(a.length, b.length);
    console.error("! 对账不一致，不落盘：");
    for (let i = 0; i < lines; i++) {
      if (a[i] !== b[i]) console.error(`  node | ${a[i] ?? "<缺>"}\n  产物 | ${b[i] ?? "<缺>"}`);
    }
    process.exitCode = 1;
  } else {
    copyFileSync(candidate, OUT);
    chmodSync(OUT, 0o755);
    console.log(`对账一致，已装到 ${OUT}`);
    console.log(`  跑一下：${OUT} status`);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
