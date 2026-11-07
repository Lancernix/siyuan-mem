import { loadConfig } from "./config.mjs";

/**
 * 远端检索：边缘机器够不着思源，只能问中心。
 *
 * 这一层属于边缘，不属于中心——它是"客户端"。放在 src/worker 下，和 push 一起
 * 构成边缘的两条腿：一条把会话推上去，一条把记忆查下来。
 *
 * 地址和 token 跟 push 共用一份。两台机器之间只有「一进一出」两条通道，
 * 给它们各配一套地址和 token，装第二台机器时就多一个能配错的地方，
 * 而且错的时候两边都只报「连不上」，分不清是哪一边。
 *
 * @param {{to?:string, token?:string, q:string, limit?:number, topic?:string,
 *          project?:string, type?:string, days?:number, status?:string}} opts
 */
export async function remoteSearch(opts = {}) {
  const cfg = loadConfig();
  const base = String(opts.to || cfg.push?.to || "")
    .trim()
    .replace(/\/+$/, "")
    // 有人会把 push 的完整地址（…/api/ingest）粘进来，顺手认了。
    .replace(/\/api\/ingest$/, "");
  if (!base) {
    throw new Error("没配中心地址：mem search --to https://中心地址，或先 mem push --to … --save");
  }
  const token = opts.token ?? cfg.push?.token ?? "";
  const body = {
    q: opts.q,
    limit: opts.limit,
    topic: opts.topic,
    project: opts.project,
    type: opts.type,
    days: opts.days,
    // 空串 = 连过时的一起看；undefined 交给服务端按默认（current）处理。
    status: opts.status,
  };

  let res;
  try {
    res = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
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
  if (!res.ok) throw new Error(`中心拒绝了检索（HTTP ${res.status}）：${data?.error ?? text.slice(0, 200)}`);
  return { ...data, remote: base };
}
