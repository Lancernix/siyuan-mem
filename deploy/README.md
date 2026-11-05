# 部署：服务器当唯一中心

思源已经在服务器上跑（Docker），所以这里**只加一个 mem 容器**，它接在思源自己的
网络上，通过 6806 那套 HTTP API 读写。思源本身不用动。

Mac 和公司电脑退成边缘：只负责把会话推上来、把记忆查下去，自己不抽取、不写思源。
这样"谁写库"只有一个答案，同步冲突的问题就不存在了——不是绕开，是消失。

```
Mac (Claude Code / DSH / WorkBuddy)
  ├─ mem push --watch ──┐  POST /api/ingest   会话增量
  └─ mem mcp ───────────┤  POST /api/search   召回
                        ▼
              服务器 mem 容器 ──► 思源容器 (6806)
                 抽取 / 判重 / 写条目
```

## 0. 先看清服务器上的两件事

```bash
# 思源在哪个网络里（compose 默认建 <项目名>_default）
docker network ls | grep -i siyuan

# 容器的名字，配置里 baseUrl 要用它当主机名
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -i siyuan
```

思源的 API token 在「设置 → 关于 → API token」。

## 1. 把代码放上去

```bash
git clone <repo> ~/siyuan-mem && cd ~/siyuan-mem/deploy
```

## 2. 配置

```bash
mkdir -p data/.siyuan-mem
cp config.example.json data/.siyuan-mem/config.json
chmod 600 data/.siyuan-mem/config.json
$EDITOR data/.siyuan-mem/config.json
```

要改的四处：思源地址（`http://<思源容器名>:6806`）、思源 token、模型 key、
`ingest.token`（自己编一个长串，边缘机器要用同一个）。

## 3. 起容器，建库

```bash
SIYUAN_NET=<上一步查到的网络名> docker compose up -d --build

# 能看到思源版本和条目数，说明连通了
docker compose exec mem status

# 建笔记本「90-记忆」和条目/实体那几个文档（幂等，重复跑没关系）
docker compose exec mem init
```

## 4. 确认接收端开着

```bash
docker compose exec mem center status
```

应该看到 `0.0.0.0:7788` 和 token。没开就去配置里把 `ingest.enabled` 设成 true 再
`docker compose restart mem`。

外网访问别直接暴露 7788。两种都行：反代加 HTTPS，或者 Tailscale 打洞（更省事，
边缘机器上也少一个证书要管）。

## 5. 从 Mac 把历史推上来

```bash
# 先验地址和 token，不传数据
mem push --to http://<服务器>:7788 --token <ingest.token> --test

# 全量推。--all 是不限这一轮的会话数，--quiet=0 是连刚写完的也推
mem push --to http://<服务器>:7788 --token <ingest.token> --all --quiet=0 --save
```

推的是原始语料（去掉思考、工具输出之后的那部分），不是抽好的条目。中心那边排队，
一轮一轮抽。第一次大约 100 个会话、7000 轮、两百万 token 上下，跑一小时。

`--save` 会把地址和 token 记住，之后 `mem push --watch` 就只推增量。

## 6. 看它跑

```bash
docker compose exec mem status
docker compose exec mem log stats
docker compose exec mem review 20    # 最近 20 条，人眼扫一遍
```

三个指标值得盯：

- `entry.skip` 里 `covered` 的比例——太高说明判重太激进，新结论被挡住了；
- 每次 `extract.result` 的批数和 prompt token——看 38000 字的预算是不是合适；
- 条目的原文指针跨度——超过 150 轮说明一批切得太粗。

## 7. Mac 收尾

删掉本地那份记忆笔记本（或整个副本），装 MCP：

```bash
claude mcp add siyuan-mem -- mem mcp --to http://<服务器>:7788 --token <ingest.token>
```

再在 CLAUDE.md 里补一句什么时候该查——装上只是"能调"，不等于"会调"。

## 重建这件事，三句话

1. **原料在 Mac 上**（`~/.workbuddy`、`~/.claude`、`~/.dsh` 那些 JSONL），思源里那
   七百多条是产物。产物删了没损失，重跑一遍就有。
2. **但不是还原**。同样的输入重跑，抽出来的条目会不一样——模型不是确定性的，那几十条
   手工 supersede 的判断也不会回来。所以重建前先把 Mac 上的旧文档导一份留底，万一
   想对照。
3. **顺序不能反**：先推完、再删。反过来就是拿唯一一份原料换一个空的库。

## 备份

`./data` 一个目录装了配置、队列、原文索引和日志。备份它就够。

原文附件（`assets/mem-raw/`）在思源的数据目录里，那个归思源自己的备份管。
