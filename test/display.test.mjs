/**
 * 展示层：条目正文里那截原文附件地址必须切掉。
 *
 * 思源的 `content` 列会把链接的 href 一起吐出来，所以每条正文末尾都拖着
 * `原文 assets/mem-raw/…jsonl#716-740`。它既不是正文，又跟同一场会话的每条
 * 条目一模一样——留着会让召回结果里路径出现两遍，也会让相似度算出假重复。
 */
import test from "node:test";
import assert from "node:assert/strict";

const { stripRawLink } = await import("../src/shared/raw.mjs");

const RAW = "assets/mem-raw/Mac/dsh/s.p1-20261102104610-j672vve.jsonl#716-740";
const body = "events 少不能直接判定为抽取失败，因为这条链路产出本来就少。";

test("按属性里的 raw 精确切掉，保留正文", () => {
  assert.equal(stripRawLink(`${body} 原文 ${RAW}`, RAW), body);
});

test("属性缺失时按锚文本兜底", () => {
  assert.equal(stripRawLink(`${body} 原文 ${RAW}`), body);
});

test("正文里恰好出现同一段路径时，只切末尾那处", () => {
  const s = `我查过 ${RAW} 这个文件，里面是空的。 原文 ${RAW}`;
  assert.equal(stripRawLink(s, RAW), `我查过 ${RAW} 这个文件，里面是空的。`);
});

test("没有链接就原样返回，别的路径不动", () => {
  const s = "条目按月拆分，路径 01-条目/2026-10，父文档只当目录。";
  assert.equal(stripRawLink(s, RAW), s);
  assert.equal(stripRawLink(`${s} 原文 assets/mem-raw/other.jsonl#1-2`), s);
});

test("HTML 标签和 &nbsp; 顺手清掉（思源偶尔会吐 <br>）", () => {
  assert.equal(stripRawLink(`a<br>b&nbsp;c 原文 ${RAW}`, RAW), "ab c");
});
