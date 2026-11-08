#!/usr/bin/env bash
# 把沙箱从零拉起来：起思源 → 读出它的 api token → 生成 mem 的配置 → 起 mem。
#
# 为什么要这一步：思源的 api token 是它第一次启动时随机生成的，写在它自己的
# conf.json 里。mem 的配置里必须填同一个值，否则连不上。手工做一次能行，但
# "干净 clone 之后照 README 跑"就会卡在这里——所以固化成脚本。
set -euo pipefail
cd "$(dirname "$0")"

echo "== 起沙箱思源 =="
docker compose up -d --build siyuan

echo "== 等它就绪 =="
for i in $(seq 1 40); do
  if docker compose exec -T siyuan sh -c 'wget -q -O- --timeout=2 http://127.0.0.1:6806/api/system/version >/dev/null 2>&1'; then
    echo "  思源起来了（第 $i 次探测）"
    break
  fi
  sleep 2
  [ "$i" = 40 ] && { echo "  思源 80 秒还没就绪，看 docker compose logs siyuan"; exit 1; }
done

echo "== 取沙箱思源的 api token =="
TOKEN=$(docker compose exec -T siyuan sh -c "grep -o '\"token\"[^,]*' /siyuan/workspace/conf/conf.json | head -1 | sed 's/.*\"\\(.*\\)\"/\\1/'")
if [ -z "$TOKEN" ]; then echo "  取不到 token，检查 /siyuan/workspace/conf/conf.json"; exit 1; fi
echo "  token 长度 ${#TOKEN}"

echo "== 生成 mem 配置 =="
mkdir -p data/.siyuan-mem
if [ -f data/.siyuan-mem/config.json ]; then
  echo "  已存在，保留（要重来就删掉它）"
else
  sed "s|由 bootstrap.sh 从沙箱思源里读出来填进来|$TOKEN|" config.example.json > data/.siyuan-mem/config.json
  chmod 600 data/.siyuan-mem/config.json
  echo "  写好了 data/.siyuan-mem/config.json"
fi

echo "== 起沙箱 mem =="
docker compose up -d mem
sleep 3
docker compose ps
echo
echo "接下来：bash scripts/smoke.sh（在仓库根目录）"
