import test from "node:test";
import assert from "node:assert/strict";
import { anchorsOf, narrowAnchor } from "../src/util/raw.mjs";

/** 造一批 turns。下标就是 normalizeTurns 里那个 at，跟 e.from/e.to 同一坐标系。 */
function turnsOf(n, fill = (i) => `第 ${i} 轮聊的是别的主题，内容各不相同 ${i}`) {
  return Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: fill(i) }));
}

test("一批 12 行的粗指针，硬锚落在中间两行：收窄到那几轮", () => {
  const turns = turnsOf(12);
  turns[5] = { role: "user", text: "把 maxCharsPerCall 调到 16000 会不会太大" };
  turns[6] = {
    role: "assistant",
    text: "maxCharsPerCall 默认 16000 字符，实测一批约一万 token，改到 8000 更稳。",
  };
  const r = narrowAnchor("抽取按字符分批，maxCharsPerCall 默认 16000 字符，实测约一万 token", turns, 0, 11);
  assert.equal(r.narrowed, true, `应该收窄，实际 ${r.reason}`);
  assert.ok(r.from <= 5 && r.to >= 6, `窗口要盖住出处 5、6，实际 ${r.from}-${r.to}`);
  assert.ok(r.to - r.from + 1 < 10, `得比原来窄，实际 ${r.rows} 行`);
});

test("每行都有的 token 不算强锚：否则整批都被当成出处，收不了窄", () => {
  const turns = turnsOf(12, (i) => `nginx 这一轮讲的是第 ${i} 个配置项，别的具体内容各不相同`);
  turns[6] = { role: "assistant", text: "nginx 容器内监听 7788，宿主映射写成了 7789，改回去就好。" };
  const r = narrowAnchor("端口映射：nginx 容器内监听 7788，宿主映射写成 7789", turns, 0, 11);
  // nginx 在 12 行里都出现，df=12 会被滤掉；靠 7788/7789 定位。
  assert.equal(r.narrowed, true, `应该收窄，实际 ${r.reason}`);
  assert.ok(r.from <= 6 && r.to >= 6);
  assert.ok(r.rows <= 4, `不该把整批都包进来，实际 ${r.rows} 行`);
});

test("跨轮归纳：锚点分散在首尾，原样返回，不许硬塞进两行", () => {
  const turns = turnsOf(12);
  turns[0] = { role: "user", text: "restic backup 的快照放在哪块盘" };
  turns[11] = { role: "assistant", text: "docker compose 起来之后确认 /mnt/backup 挂载正常。" };
  const r = narrowAnchor("迁移顺序：先 restic backup 做快照，再 docker compose 停容器，最后同步到 /mnt/backup", turns, 0, 11);
  assert.equal(r.narrowed, false, "分散的硬锚不能收窄");
  assert.equal(r.from, 0);
  assert.equal(r.to, 11);
});

test("软锚证据掉太多：也不收窄（结论是跨好几轮概括出来的）", () => {
  const turns = turnsOf(12);
  turns[1] = { role: "assistant", text: "备份策略是每天凌晨做一次，保留七天。" };
  turns[5] = { role: "assistant", text: "容器内监听 7788，宿主映射写成 7789。" };
  turns[10] = { role: "assistant", text: "证书续期用 acme，到期前三十天自动跑。" };
  const r = narrowAnchor("备份策略每天一次保留七天，端口 7788，证书续期用 acme", turns, 0, 11);
  assert.equal(r.narrowed, false, `硬锚在 5，中文证据在 1 和 10，收窄会丢证据：${r.reason}`);
});

test("一点信号都没有：原样返回，说清原因", () => {
  const turns = turnsOf(12, (i) => `nothing relevant here ${i}`);
  const r = narrowAnchor("当时的结论是这套方案整体上更稳妥一些", turns, 0, 11);
  assert.equal(r.narrowed, false);
  assert.equal(r.from, 0);
  assert.equal(r.to, 11);
  assert.ok(["no-signal", "no-usable-hard"].includes(r.reason), `没信号就没法定位，实际 ${r.reason}`);
});

test("本来就很窄（<4 行）不动：收窄没有意义，还有风险", () => {
  const turns = turnsOf(3);
  const r = narrowAnchor("端口映射 7788", turns, 0, 2);
  assert.equal(r.narrowed, false);
  assert.equal(r.reason, "already-tight");
});

test("指针路径本身不算锚点：同一批条目都带着它，没有区分度", () => {
  const { hard } = anchorsOf("判重评测 原文 assets/mem-raw/laptop/workbuddy/xxx.p16.jsonl#1568-1576");
  assert.ok(!hard.some((h) => h.includes("mem-raw")), `路径不该进锚点：${hard.join(",")}`);
  assert.ok(!hard.some((h) => h.includes("jsonl")), `后缀不该进锚点：${hard.join(",")}`);
});

test("没有能在原文落地的硬锚：宁可不收窄，也不靠中文片段猜", () => {
  // 存量抽检里指偏的大半是这种：结论讲 .gitignore / dist.mjs，窗口却落在
  // 「线上中心无响应」的排查长回复上——纯中文片段在同话题对话里到处都重合。
  const turns = turnsOf(12);
  turns[7] = { role: "assistant", text: "亚狮龙 NO.2 属于竞赛级用球，鹅毛，适合比赛；训练用鸭毛的就够。" };
  const r = narrowAnchor("羽毛球比赛用球选亚狮龙竞赛级，训练用鸭毛款即可", turns, 0, 11);
  assert.equal(r.narrowed, false);
  assert.equal(r.reason, "no-usable-hard");
});

test("常见中文词在窗口外反复出现：按次数算会把分母撑爆，必须按种类算", () => {
  const turns = turnsOf(12, (i) => `判重规则又调了一次，第 ${i} 轮，判重判重判重`);
  turns[6] = {
    role: "assistant",
    text: "判重规则：把 maxCharsPerCall 从 16000 调到 8000，抽取按字符分批。",
  };
  // 「判重 / 规则」在 12 行里重复了几十次。按出现次数当分母时，窗口只留 3 行
  // 就保不住 80%，会被误判成 scattered-soft；按种类算则这些词在窗口里都还在。
  const r = narrowAnchor("判重规则改了：抽取按字符分批，maxCharsPerCall 调到 8000", turns, 0, 11);
  assert.equal(r.narrowed, true, `常见词不该挡住收窄：${r.reason}`);
  assert.ok(r.from <= 6 && r.to >= 6);
});

test("plugin: 注入块不参与打分：同一份原文，注入行有没有内容结果必须一样", () => {
  const text = "抽取按字符分批，maxCharsPerCall 调到 8000";
  const turns = turnsOf(12);
  turns[4] = {
    role: "user",
    source: { kind: "plugin:memory" },
    text: "历史结论：maxCharsPerCall 默认 16000，抽取按字符分批，实测一批约一万 token。",
  };
  turns[6] = { role: "assistant", text: "maxCharsPerCall 调到 8000，抽取按字符分批。" };
  const withInjected = narrowAnchor(text, turns, 0, 11);
  const blanked = turns.map((t, i) => (i === 4 ? { ...t, text: "" } : t));
  const without = narrowAnchor(text, blanked, 0, 11);
  assert.deepEqual(
    [withInjected.from, withInjected.to, withInjected.narrowed],
    [without.from, without.to, without.narrowed],
    "注入行（装的是以前抽出的结论）不该影响窗口，否则指针会指向插件注入"
  );
  assert.ok(withInjected.from <= 6 && withInjected.to >= 6, "峰值应落在真实对话那行");
});

test("话题词均匀铺满 60 行、硬锚只在第 7 行：不许报收窄却指偏", () => {
  const turns = turnsOf(60, (i) => `判重规则抽取分批字符模型结论配置，第 ${i} 轮`);
  turns[7] = {
    role: "assistant",
    text: "alpha-7 和 maxCharsPerCall-7 只在这一行出现，判重规则抽取分批字符模型结论配置。",
  };
  const r = narrowAnchor("alpha-7 与 maxCharsPerCall-7 的配置，判重规则抽取分批字符模型结论", turns, 0, 59);
  if (r.narrowed) {
    assert.ok(r.from <= 7 && r.to >= 7, `窗口要盖住证据行，实际 ${r.from}-${r.to}`);
    assert.ok(r.rows <= 12, `不能再跨几十行还叫收窄，实际 ${r.rows} 行（${r.reason}）`);
  }
});
