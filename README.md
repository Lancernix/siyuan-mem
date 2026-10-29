# siyuan-mem

把 harness 会话变成思源笔记里的记忆条目。

不是又一个记忆框架。它只补思源没有的那一块：**采集、抽取、状态**。
存储、索引、展示、双链、SQL 全是思源自己的，一行没重写。

## 它做什么

```
各 harness 会话日志 ┐
                    ├─▶ ~/.siyuan-mem/inbox/ ──mem serve──▶ 思源（90-记忆）
DSH 插件（实时）     ┘                                         │
   ▲                                                           │
   └───────── agent/pre-step 注入最近结论 ◀──────────────────────┘
```

三件事：

- **采集**：插件把用户说的话和模型说的话投进本地队列，`mem serve` 每十分钟扫一遍其余四家的日志补上。thinking、工具调用、自己注入的上下文全部丢掉。
- **抽取**：把一段会话压成几条带实体名的结论，写进思源，挂上状态属性。
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

`ingest-log` 记住每个日志读到第几行（`~/.siyuan-mem/offsets.json`），重复跑只投新增部分；文件被重写或轮转（变小）就从零开始。

想让它抽取质量好一点，填 `config.json` 里的 `model.apiKey`。不填也能跑，走规则抽取，只是结论糙。

## 用法

```bash
node src/cli.mjs status              # 连通性、条目数、队列长度、服务在不在
node src/cli.mjs once                # 处理队列（--dry 先看要写什么）
node src/cli.mjs serve               # 常驻：每轮找新会话 → 投队列 → 写思源
node src/cli.mjs serve --once        # 只跑一轮（给 launchd 定时用）
node src/cli.mjs search 风盾500       # 查
node src/cli.mjs search --all 风盾500 # 连已过时的一起查
node src/cli.mjs scan                # 本机有哪些 harness 的会话，各多少
node src/cli.mjs scan --all          # 全读一遍，数轮数和字数
node src/cli.mjs audit               # 对账：收了多少字、丢了多少字、为什么丢
node src/cli.mjs audit --all         # 全部会话的对账表
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

## 模型接口

三种协议，一个接口。调用方只给 `messages`，拿 `{text, usage}`，不知道对面是谁：

| 协议 | 端点 | 用于 | system 放哪 | JSON 模式 | 默认 temperature |
|---|---|---|---|---|---|
| `openai` | `/chat/completions` | DeepSeek、通义、Kimi、智谱、OpenRouter、ollama、LM Studio | messages 里 | `response_format` | 0.2 |
| `anthropic` | `/v1/messages` | Claude | 顶层字段 | 无（靠提示词） | 0.2 |
| `gemini` | `/models/{m}:generateContent` | Gemini | `systemInstruction` | `responseMimeType` | **1.0** |

Gemini 那 1.0 是官方的建议：Gemini 3 调低温度反而会退化、循环。三家各按各的规矩来，不强行统一。

分工是三层，别混：`src/wire/*.mjs` 只负责"这种协议怎么拼请求、怎么读回复"；`src/llm.mjs` 管策略（重试、JSON 回退、记账、预设）；调用方只关心文本和 token。

为什么 OpenAI 那家走官方 SDK、另两家手写：SDK 只对同一种形状有收益，而且它零传递依赖、纯 JS，编进单文件只多 1MB。Anthropic / Gemini 的差异太大（system 顶层、模型名在路径里、角色叫 `model`、token 字段名不同），各自五六十行写完更好审，也不用为两家每年会 breaking 的 SDK 付维护费。三者都懒加载。

预设十家：`deepseek / qwen / moonshot / zhipu / openai / openrouter / anthropic / gemini / ollama / lmstudio`（本地两家不要 key）。自定义端点用 `model.wire` 指定协议。

```bash
mem model                                            # provider、协议、地址、模型、key（打码）、今日用量
mem model use anthropic --key sk-ant-... --name claude-sonnet-4-6
mem model use gemini --key AIza... --name gemini-3.5-flash
mem model use deepseek --key sk-... --wire openai    # 自定义端点也可以显式指定协议
mem model test                                       # 真发一次请求，自证 key、地址、JSON 模式、记账都通
```

三件 SDK 替不掉、必须自己做的事：

- **JSON 模式回退**：服务端不认 `response_format`（或 `responseMimeType`）会回 400。这时去掉该字段重发一次，并标记 `fallback`——不让整段会话因此降级成规则抽取。prompt 相应要求顶层是对象 `{"entries":[…]}`。
- **按调用打 tag 的用量账本**：`~/.siyuan-mem/usage.jsonl` 记 model / wire / tag / tokens / 耗时，`mem status` 显示今日汇总，`serve` 每轮日志带 tokens。回灌一百多个会话时，这是唯一能判断"还要不要继续跑"的指标。
- **统一的重试策略**：429/408/409/5xx 退避重试（认 `retry-after`），4xx 其余立刻抛。放在策略层而不是各家 adapter 里，这样"试了几次"在三种协议之间才可比。

`npm test` 用本地假接口测九条：429 重试（真的等了 `Retry-After`）、`response_format` 被拒后回退、401 不重试、5xx 重试到上限、Anthropic 的请求形状与解析、Gemini 的路径与角色映射、预设映射、抽取整链、记账可读。不发真请求、不花钱，跑完不碰真实 `usage.jsonl`。

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

## 五家 harness，一份读取器

核心（抽取、存储、查询、状态）**跟 harness 无关**，一行没绑定。绑不住的只有"怎么拿到会话"。

| harness | 会话日志 | 接法 | 限制 |
|---|---|---|---|
| WorkBuddy | `~/.workbuddy/projects/*/*.jsonl` | 读日志（无插件机制） | 闭源，拿不到进程内事件 |
| Qoder | `~/.qoder/projects/*/*.jsonl` | 读日志 | 格式照抄 Claude Code |
| OMP | `~/.omp/agent/sessions/*/*.jsonl` | 读日志 | 子代理转录在会话目录下一层，要跳过 |
| DSH | `~/.dsh/sessions/*/*/session.v4.jsonl.zstd` | cordis 插件，或读日志兜底 | 多帧 zstd |
| Claude Code | `~/.claude/projects/*/*.jsonl` | hook 脚本，或读日志 | 子代理标 `isSidechain` |

采集层分两条路：能装插件的（DSH、Claude Code）走进程内钩子，其余读日志。

读取分两层：**共用引擎 + 每家一份声明**。

`readers/base.mjs` 是引擎——解压、找消息节点、role 归一、注入块、子代理回报、逐块对账。`readers/<harness>.mjs` 只声明差异，每个十几到几十行：WorkBuddy 的 `<function_call>` 前缀、Qoder 的 `origin.kind`、OMP 的 `attribution`、DSH 的 `plugin:` 和 `delegationDepth`、Claude 的 `isSidechain`。`readers/index.mjs` 是注册表。

为什么不全塞进一个通用函数：试过，四家在 105 个会话上逐字节一致，但那是"读文本"一致；各家特有的**过滤规则**混进共用代码之后，改一家的规则会波及另外三家。现在升级或排障只看一个文件。新增一家是写一份声明，不是抄一遍解析循环——`readers/generic.mjs` 就是零声明的样子。

格式细节、各家的坑和实测数字在 [`docs/harness-会话格式横向对比.md`](docs/harness-会话格式横向对比.md)。

日志这条路还有个附带好处：插件截获会漏、会崩、会重复，日志是 append-only 的，harness 自己不会写丢。插件挂了，日志还在。

```bash
mem ingest-log ~/.workbuddy/projects/<ws>/<session>.jsonl
mem ingest-log ~/.omp/agent/sessions/<slug>/<file>.jsonl
mem ingest-log ~/.dsh/sessions/<ws>/<sid>/session.v4.jsonl.zstd
```

格式按内容嗅探（只影响来源标签，不影响解析）。用户消息里的 `<system-reminder>`、`<cb_summary>` 摘要块、子代理事件、工具结果会在读取时剔掉。

剔掉的不等于丢掉了——`mem audit` 会把每个块归到"收进语料 / 思考块 / 工具结果 / 注入与摘要 / 其它"，五类相加等于日志里全部消息文字。本机 105 个会话的对账结果是 2585 万字里 355 万进语料，**"其它"为 0**，即没有一个字下落不明。

**子代理的处理要分两半**：它自己的转录整份不读（OMP 放在会话目录下一层，Claude 标 `isSidechain`，DSH 标 `delegationDepth`）；但它的**结论**会回到主线——OMP 是 `job` 工具结果里的 `<task-result>`，Claude Code 是 `Task` 工具的 `tool_result`——这一份必须收，否则丢的是结论。本机这样捞回 64 段、12.3 万字。"Spawned agent…"这类派发回执会被过滤掉。

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

## 常驻：锁、节奏、退避

`mem serve` 就是"每十分钟自己跑一轮"，但只写个定时循环会踩三个坑，所以它多做三件事。

**锁。** 思源没有行级合并，两个进程同时写同一份文档，后写的整块覆盖先写的。锁用 `O_EXCL` 建 `~/.siyuan-mem/serve.lock`，靠内核保证只有一个进程能建成，不靠"先查再写"那种有竞态的判断。持锁进程被 `kill -9` 或断电时锁会留在磁盘上，所以启动时先看 `process.kill(pid, 0)`：进程不在了就接管并打印一行，还在就报错退出（确认是僵尸再加 `--force`）。锁里记 host，换台机器或重启之后 pid 不可信。`mem once` 也走同一把锁，服务在跑时手动跑会被拒。

**节奏。** 正在写的会话不能切：每十分钟切一刀，切出来全是半句话。所以只投"安静了 180 秒"的会话（`serve.quietSeconds`）。另外只读**体积变过**的文件——本机 105 个会话共 500MB，每轮全解析一遍纯属浪费，而 `stat` 是微秒级的，体积没变不可能出新内容。每轮最多投 8 个（`serve.maxSessionsPerRound`），第一次启动不会把 105 个会话一次塞给模型，剩下的每轮接着投。

**退避。** 思源没开、模型 429 的时候不要连着重试。失败后第一次等 1 分钟，之后翻倍，最多 30 分钟；成功一次就归零。一轮的顺序也是固定的：**先探思源活着没有，再看有没有新会话，最后才调模型**——反过来，思源一天没开，模型的钱就白花一天，因为抽出来的东西写不进去，下轮还得重抽。

日志在 `~/.siyuan-mem/serve.log`，超过 2MB 轮转成 `.1`，每轮一行：

```
2026-10-29 15:06:37  启动 pid 14444，每 10 分钟一轮
2026-10-29 15:06:40  投递 qoder  312 轮  ~/.qoder/projects/.../c276c7b5.jsonl
2026-10-29 15:06:40  第 1 轮 4.0s：思源 v3.8.6，扫描 105 个会话，新投 2 个（697 轮），写入 33 条，跳过 0，失败 0
```

`Ctrl-C` 会跑完当前这一轮再退，退的时候还锁；再按一次直接退出。`kill -9` 也不会把队列搞乱——归档是 `rename`，要么发生要么没发生。

### launchd

两个选择：常驻加 `KeepAlive`，或定时调 `serve --once`。前者不用反复冷启动 node，后者崩了不会无限重启刷日志。

**plist 里的 node 必须写绝对路径**，因为 launchd 的 `PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，`node` 不在里面。别信 `which node`：它只反映当前 shell 的 PATH 顺序，这台机器上排第一的是 WorkBuddy 自带的那份（`~/.workbuddy/binaries/node/versions/<版本>/bin/node`），写进 plist 就是给别的软件的升级绑定。

用 mise 的话，`~/.local/share/mise/shims/node` 是稳定路径（指向 mise，按全局配置解析版本，现在解析到 v24.22.1），我用 launchd 那种最小环境（`env -i HOME=… PATH=/usr/bin:/bin:/usr/sbin:/sbin`）验过能跑。升级 node 不用改 plist。或者干脆用编译出来的单文件二进制（见下），连运行时都不用。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.siyuan.mem</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/<你>/.local/share/mise/shims/node</string>
    <string>/Users/<你>/Codes/siyuan-mem/src/cli.mjs</string>
    <string>serve</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>/tmp/siyuan-mem.err</string>
</dict>
</plist>
```

定时版把 `serve` 换成 `serve --once`，`KeepAlive` 换成 `<key>StartInterval</key><integer>600</integer>`。

`launchctl load ~/Library/LaunchAgents/com.siyuan.mem.plist`

写 `StandardErrorPath` 是为了接住启动阶段的崩溃（比如 Node 路径不对、锁被占）：这些发生在 `serve` 自己的日志之前。

没有配 `model.apiKey` 时 `serve` 会直接拒绝启动，`--no-model` 是显式的规则抽取开关。理由见下一节。

### 单文件二进制（可选）

```bash
npm run dist      # 打包 → 对账 → 装到 ~/.siyuan-mem/mem
```

`dist` 不只编译，还要**自证**：产物跑一遍 `audit --all`，跟 node 的结果逐字比对，对不上就不落盘。理由是 bun 的 `node:zlib`、`node:fs` 是重实现，我们被「`zstdDecompressSync` 只解第一帧、1MB 解出 243 字节还不报错」坑过一次——静默吞掉半段语料比直接崩更难查。

实测（bun 1.4.4）：106 个会话、368 万字，node 与产物的 `audit --all` 逐字一致，逐会话 sha256 也一致（含 DSH 的多帧 zstd）。产物 85MB（bun 1.4.4 本体 85MB，1.4.3 时是 67MB），启动 30ms，在 launchd 那种最小环境（`env -i`、cwd=`/`）下也能读全。

代价是运行时被焊死在产物里：升级 bun 之后必须重新 `npm run dist`。没有 bun 就用上面的 mise shim，够用。

## 已经踩过的坑

这些都是实测撞出来的，改代码时注意别踩回去。

**思源的块 id 不能用 `path` 查。** `path` 是 `/20261029095926-367glk8.sy` 这种内部路径，中文名只在 `hpath` 里。用 `path` 查永远空，于是每次 init 都新建一份同名文档——十几分钟能堆出六十个。

**SQL 索引是异步的。** 刚写完的块立刻查不到，几秒后才出现。所以：去重靠内容哈希 + 进程内 Set；`init` 解析出的 id 缓存在 `~/.siyuan-mem/state.json`，不每次回查。

**`appendBlock` 返回的不是 id**，是 `[{doOperations:[{action:"insert",id:"..."}]}]`。当字符串用会静默变 undefined，错在后面的 `setBlockAttrs` 才报。

**建块和设属性不是一次事务。** 属性没写成，块就成了孤儿：查不到、审不到、去重也挡不住。写入失败要补偿删除（`store.mjs` 里做了）。

**`createNotebook` 返回 `data.notebook.id`**，直接把 `data` 当 id 传下去会报类型错。

**聚合列别叫 `current` / `total`**，`current` 是 SQL 关键字，查得出来但取不到字段。

**删除文档要用 `filetree/removeDocByID`**，`block/deleteBlock` 对它无效，而且删除后 SQL 里还要几秒才消失。

**状态缓存的键要带笔记本名。** 缓存原来只按 `baseUrl` 存，`state["http://127.0.0.1:6806"].entries` 就是一个块 id。把 config 里的 `notebook` 改成测试笔记本之后，`init` 命中缓存，33 条测试数据直接写进了正式笔记本——缓存只证明了"文档还在"，没证明"文档在这本笔记本里"。现在键是 `baseUrl#笔记本名`，并且缓存命中时要按 `blocks.box` 验一次归属。

**归档的失败计数要按会话算。** 原来一个全局 `failed` 计数器决定归档：第三个会话写失败，第四、五个明明写成功了也不归档，原文卡在队列里下轮重抽一遍。现在每个会话单独计。

**没有 key 的时候不要让它跑。** `extract` 在没有 `apiKey` 时会静默退回规则抽取，而规则抽取只取首段，写进库里的是「[interrupted] 让我为您重新推荐一些…」这种半句话。实测一次误启动就往正式库里灌了 37 条这种垃圾。现在 `serve` / `once` 默认拒绝（`--dry` 放行，因为不写库），`--no-model` 才是显式的规则抽取开关。

## 目录

```
src/
  cli.mjs       命令入口
  config.mjs    配置与本地状态
  siyuan.mjs    HTTP 客户端（只走 HTTP，不走 CLI）
  extract.mjs   会话过滤 + 抽取
  readers/
    base.mjs      共用引擎：解压、找消息、role 归一、子代理回报、对账
    workbuddy.mjs 各家只声明差异（十几个到几十行）
    claude.mjs
    qoder.mjs
    omp.mjs
    dsh.mjs
    generic.mjs   兜底：不认识的格式按形状读
    index.mjs     注册表与分发
  harness.mjs   在磁盘上找各家的会话目录
  jobs.mjs      两件可复用的活：投递增量、把队列写进思源
  serve.mjs     常驻：锁、节奏、退避、轮次日志
  store.mjs     写入、去重、查询、状态
  inbox.mjs     队列（就是目录）
  llm.mjs       模型调用层：重试、JSON 模式、用量记账、provider 预设
  wire/         三种协议各一份：openai（SDK）/ anthropic（fetch）/ gemini（fetch）
plugin/
  index.mjs     DSH 插件
test/           模型调用层的回归测试（本地假接口，不花钱）
scripts/        dist：打包 + 对账
docs/           设计过程与调研（含思源能力盘点）
```

## 还没做

- fs.watch 即时触发（现在最慢要等 10 分钟一轮 + 3 分钟静默）
- 向量与 rerank（思源内核已内置，未开索引；4 万个块全量建索引要先决定云端还是本地模型）
- 注入的关键词匹配现在只取首句前 16 字做 LIKE，召回很粗
- 本机现有的 105 个会话、350 万字还没回灌（`mem scan --all` 看得见，`mem ingest-log` 逐个进）
- 画像层（人格与用户偏好的统一管理）没做，设计在 `docs/记忆系统-分层与召回设计.md`
