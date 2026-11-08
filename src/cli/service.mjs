/**
 * 注册成系统服务。macOS 用 launchd，Linux 只打印 systemd 单元（不自动装，
 * 各发行版的路径和权限差太多，自动装比不装更危险）。
 *
 * 有个坑值得记：plist 里的可执行文件必须是绝对路径，而且 launchd 的 PATH 只有
 * /usr/bin:/bin:/usr/sbin:/sbin。所以优先指向我们用 bun 编出来的 ~/.siyuan-mem/mem
 * ——它是自带运行时的单文件，谁升级 node/bun 都影响不到它。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_DIR } from "../util/config.mjs";

export const LABEL = "com.siyuan.mem";
export const PLIST_PATH = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);

/**
 * 边缘机器上那个常驻的推送进程。跟中心是两个独立服务：中心跑 serve，
 * 边缘只跑 push --watch。用两个 label 而不是一个带参数的，是因为它们的
 * 生命周期完全不同——停中心不该把推送也停了。
 */
export const LABEL_PUSH = "com.siyuan.mem.push";
export const PLIST_PUSH_PATH = join(homedir(), "Library/LaunchAgents", `${LABEL_PUSH}.plist`);
const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));

/**
 * 源码比二进制新的时候，别用二进制。
 *
 * 这个坑很实：`~/.siyuan-mem/mem` 是 bun 编出来的 90MB 单文件，一旦它存在，
 * resolveRunner 就一直选它。开发期间改了源码却忘了重编，服务跑的还是几天前的
 * 旧代码，而且日志上完全看不出来——表现是"我明明改了 prompt，抽出来的还是老样子"。
 *
 * 所以这里比 mtime：src 目录里任何一个 .mjs 比二进制新，就用 node 跑源码。
 */
function srcNewerThan(binPath) {
  try {
    const binMs = statSync(binPath).mtimeMs;
    // 递归扫。src 下已经分了 shared/center/worker/ops 四层，只扫顶层的写法
    // 在重组那天就会失效——改个 center/extract.mjs 不触发重编，服务跑旧代码，
    // 而且看不出来。所以这里不写死目录名，见 .mjs 就比。
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "node_modules") continue;
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (walk(p)) return true;
        } else if (ent.name.endsWith(".mjs") && statSync(p).mtimeMs > binMs) {
          return true;
        }
      }
      return false;
    };
    // 从 src/ 开始扫，不是 dirname(CLI)。入口搬进 src/cli/ 之后，dirname(CLI)
    // 只有三个文件，改 core/、util/、mcp/ 里的代码不会触发"源码比二进制新"，
    // 服务就静默跑几天前的二进制——表现是"我明明改了提示词，抽出来还是老样子"。
    return walk(join(dirname(CLI), ".."));
  } catch {
    return true; // 读不出来就当源码更新，宁可跑源码
  }
}

/**
 * 首选单文件二进制（且不比源码旧）；否则退回 node 跑源码。
 *
 * mode 决定这个进程干什么：中心是 serve，边缘是 push --watch。两种都从同一条
 * 路里挑运行时，所以"换了 node 版本服务就跑不起来"这个坑只修一次。
 */
export function resolveRunner(mode = "serve") {
  const argv = mode === "push" ? ["push", "--watch"] : ["serve"];
  const bin = join(HOME_DIR, "mem");
  if (existsSync(bin) && !srcNewerThan(bin)) return { program: bin, args: argv, kind: "binary" };
  // 不用 mise 的 shim（脚本，launchd 里没有 mise 环境会找不到版本），
  // 也不用 process.execPath（可能是宿主 App 自带的那份，升级就换路径）。
  // 按稳定性排：mise 装的真身 > homebrew > 当前进程。
  const cands = [
    join(homedir(), ".local/share/mise/installs/node/lts/bin/node"),
    join(homedir(), ".local/share/mise/installs/node/latest/bin/node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    process.execPath,
  ];
  const node = cands.find((c) => existsSync(c)) ?? process.execPath;
  return {
    program: node,
    args: [CLI, ...argv],
    kind: existsSync(bin) ? "source-over-stale-binary" : "source",
  };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function plistFor({ intervalMinutes = 0, mode = "serve" } = {}) {
  const { program, args } = resolveRunner(mode);
  const label = mode === "push" ? LABEL_PUSH : LABEL;
  const sched = intervalMinutes
    ? `  <key>StartInterval</key><integer>${intervalMinutes * 60}</integer>\n`
    : `  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key><false/>\n  </dict>\n  <key>ThrottleInterval</key><integer>30</integer>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${[program, ...args].map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
${sched}  <key>WorkingDirectory</key><string>${esc(homedir())}</string>
  <key>StandardOutPath</key><string>${esc(join(HOME_DIR, mode === "push" ? "launchd.push.out" : "launchd.out"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(HOME_DIR, mode === "push" ? "launchd.push.err" : "launchd.err"))}</string>
</dict>
</plist>
`;
}

function launchctl(args) {
  return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** 服务当前状态：装了没、跑没跑、pid 多少。 */
export function serviceStatus(mode = "serve") {
  const label = mode === "push" ? LABEL_PUSH : LABEL;
  const installed = existsSync(mode === "push" ? PLIST_PUSH_PATH : PLIST_PATH);
  if (process.platform !== "darwin") return { installed, running: false, note: "非 macOS，看 systemd 那节" };
  let out = "";
  try {
    out = launchctl(["print", `gui/${process.getuid()}/${label}`]);
  } catch {
    // 区分"没装"和"装了但没装载"：前者要 install，后者只要 bootstrap 一次。
    return {
      installed,
      loaded: false,
      running: false,
      note: installed ? "plist 在，但 launchctl 里没有（需要装载一次）" : "没装",
    };
  }
  const state = /state = (\w+)/.exec(out)?.[1] ?? "unknown";
  const pid = /pid = (\d+)/.exec(out)?.[1];
  return { installed, loaded: true, running: state === "running", state, pid: pid ? Number(pid) : null };
}

export function install({ intervalMinutes = 0, print = false, mode = "serve" } = {}) {
  const label = mode === "push" ? LABEL_PUSH : LABEL;
  const path = mode === "push" ? PLIST_PUSH_PATH : PLIST_PATH;
  const text = plistFor({ intervalMinutes, mode });
  if (print) return { plist: text, path };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);

  if (process.platform !== "darwin") return { path, note: "已写 plist，但这不是 macOS，跳过 launchctl" };

  // 先卸载同名的旧服务，否则会提示 already loaded。
  try {
    launchctl(["bootout", `gui/${process.getuid()}/${label}`]);
  } catch {}
  const errors = [];
  for (const args of [
    ["bootstrap", `gui/${process.getuid()}`, path],
    ["load", "-w", path], // 老系统只认这个
  ]) {
    try {
      launchctl(args);
    } catch (e) {
      // execFileSync 的 message 只有 "Command failed: …"，真正的原因在 stderr。
      const why = String(e.stderr ?? "").trim().split("\n")[0] || String(e.message).split("\n")[0];
      errors.push(`${args[0]}: ${why.slice(0, 160)}`);
      continue;
    }
    // 关键：launchctl 的退出码不可信。`load` 装失败也回 0（只往 stderr 打一句
    // "Load failed: 5"），所以必须回查一次 print 才算数。
    if (serviceStatus(mode).loaded) return { path, loaded: true };
    errors.push(`${args[0]}: 退出码 0 但服务没出现在 launchctl 里`);
  }
  // 两种都失败：最常见于在沙箱/无 GUI 会话里跑（报 Input/output error, code 5）。
  // 这时 plist 是好的，只是没装上，别谎报成功。
  return {
    path,
    loaded: false,
    error: errors.join("；"),
    hint: `在普通终端里执行：launchctl bootstrap gui/$(id -u) ${path}`,
  };
}

export function uninstall(mode = "serve") {
  const label = mode === "push" ? LABEL_PUSH : LABEL;
  const path = mode === "push" ? PLIST_PUSH_PATH : PLIST_PATH;
  if (process.platform === "darwin") {
    try {
      launchctl(["bootout", `gui/${process.getuid()}/${label}`]);
    } catch {}
  }
  if (existsSync(path)) unlinkSync(path);
  return { path };
}

/** Linux 用：把等价单元打印出来，不落盘。 */
export function systemdUnit({ intervalMinutes = 0, mode = "serve" } = {}) {
  const { program, args } = resolveRunner(mode);
  const exec = [program, ...args].join(" ");
  if (intervalMinutes) {
    return `# ~/.config/systemd/user/siyuan-mem.{service,timer}，或直接 cron：
# */${intervalMinutes} * * * * ${exec} --once
`;
  }
  return `# ~/.config/systemd/user/siyuan-mem.service
[Unit]
Description=siyuan-mem
After=network.target

[Service]
ExecStart=${exec}
Restart=on-failure
RestartSec=30
WorkingDirectory=${homedir()}

[Install]
WantedBy=default.target

# systemctl --user daemon-reload && systemctl --user enable --now siyuan-mem
`;
}

