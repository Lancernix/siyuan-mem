#!/usr/bin/env bash
# 沙箱冒烟：在 deploy/sandbox 里从零走一遍"入队 → 抽取 → 写库 → 检索 → 原文回读"。
#
#   bash deploy/sandbox/bootstrap.sh     # 先起环境（会自己生成配置）
#   bash scripts/smoke.sh
#
# 为什么要这么干：单测都是假接口，"真的连一本思源走一遍"抓到的是另一类问题——
# 索引没就绪、锁被占、参数被当布尔、文档名写错。这些在单测里永远是绿的。
#
# 断言纪律（上一版在这里翻过车）：
#   1. 先看退出码，再看输出；
#   2. 输出匹配要带数字锚点（`找到 [1-9]`），不能匹配 "找到"——"没找到" 里也有这两个字；
#   3. 原文回读必须真的调 readRange（`mem show`），不能拿 raw-index 当证据。
set -uo pipefail
cd "$(dirname "$0")/../deploy/sandbox" || exit 2

M="docker compose exec -T mem node /app/src/cli/cli.mjs"
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ✓ $1"; }
bad() { fail=$((fail+1)); echo "  ✗ $1"; }

# run <期望出现的正则> <说明> <命令...>
run() {
  local want="$1" what="$2"; shift 2
  local out rc
  out=$("$@" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then bad "$what（退出码 $rc）"; echo "$out" | head -6 | sed 's/^/      /'; return; fi
  if grep -Eq -- "$want" <<<"$out"; then ok "$what"; else
    bad "$what（输出里没有 /$want/）"; echo "$out" | head -6 | sed 's/^/      /'
  fi
  LAST_OUT="$out"
}

echo "== 1. init（幂等）=="
run '笔记本与文档就绪' 'init 建出笔记本与文档' $M init

echo "== 2. 入队 =="
# 每次跑用不同的会话 id 和标记：不然第二次跑会被判成"同一场已处理过"，
# 直接跳过——脚本就变成"只有第一次能过"。
RUN="$(date +%s)$$"
MARK="冒烟标记${RUN}"
mkdir -p data/smoke
FIX="data/smoke/smoke-$RUN.jsonl"
cat > "$FIX" <<JSONL
{"type":"message","sessionId":"smoke-$RUN","role":"user","timestamp":1794000000000,"content":[{"type":"input_text","text":"冒烟脚本要验五段：入队、抽取、写库、检索、原文回读，任何一段断了对外都只表现为查不到。标记 $MARK。"}]}
{"type":"message","sessionId":"smoke-$RUN","role":"assistant","timestamp":1794000060000,"content":[{"type":"output_text","text":"$MARK 这条结论只在沙箱里存在，用来验证检索与原文回读。"}]}
JSONL
run '新增 [0-9]+ 轮' '会话进队列' $M ingest-log "/data/smoke/smoke-$RUN.jsonl" --quiet 0

echo "== 3. 抽一轮 =="
# 沙箱里不跑 serve（不需要模型 key），队列是独占的，直接跑一轮。
# --no-model 走规则抽取：沙箱默认没有 key，这条路径本来就该能独立跑通。
run '写入 [1-9][0-9]*，跳过 [0-9]+，失败 0' '抽取并写入条目' $M once --no-model

echo "== 4. 检索 =="
# 思源的块索引是异步的：刚写完立刻查是查不到的（这是它的行为，不是我们的 bug）。
# 真机上表现为"刚跑完 once 就 search，一条都没有"，等两三秒再查就有了。
sleep 4
run '找到 [1-9][0-9]* 条' '检索能命中' $M search "$MARK"

echo "== 5. 原文回读（真调 readRange）=="
# 人类可读输出里没有 id（故意不给，日志里那串对人没用），走 --json 取。
# 注意 JSON 是缩进过的：`"id": "xxx"`，冒号和引号之间有空格。
JSON=$($M search "$MARK" --json 2>/dev/null)
ID=$(grep -o '"id": *"[^"]*"' <<<"$JSON" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
if [ -n "${ID:-}" ]; then
  run "$MARK" '按指针回读出原文' $M show "$ID" --chars 300
else
  bad '拿不到条目 id，无法验证回读'
fi

echo "== 6. 日志 =="
run '写入 [1-9][0-9]*' '事件日志记到了写入' $M log stats

echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ] || exit 1
