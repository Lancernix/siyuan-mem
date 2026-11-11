import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * HOME_DIR 是模块加载时算出来的，所以要换表必须在子进程里换 HOME。
 * 返回 {loose, strict}：loose 是默认调用的结果长度，strict 是 null 或长度。
 */
function probe(setup) {
  const home = mkdtempSync(join(tmpdir(), "mem-ent-"));
  mkdirSync(join(home, ".siyuan-mem"), { recursive: true });
  setup(join(home, ".siyuan-mem", "entities.json"));
  const code = `
    const { loadEntities } = await import(${JSON.stringify(join(ROOT, "src/core/entities.mjs"))});
    const a = loadEntities();
    const b = loadEntities({ strict: true });
    console.log(JSON.stringify({
      loose: Array.isArray(a) ? a.length : "null",
      strict: b === null ? "null" : Array.isArray(b) ? b.length : "?",
    }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: ROOT,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return JSON.parse(out.trim());
}

test("文件不存在 = 全新安装，两种模式都当空表，不算读失败", () => {
  const r = probe(() => {});
  assert.deepEqual(r, { loose: 0, strict: 0 });
});

test("合法表：两种模式都读出来", () => {
  const r = probe((p) => writeFileSync(p, JSON.stringify([{ name: "甲", aliases: [], status: "active" }])));
  assert.deepEqual(r, { loose: 1, strict: 1 });
});

test("坏 JSON：默认吞成空表，strict 要报 null（不能说「没有这个话题」）", () => {
  const r = probe((p) => writeFileSync(p, "{ this is not json"));
  assert.equal(r.loose, 0);
  assert.equal(r.strict, "null");
});

test("JSON 不是数组：同样算读失败", () => {
  const r = probe((p) => writeFileSync(p, '{"name":"甲"}'));
  assert.equal(r.strict, "null");
});

test("路径是目录（EISDIR）：读失败，不是空表", () => {
  const r = probe((p) => mkdirSync(p, { recursive: true }));
  assert.equal(r.strict, "null");
});
