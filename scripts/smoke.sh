#!/usr/bin/env bash
# 沙箱冒烟：在 deploy/sandbox 里从零走一遍"入队 → 抽取 → 写库 → 检索 → 原文回读"。
#
#   cd deploy/sandbox && docker compose up -d
#   ../../scripts/smoke.sh
#
# 为什么要这么干：单测都是假接口，"真的连一本思源走一遍"能抓到的都是另一类问题——
# 索引没就绪、锁被占、参数被当布尔、文档名写错。这些在单测里永远是绿的。
set -uo pipefail
cd "$(dirname "$0")/../deploy/sandbox" || exit 2

M="docker compose exec -T mem node /app/src/cli/cli.mjs"
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  ✓ $1"; }
bad()  { fail=$((fail+1)); echo "  ✗ $1"; }
check() { # 名字, 期望出现的字符串, 实际输出
  if grep -q -- "$2" <<<"$3"; then ok "$1"; else bad "$1（输出里没有「$2」）"; echo "$3" | head -5 | sed 's/^/      /'; fi
}

echo "== 1. init（幂等）=="
out=$($M init 2>&1); check "init 建出笔记本与文档" "notebook" "$out"

echo "== 2. 入队 =="
mkdir -p data/smoke
cat > data/smoke/smoke-$$.jsonl <<'JSONL'
{"type":"message","sessionId":"smoke-sess","role":"user","timestamp":1794000000000,"content":[{"type":"input_text","text":"冒烟脚本：这条会话要能被解析成轮次、进队列、抽成条目，并挂上原文指针。"}]}
{"type":"message","sessionId":"smoke-sess","role":"assistant","timestamp":1794000060000,"content":[{"type":"output_text","text":"如果哪一步断了，表现都是查不到。所以脚本要逐段验：队列有文件、条目数增加、检索能命中、指针能回读。"}]}
JSONL
out=$($M ingest-log "/data/smoke/smoke-$$.jsonl" --quiet 0 2>&1); check "会话进队列" "新增" "$out"

echo "== 3. 抽一轮 =="
docker compose stop mem >/dev/null 2>&1
out=$(docker compose run --rm --no-deps mem once 2>&1)
docker compose up -d mem >/dev/null 2>&1
check "写入了条目" "写入 [1-9]" "$out"

echo "== 4. 检索与回读 =="
out=$($M search 冒烟脚本 2>&1); check "检索能命中" "找到" "$out"
out=$($M raw list 2>&1);    check "原文归档有 part" "个 part" "$out"
out=$($M status 2>&1);      check "条目数非零" "current [1-9]" "$out"

echo "== 5. 日志 =="
out=$($M log stats 2>&1);   check "事件里有写入" "写入 [1-9]" "$out"

echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ] || exit 1
