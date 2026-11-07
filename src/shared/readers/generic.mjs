/**
 * 兜底：不认识的 harness。
 *
 * 只靠形状——候选节点挨个试、role 别名归一、content 取文本块。不加载任何特有规则，
 * 所以宁少勿错：宁可漏掉一家的注入块，也不把它的规则错加到别人身上。
 *
 * 认到新格式之后，照 workbuddy.mjs 的样子写一份，把它加进 index.mjs 的 REGISTRY。
 */
import { walkMessages } from "./base.mjs";

export const name = "generic";

export function sniff() {
  return false;
}

export function read(lines) {
  return walkMessages(lines, {});
}
