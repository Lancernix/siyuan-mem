/**
 * 判重候选的测试：不联网，只看挑候选这一段。
 *
 * 这一段是判重唯一的「可能漏」的环节——模型只看得到送进去的那几条，
 * 少挑一条就是永久看不见一条重复，而且不报错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCandidates } from "../src/dedupe.mjs";

const ENT = "思源笔记每日复盘";

const mk = (id, text, entity = ENT) => ({ id, entity, brief: text.slice(0, 20), text });

test("同话题里按字面覆盖率挑，话题不同的不比", () => {
  const existing = [
    mk("a", "补卡只处理复盘里「今日完成/复写」明确列出的题，跳过「后续仍需补充」和「明日计划」中的未做题。"),
    mk("b", "「06-算法」下的复盘卡按题号升序连续编号，新建卡从当前最大编号接续。"),
    mk("c", "补卡只处理复盘里「今日完成/复写」明确列出的题，跳过「后续仍需补充」「明日计划」里的未做题。", "别的项目"),
  ];
  const news = [mk("n", "补卡只处理复盘里「今日完成/复写」明确列出的题，跳过「后续仍需补充」和「明日计划」中的未做题。")];
  const { plan } = pickCandidates({ news, existing });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].cands.map((c) => c.e.id), ["a"], "只有同话题的 a 该进来");
});

test("覆盖率低于 0.15 的不送模型——那是两回事，不是换个说法", () => {
  const existing = [mk("a", "项目锁 TypeScript 6.0.3，不要跟着模板升到 7。")];
  const news = [mk("n", "没有标记为已完成的题一律不建卡片，哪怕它出现在待办清单里。")];
  assert.equal(pickCandidates({ news, existing }).plan.length, 0);
});

test("候选上限是 10 条，不是 6 条", () => {
  // 同一件事造 12 个详略不同的版本，全都能过 0.15 的门槛。
  const base = "补卡只处理复盘里「今日完成/复写」明确列出的题，跳过「后续仍需补充」和「明日计划」中的未做题";
  const existing = Array.from({ length: 12 }, (_, i) => mk(`e${i}`, `${base}${"啊".repeat(i)}。`));
  const news = [mk("n", `${base}。`)];
  // 6 条召回 87%、10 条 99%——这个上限被实测数字钉住，别随手改小。
  assert.equal(pickCandidates({ news, existing }).plan[0].cands.length, 10);
});

test("一条候选都没有时不产生调用计划", () => {
  const news = [mk("n", "完全不相干的一句话，长度也够。")];
  assert.equal(pickCandidates({ news, existing: [] }).plan.length, 0);
});
