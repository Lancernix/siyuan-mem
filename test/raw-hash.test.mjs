/**
 * 原文指针不能只按轮次范围复用：日志被重写后，同一个范围的内容可能已经变了。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "mem-raw-hash-"));
const { buildPart, archive, loadRawIndex, saveRawIndex } = await import("../src/util/raw.mjs");

const turns = [
  { role: "user", text: "端口映射怎么配？" },
  { role: "assistant", text: "按 1000 改，改完重启容器。" },
];

function indexWithHash() {
  const part = buildPart({ from: 1 }, turns);
  const key = "m|h|s";
  saveRawIndex({ [key]: [{ path: "assets/mem-raw/m/h/old.jsonl", from: 1, to: 2, hash: part.hash }] });
  return part.hash;
}

test("范围相同但内容改了，不复用旧 part", async () => {
  const hash = indexWithHash();
  const uploaded = [];
  const sy = { uploadAsset: async (dir, name, buf) => { uploaded.push({ name, buf }); return `assets/mem-raw/m/h/${name}`; } };
  const changed = turns.map((t, i) => (i === 1 ? { ...t, text: "按 990 改，别重启。" } : t));
  const out = await archive({
    sy,
    cfg: { raw: { enabled: true } },
    ids: {},
    payload: { session_id: "s", machine: "m", harness: "h", turns: changed, turnFrom: 1 },
  });
  assert.equal(uploaded.length, 1, "日志改过了，必须重新归档");
  assert.notEqual(out[0]?.reused, true);

  const saved = loadRawIndex()["m|h|s"];
  assert.equal(saved.length, 2, "新 part 要进索引，并带上自己的 hash");
  assert.ok(saved[1].hash && saved[1].hash !== hash);
});

test("范围与内容都对得上时复用旧 part", async () => {
  indexWithHash();
  let uploads = 0;
  const sy = { uploadAsset: async () => { uploads++; return "assets/mem-raw/m/h/x.jsonl"; } };
  const out = await archive({
    sy,
    cfg: { raw: { enabled: true } },
    ids: {},
    payload: { session_id: "s", machine: "m", harness: "h", turns, turnFrom: 1 },
  });
  assert.equal(uploads, 0, "内容没变就不该重传");
  assert.equal(out[0]?.skip, true);
});
