import { loadConfig } from "./config.mjs";
import { normalizeSource } from "./source.mjs";

/**
 * 远端只读通道：边缘机器够不着思源，只能问中心。
 *
 * 这一层属于边缘，不属于中心——它是"客户端"。和 push 一起构成边缘的两条腿：
 * 一条把会话推上去，一条把记忆查下来。地址和 token 跟 push 共用一份。两台机器
 * 之间只有「一进一出」两条通道，给它们各配一套地址和 token，装第二台机器时
 * 就多一个能配错的地方，而且错的时候两边都只报「连不上」，分不清是哪一边。
 *
 * 三个接口（search / topics / entries）走同一份地址、token 和错误语义：
 * 后端故障必须抛错，不能变成空结果——「中心坏了」和「真的没记过」要分得开。
 */

/** 把 push 的完整地址、末尾斜杠都归一成中心根地址。 */
function baseOf(opts, cfg) {
  const base = String(opts.to || cfg.push?.to || "")
    .trim()
    .replace(/\/+$/, "")
    // 有人会把 push 的完整地址（…/api/ingest）粘进来，顺手认了。
    .replace(/\/api\/ingest$/, "");
  if (!base) {
    throw new Error("没配中心地址：mem search --to https://中心地址，或先 mem push --to … --save");
  }
  return base;
}

async function remoteGet(path, opts, body, { timeout = 15000, action = "检索" } = {}) {
  const cfg = loadConfig();
  const base = baseOf(opts, cfg);
  const token = opts.token ?? cfg.push?.token ?? "";

  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(`连不上中心 ${base}：${e.name === "TimeoutError" ? "超时" : e.message}`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`中心返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`中心拒绝了${action}（HTTP ${res.status}）：${data?.error ?? text.slice(0, 200)}`);
  return { ...data, remote: base };
}

/**
 * @param {{to?:string, token?:string, q:string, limit?:number, topic?:string,
 *          project?:string, type?:string, days?:number, status?:string}} opts
 */
export async function remoteSearch(opts = {}) {
  return remoteGet("/api/search", opts, {
    q: opts.q,
    limit: opts.limit,
    topic: opts.topic,
    project: opts.project,
    type: opts.type,
    days: opts.days,
    // 空串 = 连过时的一起看；undefined 交给服务端按默认（current）处理。
    status: opts.status,
    // 边缘 agent 的调用不能被中心记成 api：同一串调用里 topics/entries 是
    // mcp、search 是 api 的话，「mcp 那一栏是不是 0」就没法用了（P2-2）。
    source: normalizeSource(opts.source),
  });
}

/** 列话题目录：q 是过滤提示，limit 有服务端硬上限。 */
export function remoteTopics(opts = {}) {
  return remoteGet("/api/topics", opts, { q: opts.q, limit: opts.limit, status: opts.status, source: normalizeSource(opts.source) });
}

/** 按话题翻条目：topic 必填，不走关键词门槛。 */
export function remoteEntries(opts = {}) {
  return remoteGet("/api/entries", opts, {
    topic: opts.topic,
    limit: opts.limit,
    days: opts.days,
    status: opts.status,
    source: normalizeSource(opts.source),
  });
}

/**
 * 归档：边缘唯一一条写通道。
 *
 * 超时给到 60 秒，比检索宽得多——归档是逐条串行写属性（并发会把思源内核顶爆），
 * 几十条的批量本来就要十几秒，用检索那 15 秒会把一件已经成功一半的事报成失败。
 */
export function remoteArchive(opts = {}) {
  return remoteGet(
    "/api/archive",
    opts,
    {
      ids: opts.ids,
      topic: opts.topic,
      session: opts.session,
      reason: opts.reason,
      confirm: opts.confirm,
      undo: opts.undo,
      list: opts.list,
      limit: opts.limit,
      source: normalizeSource(opts.source),
    },
    { timeout: 60000, action: "归档" }
  );
}
