/**
 * 判重候选的测试：不联网，只看挑候选这一段。
 *
 * 这一段是判重唯一的「可能漏」的环节——模型只看得到送进去的那几条，
 * 少挑一条就是永久看不见一条重复，而且不报错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCandidates } from "../src/core/dedupe.mjs";

const ENT = "思源笔记每日复盘";

const mk = (id, text, entity = ENT, project = "") => ({ id, entity, brief: text.slice(0, 20), text, project });

test("同话题的排前面，话题名漂移但字面高度重合的也要进来", () => {
  // 这里原来是「话题不同的不比」。那个规则有个看不见的漏：同一件事被抽成两个
  // 话题名时，两边永远比不到一起，于是互相否定的两条结论都留在 current。
  // 实测就是 bwrap 那对（「本地调试环境」vs「nanobot」）。
  const existing = [
    mk("a", "补卡只处理复盘里「今日完成/复写」明确列出的题，跳过「后续仍需补充」和「明日计划」中的未做题。"),
    mk("b", "「06-算法」下的复盘卡按题号升序连续编号，新建卡从当前最大编号接续。"),
    mk("c", "补卡只处理复盘里「今日完成/复写」明确列出的题，跳过「后续仍需补充」「明日计划」里的未做题。", "别的项目"),
  ];
  const news = [mk("n", "补卡只处理复盘里「今日完成/复写」明确列出的题，跳过「后续仍需补充」和「明日计划」中的未做题。")];
  const { plan } = pickCandidates({ news, existing });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].cands.map((c) => c.e.id), ["a", "c"], "同话题的 a 排前，漂移话题的 c 也要进来");
});

test("同一对句子：同话题进候选，跨话题不进——覆盖率门槛确实分两档", () => {
  // 纯中文、没有共享的英文词，所以只能走覆盖率这条路。这对的覆盖率约 0.185。
  const a = "服务器总内存不到两千兆，交换区已经用掉一大半，所以不能再同时跑两个网关。";
  const b = "可用内存只剩七百兆，交换吃掉七成，两个服务一起跑就会撑爆机器。";
  const asSame = pickCandidates({ news: [mk("n", b)], existing: [mk("e", a)] });
  const asCross = pickCandidates({ news: [mk("n", b, "别的项目")], existing: [mk("e", a)] });
  assert.equal(asSame.plan[0]?.cands.length, 1, "同话题：0.15 的门槛能过");
  assert.equal(asCross.plan[0]?.cands.length ?? 0, 0, "跨话题：0.28 的门槛过不去");
});

test("跨话题但共享一个有辨识度的词：必须进候选——bwrap 那对就是靠这条抓到的", () => {
  // 这两条真实数据的话题名完全不同（本地调试环境 / nanobot），字面覆盖率只有 0.213，
  // 靠覆盖率永远撞不到一起；共同点是 bwrap 这个词全库只出现几次。
  const old = mk("a", "本地调试环境是 bwrap 沙箱，只有 workspace 持久，无 sudo、不能 bind mount。", "本地调试环境");
  const neu = mk("n", "已移除 bwrap 沙箱、保留 rm -rf guard，可用 sudo。", "nanobot");
  const { plan } = pickCandidates({ news: [neu], existing: [old] });
  assert.equal(plan[0]?.cands.length, 1, "共享稀有词要能把它送进模型");
});

test("既没有共享稀有词、覆盖率也低：不进候选", () => {
  const existing = [mk("a", "DataPilot 用 Polars + calamine 引擎 + Parquet 做主存储，替代 Pandas 处理百万行 Excel。", "DataPilot")];
  const news = [mk("n", "复盘卡按题号升序连续编号，新建的卡从当前最大编号往后接一位。", "复盘卡")];
  assert.equal(pickCandidates({ news, existing }).plan.length, 0);
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

// ---- 第三条通道：同项目 ----

test("同项目、纯中文、覆盖率 0.12：进候选（跨项目时进不来）", () => {
  // 这对句子覆盖率 0.12：同话题的 0.15 门槛过不去，跨话题的 0.28 更过不去，
  // 没有任何英文稀有词。只有「同一个项目」这一条能把它们撞到一起。
  const a = "服务器总内存不到两千兆，交换区已经用掉一大半，所以不能再同时跑两个网关。";
  const b = "机器上内存本来就紧张，交换用了七成，再起一个服务就撑不住。";
  const sameProj = pickCandidates({
    news: [mk("n", b, "服务器", "ubuntu")],
    existing: [mk("e", a, "服务器", "ubuntu")],
  });
  assert.equal(sameProj.plan[0]?.cands.length, 1, "同项目要能进来");
  assert.match(sameProj.plan[0].cands[0].why.join(" "), /同项目/);

  const crossProj = pickCandidates({
    news: [mk("n", b, "服务器", "其他项目")],
    existing: [mk("e", a, "服务器", "ubuntu")],
  });
  assert.equal(crossProj.plan[0]?.cands.length ?? 0, 0, "不同项目就该挡在门外");
});

test("项目名都是空的：不走这条通道，否则全库互相成为候选", () => {
  // 老条目可能没有 custom-mem-project（空串）。空对空不当成「同项目」——
  // 那等于把所有没打标签的条目都塞进同一个池子，10 个名额立刻被无关条目占满。
  const a = "服务器总内存不到两千兆，交换区已经用掉一大半，所以不能再同时跑两个网关。";
  const b = "机器上内存本来就紧张，交换用了七成，再起一个服务就撑不住。";
  const r = pickCandidates({ news: [mk("n", b)], existing: [mk("e", a)] });
  assert.equal(r.plan[0]?.cands.length ?? 0, 0);
});

test("同话题的排序加成还在：覆盖率一样时它排在前面", () => {
  // 两段一模一样的正文，唯一的区别是一个挂在同话题下。同话题 +0.06、
  // 另一个只靠覆盖率，所以同话题那条排前面——名额有限时先给先验更强的。
  const text = "服务器总内存不到两千兆，交换区已经用掉一大半，所以不能再同时跑两个网关。";
  const existing = [
    mk("sameProjOnly", text, "内存", "ubuntu"),
    mk("sameEntity", text, "服务器", "ubuntu"),
  ];
  const news = [mk("n", text, "服务器", "ubuntu")];
  const { plan } = pickCandidates({ news, existing });
  assert.deepEqual(plan[0].cands.map((c) => c.e.id), ["sameEntity", "sameProjOnly"]);
});

// ---- 模型的 match 怎么落到候选上 ----

const { resolveMatch } = await import("../src/core/dedupe.mjs");

const IDS = ["20261106132222-mvs7k16", "20261106132214-jgwrzsi", "20261109184651-9t4q5b7"];

test("回编号：按这条新条目自己的候选顺序数，从 1 开始", () => {
  assert.equal(resolveMatch(1, IDS), IDS[0]);
  assert.equal(resolveMatch("3", IDS), IDS[2]);
});

test("编号越界就不认：宁可当没判，也不要落到别的条目上", () => {
  assert.equal(resolveMatch(0, IDS), "");
  assert.equal(resolveMatch(4, IDS), "");
});

test("回完整 id：直接用", () => {
  assert.equal(resolveMatch(IDS[1], IDS), IDS[1]);
});

test("回截断的 id：前缀唯一才认", () => {
  assert.equal(resolveMatch("20261106132222", IDS), IDS[0]);
});

test("截断得能对上两条：不猜", () => {
  // 同一秒建的两条 id 前 14 位一样，猜错比不猜更糟。
  assert.equal(resolveMatch("202611061322", IDS), "");
});

test("回了个不相干的串：不认", () => {
  assert.equal(resolveMatch("abc", IDS), "");
  assert.equal(resolveMatch("", IDS), "");
});

// ---- 提示词里的编号必须按块内序号 ----

const { renderChunk } = await import("../src/core/dedupe.mjs");

const item = (i, text, cands = ["c1", "c2"]) => ({
  i,
  n: { entity: "x", text, brief: "" },
  cands: cands.map((id) => ({ e: { id, entity: "x", text: "候选正文", brief: "" }, s: 1, why: [] })),
});

test("第二块从「新 1」「候选 1」重新数，不是接着上一块编下去", () => {
  // 用全局下标时第二块印的是【新 3】…，解析端按 1..块长 校验，整块决定被丢掉。
  const chunk = [item(5, "第五条的正文"), item(9, "第九条的正文")];
  const text = renderChunk(chunk);
  assert.match(text, /^【新 1】/);
  assert.match(text, /【新 2】/);
  assert.doesNotMatch(text, /【新 6】|【新 10】/);
  assert.match(text, /候选 1：/);
});
