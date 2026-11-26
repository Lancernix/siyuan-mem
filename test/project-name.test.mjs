/**
 * 项目名回退：路径本身就是家目录时，不能把用户名当成项目名。
 * 本周 47 条（三成）被记成项目「lancernix_1」，就是因为容器的 homedir() 是
 * /home/node，跟宿主机的 /Users/lancernix_1 对不上。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "mem-project-"));
const { projectOf } = await import("../src/core/jobs.mjs");

test("家目录不当作项目名，退到 harness", () => {
  assert.equal(projectOf("/Users/lancernix_1", "dsh"), "dsh");
  assert.equal(projectOf("/home/node", "claw"), "claw");
  assert.equal(projectOf("/root", "claw"), "claw");
  assert.equal(projectOf("/Users/lancernix_1/", "dsh"), "dsh");
});

test("家目录下的仓库仍然取仓库名", () => {
  assert.equal(projectOf("/Users/lancernix_1/Codes/siyuan-mem", "dsh"), "siyuan-mem");
  assert.equal(projectOf("/home/node/proj", "claw"), "proj");
});
