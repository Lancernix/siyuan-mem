#!/usr/bin/env node
/**
 * mem-mcp：MCP 的独立入口。
 *
 *   npx -y siyuan-mem mem-mcp --to https://中心地址 --token …
 *
 * 和 `mem mcp` 的区别只有一处：这个入口**只走中心**，不直连思源。挂在 harness
 * 上的那台机器通常没有思源、也没有这个仓库的配置，让它去试本地只会超时，而超时
 * 的表现是"每次都查不到"，看起来像记忆库是空的。
 *
 * 地址和 token 不填就读配置里的 push.to / push.token——`mem push --save` 已经
 * 写过一次，没必要在 MCP 配置里再抄一遍。
 */
import { loadConfig } from "../util/config.mjs";
import { remoteSearch } from "../util/remote.mjs";
import { startMcp } from "./server.mjs";
import { parseArgs } from "../util/args.mjs";

const { flags } = parseArgs(process.argv.slice(2));
const cfg = loadConfig();
const to = String(flags.to ?? cfg.push?.to ?? "").replace(/\/+$/, "");
const token = flags.token ?? cfg.push?.token ?? "";

if (!to) {
  process.stderr.write(
    "mem-mcp 需要中心地址：--to https://… ，或先跑 mem push --to … --token … --save\n"
  );
  process.exit(2);
}

startMcp({
  search: (opts) => remoteSearch({ ...opts, to, token }),
  // stdout 只给协议，日志一律 stderr。
  log: (m) => process.stderr.write(`${m}\n`),
});
