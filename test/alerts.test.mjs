/**
 * 告警条：同一种问题只留一条，清掉就真的没了。
 * 这里验的是「不会把面板堆满重复告警」这条，别的一行不多测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "mem-alerts-"));
const { alerts, raise, clear } = await import("../src/core/alerts.mjs");

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
