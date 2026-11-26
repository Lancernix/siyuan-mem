/**
 * 告警条：同一种问题只留一条，清掉就真的没了。
 * 这里验的是「不会把面板堆满重复告警」这条，别的一行不多测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "mem-alerts-"));
const { alerts, raise, clear, reconcile } = await import("../src/core/alerts.mjs");

test("同一个 kind 连报两次只留最新一条", () => {
  raise("dead", "第一个包进了死信");
  raise("dead", "又有两个包进了死信");
  const list = alerts();
  assert.equal(list.filter((a) => a.kind === "dead").length, 1);
  assert.match(list[0].text, /又有两个/);
});

test("不同 kind 各留一条，清空后为空", () => {
  raise("model", "模型不可用");
  assert.equal(alerts().length, 2);
  clear("dead");
  assert.equal(alerts().length, 1);
  clear();
  assert.equal(alerts().length, 0);
});


test("告警会发到群机器人 Webhook，重复内容不重发", async () => {
  const got = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ errcode: 0 }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.MEM_ALERT_WEBHOOK = `http://127.0.0.1:${server.address().port}/hook`;
  try {
    raise("webhook-test", "一次测试告警");
    raise("webhook-test", "一次测试告警"); // 同样的文字不该再发
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(got.length, 1);
    assert.match(got[0].text ?? JSON.stringify(got[0]), /测试告警/);
  } finally {
    delete process.env.MEM_ALERT_WEBHOOK;
    server.close();
  }
});

test("条件消失就自动撤掉告警，不用等人工点", () => {
  clear(); // 前面的用例可能留了别的 kind（webhook-test），先归零
  raise("dead", "1 个会话进了死信");
  raise("unjudged", "3 个会话判重没跑成");
  reconcile({ dead: 1, unjudged: 3, worked: false });
  assert.equal(alerts().length, 2, "条件还在就不能撤");
  reconcile({ dead: 0, unjudged: 0, worked: true });
  assert.equal(alerts().length, 0, "死信捞回、跑通之后黄条该消失");
});
