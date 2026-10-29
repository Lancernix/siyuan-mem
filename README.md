# siyuan-mem

把 harness 会话变成思源笔记里的记忆条目。

不是又一个记忆框架。它只补思源没有的那一块：**采集、抽取、状态**。
存储、索引、展示、双链、SQL 全是思源自己的，一行没重写。

## 它做什么

```
DSH 插件  ──会话──▶  ~/.siyuan-mem/inbox/  ──mem once──▶  思源（90-记忆）
   ▲                                                          │
   └──────────── agent/pre-step 注入最近结论 ◀─────────────────┘
```

三件事：

- **采集**：插件把用户说的话和模型说的话投进本地队列。thinking、工具调用、自己注入的上下文全部丢掉。
- **抽取**：`mem once` 把一段会话压成几条带实体名的结论，写进思源，挂上状态属性。
- **注入**：开会话时，插件查一次思源，把可能相关的既有结论贴进上下文。查不到就跳过，不阻塞对话。

## 为什么是思源

因为它已经给了你六样东西，自己写全是最烦的部分：块级稳定 id、任意自定义属性、属性视图、双链反链、SQL、全文索引。
它缺的四样——事务、向量、调度、版本——本来也不该由存储层负责。

## 安装

需要 Node 20+，思源 3.8+ 在跑。

```bash
cd ~/Codes/siyuan-mem
cp config.example.json ~/.siyuan-mem/config.json   # 首次运行也会自动生成
node src/cli.mjs init
```

`init` 会建一个 `90-记忆` 笔记本和三个文档。重复执行是安全的。

想让它抽取质量好一点，填 `config.json` 里的 `model.apiKey`。不填也能跑，走规则抽取，只是结论糙。

## 用法

```bash
node src/cli.mjs status              # 连通性、条目数、队列长度
node src/cli.mjs once                # 处理队列（--dry 先看要写什么）
node src/cli.mjs search 风盾500       # 查
node src/cli.mjs search --all 风盾500 # 连已过时的一起查
node src/cli.mjs review 20           # 最近 20 条，人工扫一眼
node src/cli.mjs remember "..." --entity 思源MCP --type fact
node src/cli.mjs forget <块id>        # 标成过时，不删
```

软链到 PATH 之后就是 `mem status`、`mem once`。

## 一个字都不截

采集侧不做任何截断。走到抽取的每一段都是用户真说的话或模型真说的话——那是唯一不可再生的语料，截断是不可逆的有损压缩，写的时候丢掉的东西，读的时候任何模型都救不回来。

长内容靠**拆批**解决，不靠砍：

- 按字符预算（默认 16000 字/次）把会话切成若干批，逐批调用模型，批与批独立；
- 一条问答本身就超预算时，按段落把它切开分别送，所有段拼起来等于原文；
- 各批结果按内容去重后合并，超出单会话上限的条数会打印出来，不静默丢弃；
- 模型调用失败退回规则抽取时，**原文留在队列里不归档**，等模型恢复重跑。

被过滤掉的只有四类，它们都不是对话内容：thinking、工具调用与结果、上下文压缩的摘要块（`cb_summary` 等，会伪装成用户消息）、插件自己注入的记忆。

实测：一个 1013 轮、26 万字符的真实会话 → 360 个问答对、17 批，字符数分毫不差。

| 配置项 | 默认 | 作用 |
|---|---|---|
| `extract.maxCharsPerCall` | 16000 | 一次模型调用的字符预算，超了拆批 |
| `extract.maxEntriesPerBatch` | 6 | 每批最多出几条 |
| `extract.maxEntriesPerSession` | 60 | 一个会话最多入库几条（防噪音，撞到会提示） |
| `extract.minTurnChars` | 25 | 短于这个且两边都短的寒暄直接跳过 |

## 数据结构

一条记忆 = `01-条目` 里的一个段落块 + 八个属性：

| 属性 | 值 |
|---|---|
| `custom-mem-status` | `current` / `superseded` |
| `custom-mem-entity` | 检索用的核心词，如 `风盾500` |
| `custom-mem-type` | `decision` / `fact` / `preference` / `reference` |
| `custom-mem-hash` | 内容哈希，用来去重 |
| `custom-mem-source` | 哪个 harness 产生的 |
| `custom-mem-session` | 会话 id |
| `custom-mem-date` | 写入日期 |
| `custom-mem-confidence` | 1–5 |

状态只有两种。**过时的不删**——"为什么当初不用 Oracle"这个问题的答案，就在那条被取代的条目里。

## 三种接入方式，别再叫它"DSH 插件"

核心（抽取、存储、查询、状态）**跟 harness 无关**，一行没绑定。绑不住的只有"怎么拿到会话"，每家一份薄适配：

| harness | 接法 | 代码量 | 限制 |
|---|---|---|---|
| DSH | cordis 插件 | `plugin/` 约 60 行 | 只能用 DSH 的钩子事件名 |
| Claude Code | hook 脚本（Stop / SessionEnd 里调 `mem ingest-log`） | 几十行 shell + settings 配置 | 要有 `~/.claude/projects` 写入 |
| WorkBuddy | **无插件机制**，只能读日志 | 零代码，`mem ingest-log` 直接跑 | 闭源，拿不到进程内事件 |
| 任意其他 | 能导出 jsonl/markdown 就能进 | 一个 reader | 见 `src/readers.mjs` |

所以准确说法是：**一套核心 + 每家一份采集适配**。不是"一个插件通吃所有 harness"，那做不到。

日志这条路还有个附带好处：插件截获会漏、会崩、会重复，日志是 append-only 的，harness 自己不会写丢。插件挂了，日志还在。

```bash
mem ingest-log ~/.workbuddy/projects/<ws>/<session>.jsonl
mem ingest-log ~/.claude/projects/<proj>/<session>.jsonl --format claude
```

格式按内容嗅探，认不出才要 `--format`。用户消息里的 `<system-reminder>`、子代理事件、工具结果会在读取时剔掉。

## DSH 插件

`plugin/` 是一个 cordis 插件，装到 profile 里：

```bash
cd ~/Codes/siyuan-mem/plugin
npm link                     # 或 pnpm link --global
dsh plugin --profile desktop add dsh-siyuan-memory
dsh --profile desktop --dump-config   # 确认它出现在配置树里
```

它只做两件事：`session/event` 攒文本、`session/flush` 写队列；`agent/pre-step` 注入一次。
没有界面、没有右键菜单、没有侧边栏——远程和 headless 的会话一视同仁。

**思源没开也安全**：注入超时 800ms 就放弃，采集只写本地文件。

## 定时

队列不处理就一直是队列。macOS 用 launchd（`~/Library/LaunchAgents/com.siyuan.mem.plist`）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.siyuan.mem</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/<你>/Codes/siyuan-mem/src/cli.mjs</string>
    <string>once</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
```

`launchctl load ~/Library/LaunchAgents/com.siyuan.mem.plist`

常驻版本 `mem serve` 还没写——`once` 加定时足够，而且崩了能手动补跑。

## 已经踩过的坑

这些都是实测撞出来的，改代码时注意别踩回去。

**思源的块 id 不能用 `path` 查。** `path` 是 `/20261029095926-367glk8.sy` 这种内部路径，中文名只在 `hpath` 里。用 `path` 查永远空，于是每次 init 都新建一份同名文档——十几分钟能堆出六十个。

**SQL 索引是异步的。** 刚写完的块立刻查不到，几秒后才出现。所以：去重靠内容哈希 + 进程内 Set；`init` 解析出的 id 缓存在 `~/.siyuan-mem/state.json`，不每次回查。

**`appendBlock` 返回的不是 id**，是 `[{doOperations:[{action:"insert",id:"..."}]}]`。当字符串用会静默变 undefined，错在后面的 `setBlockAttrs` 才报。

**建块和设属性不是一次事务。** 属性没写成，块就成了孤儿：查不到、审不到、去重也挡不住。写入失败要补偿删除（`store.mjs` 里做了）。

**`createNotebook` 返回 `data.notebook.id`**，直接把 `data` 当 id 传下去会报类型错。

**聚合列别叫 `current` / `total`**，`current` 是 SQL 关键字，查得出来但取不到字段。

**删除文档要用 `filetree/removeDocByID`**，`block/deleteBlock` 对它无效，而且删除后 SQL 里还要几秒才消失。

## 目录

```
src/
  cli.mjs       命令入口
  config.mjs    配置与本地状态
  siyuan.mjs    HTTP 客户端（只走 HTTP，不走 CLI）
  extract.mjs   会话过滤 + 抽取
  store.mjs     写入、去重、查询、状态
  inbox.mjs     队列（就是目录）
plugin/
  index.mjs     DSH 插件
docs/           设计过程与调研（含思源能力盘点）
```

## 还没做

- `mem serve` 常驻与 fs.watch 即时触发
- 向量与 rerank（思源内核已内置，未开索引；4 万个块全量建索引要先决定云端还是本地模型）
- 注入的关键词匹配现在只取首句前 16 字做 LIKE，召回很粗
- 画像层（人格与用户偏好的统一管理）没做，设计在 `docs/记忆系统-分层与召回设计.md`
