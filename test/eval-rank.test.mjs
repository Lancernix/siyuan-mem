/**
 * eval-rank 的取池契约：必须用生产真正打分的词集，不能用 r.terms。
 *
 * 第十八轮复审 P2-1 实测：用 r.terms 离线重排「2026 部署计划」得到
 * r3,r1,r2，生产是 r1,r2,r3；纯日期查询更离谱（按正文里 2026 出现次数排，
 * 生产只按新近）。脚本原来没有测试覆盖，改回去不会红，所以单独锁一层。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { poolGate } = await import("../scripts/rank-pool.mjs");

test("P2-1：gate 取 scoreTerms，不是含日期词的 terms", () => {
  const r = {
    terms: ["2026", "部署", "署计", "计划"],
    scoreTerms: ["部署", "署计", "计划"],
    hits: [{ id: "r1", text: "部署计划" }],
  };
  const p = poolGate(r, "2026 部署计划");
  assert.deepEqual(p.gate, ["部署", "署计", "计划"]);
  assert.ok(!p.gate.includes("2026"), "日期词不能参与正文打分");
  assert.equal(p.rows.length, 1);
});

test("P2-1：纯日期查询 scoreTerms 为空，离线也只按新近排", () => {
  const p = poolGate({ terms: ["2026"], scoreTerms: [], hits: [] }, "2026");
  assert.deepEqual(p.gate, []);
});

test("P2-1：检索层没给 scoreTerms 直接中止，不静默退化成 terms", () => {
  assert.throws(
    () => poolGate({ terms: ["部署"], hits: [] }, "部署"),
    /没有返回 scoreTerms/
  );
});

test("P2-1：后端故障先于词集检查，不当成「没这个字段」", () => {
  assert.throws(
    () => poolGate({ failed: true, reason: "sql-not-array" }, "x"),
    /检索失败/
  );
});

test("eval-rank 脚本确实调用了 poolGate，没有绕过去手写取词", () => {
  // 变异验证：把 gate: r.terms 改回去，这条要红。
  const s = readFileSync(new URL("../scripts/eval-rank.mjs", import.meta.url), "utf8");
  assert.match(s, /poolGate\(r, q\)/);
  assert.doesNotMatch(s, /gate:\s*r\.terms/);
});
