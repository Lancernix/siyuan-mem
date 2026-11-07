/**
 * 一轮复审里被抓出来的确定性缺陷。每条都对应一次真实的数据丢失或错写，
 * 不是风格问题——所以每条都得钉住，防止改回去。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { dedupe } from "../src/shared/readers/index.mjs";
import { ingestKey } from "../src/center/inbox.mjs";
import { mergeEntries, planBatches } from "../src/center/extract.mjs";
import { startUi } from "../src/center/ui.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("消息去重不能拿前 120 字当身份证", () => {
  // 两条用户消息开头一样、结尾不同。旧实现只比「角色 + 前 120 字」，
  // 第二条会被当成重放的同一句直接丢掉——丢的是用户真正问的那句。
  const head = "同一个问题：" + "细节".repeat(70);
  const a = { role: "user", text: `${head} 结论 FIRST` };
  const b = { role: "user", text: `${head} 结论 SECOND` };
  const out = dedupe([a, b]);
  assert.equal(out.length, 2, "开头相同但内容不同，两条都得留下");
  assert.equal(out[1].text.endsWith("SECOND"), true);

  // 真正重放的完全相同的相邻轮仍要去掉。
  assert.equal(dedupe([a, { ...a }]).length, 1);
});

test("幂等键要区分起始轮次：同内容不同区间的两包不能撞", () => {
  const turns = [{ role: "user", text: "同样的问" }, { role: "assistant", text: "同样的答" }];
  const k1 = ingestKey({ machine: "Mac", harness: "dsh", session_id: "s1", turns, turnFrom: 1 });
  const k8 = ingestKey({ machine: "Mac", harness: "dsh", session_id: "s1", turns, turnFrom: 8 });
  assert.notEqual(k1, k8, "第 1 轮和第 8 轮的同样问答是两个合法分片，不能判成重复");

  // 同样的入参必须稳定（同一条被重推时才能去重）。
  assert.equal(k1, ingestKey({ machine: "Mac", harness: "dsh", session_id: "s1", turns, turnFrom: 1 }));
});

test("长问答切段后，每一段都还带着原来的轮次范围", () => {
  // 不带 from/to 的话，切出来的条目算不出原文指针——实测 4 段全是 undefined。
  const long = "这一轮很长。".repeat(400);
  const batches = planBatches([{ q: long, a: "", from: 12, to: 12 }], 500);
  const segs = batches.flat();
  assert.ok(segs.length > 1, "应该被切成多段");
  for (const s of segs) {
    assert.equal(s.from, 12, "分段必须保留 from");
    assert.equal(s.to, 12, "分段必须保留 to");
  }
});

test("前 40 字相同的两条不同结论，不能合并成一条", () => {
  // 旧实现比「去掉空白后的前 40 字」，两条开头一样就合并，留下长的那条。
  const head = "订货系统 的索引用法是这样的：";
  const a = {
    text: `${head}查询真的会发生且当前没有索引可用，两条都成立才加。`,
    entity: "订货系统",
    brief: "两条都成立才加索引",
    confidence: 3,
  };
  const b = {
    text: `${head}不要提前加，等出现慢查询再补，加了反而拖慢写入。`,
    entity: "订货系统",
    brief: "等慢查询再补",
    confidence: 3,
  };
  const { entries } = mergeEntries([a, b], 10);
  assert.equal(entries.length, 2, "结论相反的两条不能被当成重复");

  // 同一句一字不差的重复仍然要合掉。
  const same = mergeEntries([a, { ...a }], 10);
  assert.equal(same.entries.length, 1);
});

test("面板的「跑一轮」不接受跨站请求", async () => {
  let ran = 0;
  const ui = startUi({
    port: 0,
    runRound: async () => {
      ran++;
      return { written: 0 };
    },
  });
  for (let i = 0; i < 100 && !ui.listening; i++) await sleep(10);

  const evil = await fetch(ui.url + "/api/run", {
    method: "POST",
    headers: { Origin: "https://untrusted.example" },
  });
  assert.equal(evil.status, 403, "带外部 Origin 的 POST 必须被拒");
  assert.equal(ran, 0, "被拒的请求不能真的跑起来");

  // 面板自己发的是同源请求。
  const ok = await fetch(ui.url + "/api/run", {
    method: "POST",
    headers: { Origin: ui.url, "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ran, 1);

  // curl 这类不带 Origin 的客户端照旧能用。
  const curl = await fetch(ui.url + "/api/run", { method: "POST" });
  assert.equal(curl.status, 200);
  assert.equal(ran, 2);

  await ui.close();
});
