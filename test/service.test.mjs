/**
 * 服务注册的纯逻辑测试：只验 plist 生成，不碰 launchctl（那需要 GUI 会话，
 * 在 CI 或沙箱里必然失败）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { install, plistFor, resolveRunner, systemdUnit, PLIST_PATH } from "../src/cli/service.mjs";

test("常驻版：KeepAlive 只对失败重启，带 ThrottleInterval", () => {
  const p = plistFor({});
  assert.match(p, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>/);
  assert.match(p, /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  assert.doesNotMatch(p, /StartInterval/);
});

test("定时版：换成 StartInterval，秒数换算正确", () => {
  const p = plistFor({ intervalMinutes: 10 });
  assert.match(p, /<key>StartInterval<\/key><integer>600<\/integer>/);
  assert.doesNotMatch(p, /KeepAlive/);
});

test("ProgramArguments 是可执行文件 + 参数，且第一项是绝对路径", () => {
  const { program, args } = resolveRunner();
  assert.ok(program.startsWith("/"), `应该是绝对路径，实际 ${program}`);
  // 两种形态都合法：
  //   单文件二进制   → [serve]
  //   node 跑源码    → [<cli.mjs 绝对路径>, serve]
  // 后者在源码比二进制新的时候会被选中，所以不能再钉死成一种。
  if (args.length === 1) {
    assert.deepEqual(args, ["serve"]);
  } else {
    assert.equal(args.length, 2);
    assert.ok(args[0].startsWith("/"), `cli 路径应该是绝对路径，实际 ${args[0]}`);
    assert.ok(args[0].endsWith("cli.mjs"));
    assert.deepEqual(args.slice(1), ["serve"]);
  }
  const p = plistFor({});
  assert.ok(p.includes(`<string>${program}</string>`), "plist 里应该出现同一个路径");
  assert.ok(p.includes("<string>serve</string>"));
});

test("plist 落在 LaunchAgents 下，label 固定", () => {
  assert.match(PLIST_PATH, /Library\/LaunchAgents\/com\.siyuan\.mem\.plist$/);
  assert.match(plistFor({}), /<key>Label<\/key><string>com\.siyuan\.mem<\/string>/);
});

test("systemd 单元是打印而不是安装", () => {
  const unit = systemdUnit({});
  assert.match(unit, /\[Service\]/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /ExecStart=\//);
  // 定时版只是 cron 的一行注释，不该伪装成 systemd service
  assert.match(systemdUnit({ intervalMinutes: 30 }), /\*\/30 \* \* \* \*/);
});

test("边缘那套：独立的 label，跑 push --watch，日志也是单独一份", () => {
  const p = plistFor({ mode: "push" });
  assert.match(p, /<key>Label<\/key><string>com\.siyuan\.mem\.push<\/string>/);
  assert.match(p, /<string>push<\/string>\s*<string>--watch<\/string>/);
  assert.match(p, /launchd\.push\.out/);
  // 不能和中心混用一个 label：停中心不该把边缘的推送一起停掉。
  assert.doesNotMatch(p, /<key>Label<\/key><string>com\.siyuan\.mem<\/string>/);
  assert.doesNotMatch(p, /<string>serve<\/string>/);
});

test("边缘版和中心版用不同的 plist 路径", () => {
  // 路径不在 plist 正文里，是 install() 返回的那个。两个文件必须分开，
  // 否则装边缘会覆盖掉中心。
  const serve = install({ print: true });
  const push = install({ mode: "push", print: true });
  assert.ok(serve.path.endsWith("com.siyuan.mem.plist"));
  assert.ok(push.path.endsWith("com.siyuan.mem.push.plist"));
  assert.notEqual(serve.path, push.path);
});
