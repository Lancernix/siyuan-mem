/**
 * 提示词：内置一份，人可以覆盖。
 *
 * 为什么要能改：抽取质量有一半在提示词里，不同人对自己记忆的期待不一样——
 * 有人要短句，有人要把理由写全；有人项目多、希望话题名带项目前缀。
 * 内置那份只是"我们觉得合适"，不是"唯一正确"。
 *
 * 为什么要能回滚、要算版本：提示词是这套系统里最灵敏的旋钮，也是最容易
 * 无声调坏的。改完抽出来的东西变了，但日志上如果看不出"提示词变过"，两周后
 * 只会看到"条目从 22 条变 36 条"，分不清是模型抽风还是自己改的。
 *
 * 边界：**只覆盖"抽什么、怎么说"那部分，不覆盖输出契约。** 字段名和结构由
 * schema 在服务端强制（见 extract.mjs 的 ENTRIES_SCHEMA），提示词里改成什么都
 * 影响不了它。这也是为什么放开编辑是安全的——格式不由它保证。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./config.mjs";

export const PROMPT_DIR = join(HOME_DIR, "prompts");
/** 覆盖文件。存在就用它，不存在用内置的。 */
export const PROMPT_PATH = join(PROMPT_DIR, "entries.md");

export function userPrompt() {
  try {
    return readFileSync(PROMPT_PATH, "utf8");
  } catch {
    return "";
  }
}

/**
 * 体检。不是拒绝的理由，是"你可能改坏了"的提醒——提示词坏掉的表现从来不是报错，
 * 是抽出来的东西悄悄变差。
 */
export function checkPrompt(text) {
  const s = String(text ?? "");
  const out = [];
  if (!/json/i.test(s)) {
    // 火山（以及不少 OpenAI 兼容端点）在 json_object 模式下要求 prompt 里出现
    // "json" 字样，否则直接 400。这条最硬，因为它会让整批失败。
    out.push("没出现 json 字样：火山等端点在 json_object 模式下会直接 400");
  }
  if (s.length < 400) out.push(`只有 ${s.length} 字，可能是误删（内置那份两千多字）`);
  for (const k of ["entries", "brief", "text", "entity"]) {
    if (!s.includes(k)) out.push(`没提到字段 ${k}，模型更容易漏这个字段`);
  }
  return out;
}

/**
 * 生效的那份。内置和覆盖同形，调用方不用 Branch。
 *
 * @param {string} builtin 内置提示词
 * @param {string} extra   动态规则（比如批间草稿那段），也算进版本号
 */
export function resolvePrompt(builtin = "", extra = "") {
  const user = userPrompt().trim();
  const body = user || String(builtin ?? "");
  return {
    text: body,
    source: user ? "user" : "builtin",
    version: createHash("sha1").update(`${body}\n\n${extra}`).digest("hex").slice(0, 8),
    warnings: checkPrompt(body),
  };
}

/** 保存覆盖前先备份旧版：调提示词是试错，试错就必须能退。 */
export function savePrompt(text) {
  if (!String(text ?? "").trim()) throw new Error("不能存空的提示词：想恢复内置请用 mem prompt reset");
  mkdirSync(PROMPT_DIR, { recursive: true });
  let backup = "";
  if (existsSync(PROMPT_PATH)) {
    backup = join(PROMPT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
    copyFileSync(PROMPT_PATH, backup);
  }
  writeFileSync(PROMPT_PATH, `${String(text).trim()}\n`);
  return { path: PROMPT_PATH, backup };
}

export function resetPrompt() {
  if (!existsSync(PROMPT_PATH)) return { removed: false };
  const backup = join(PROMPT_DIR, `reset-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
  copyFileSync(PROMPT_PATH, backup);
  rmSync(PROMPT_PATH);
  return { removed: true, backup };
}

/** 历史版本，新的在前。 */
export function history() {
  try {
    return readdirSync(PROMPT_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
