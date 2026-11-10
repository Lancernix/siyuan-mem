/**
 * 判重端到端：从 judgeDuplicates 到模型、再回裁决，整条路走一遍。
 *
 * 为什么单开一个文件：原来判重的 17 条测试全是纯函数（挑候选、解析编号、渲染），
 * 没有一条真的调过模型。2026-11-10 就栽在这上面——`judgeChunk` 里引用了一个没传
 * 进来的 `deadline`，每次调用都抛 ReferenceError，被 catch 吞掉当成「这次没重复」，
 * 判重整整失效了几个小时，而所有测试都是绿的。
 *
 * 所以这里只验一件事：**一次判重真的能带着裁决回来**。空 Map 就是失败。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const { judgeDuplicates } = await import("../src/core/dedupe.mjs");

async function withModel(reply, fn) {
  let calls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(reply) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = {
    model: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "test",
      name: "fake",
      wire: "openai",
      provider: "openai",
      jsonMode: true,
      timeoutMs: 5000,
      retries: 0,
    },
  };
  try {
    return await fn({ cfg, calls: () => calls });
  } finally {
    server.close();
  }
}

const ENT = "部署";
const mk = (id, text, entity = ENT) => ({ id, entity, brief: text.slice(0, 20), text, project: "siyuan-mem" });

test("判重真的调到了模型：裁决要带着块号回来，不是空 Map", async () => {
  await withModel({ decisions: [{ new: 1, match: 1, action: "replace" }] }, async ({ cfg, calls }) => {
    const existing = [mk("e1", "容器内 nginx 监听 7788，宿主机映射写成 7789 了，改回去就好。")];
    const news = [mk("n1", "容器里 nginx 监听的是 7788，宿主机映射写成了 7789，要改回来。")];

    const out = await judgeDuplicates({ cfg, news, existing, deadline: Date.now() + 5000 });

    assert.equal(calls(), 1, "应该发出去一次判重请求");
    assert.equal(out.size, 1, "必须带回来一条裁决——空 Map 说明判重被吞了");
    assert.equal(out.get(0).action, "replace");
    assert.equal(out.get(0).id, "e1", "match=1 指的是这条新条目自己的第一个候选");
  });
});

test("模型判 keep 时不产生裁决，但请求确实发出去了", async () => {
  await withModel({ decisions: [{ new: 1, match: 1, action: "keep" }] }, async ({ cfg, calls }) => {
    const existing = [mk("e1", "容器内 nginx 监听 7788，宿主机映射写成 7789 了，改回去就好。")];
    const news = [mk("n1", "容器里 nginx 监听的是 7788，宿主机映射写成了 7789，要改回来。")];

    const out = await judgeDuplicates({ cfg, news, existing, deadline: Date.now() + 5000 });

    assert.equal(calls(), 1, "keep 也要真的问过模型，不能靠字面自己判");
    assert.equal(out.size, 0, "keep 不写裁决，调用方按「新增」处理");
  });
});

test("没有候选时不发请求：省一次调用，也避免模型对着空表编", async () => {
  await withModel({ decisions: [] }, async ({ cfg, calls }) => {
    const existing = [mk("e1", "DataPilot 用 Polars + Parquet 做主存储。", "DataPilot")];
    const news = [mk("n1", "复盘卡按题号升序连续编号，新建的卡从最大编号接续。", "复盘卡")];
    const out = await judgeDuplicates({ cfg, news, existing });
    assert.equal(calls(), 0);
    assert.equal(out.size, 0);
  });
});

test("调用失败时不拆半重试：拆了只是把同样的失败乘上叶子数", async () => {
  // 拆半的本意是「一次塞太多、模型挑不过来」。端点挂掉（5xx/超时）跟内容多少无关，
  // 拆成 8 份就是打 8 次、错 8 次。2026-11-10 那次判重失效，一个 8 条的块被拆成
  // 8 个叶子、每个都抛同一个 ReferenceError，日志上看像「模型大面积失败」。
  await withModel(500, async ({ cfg, calls }) => {
    const pairs = Array.from({ length: 8 }, (_, k) => {
      const n = k + 1;
      return {
        old: mk(`e${n}`, `部署第 ${n} 条：容器内 nginx 监听 7788，宿主机映射写成了 7789，改回去。`),
        neu: mk(`n${n}`, `部署第 ${n} 条：容器里的 nginx 监听的是 7788，宿主机侧映射写成了 7789，要改回。`),
      };
    });
    await judgeDuplicates({
      cfg,
      news: pairs.map((p) => p.neu),
      existing: pairs.map((p) => p.old),
      chunkSize: 8,
      deadline: Date.now() + 5000,
    });
    assert.equal(calls(), 1, `8 条的块失败一次就该收手，实际打了 ${calls()} 次`);
  });
});
