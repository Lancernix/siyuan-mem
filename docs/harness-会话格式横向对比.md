# 各家 harness 的会话日志：横向对比与统一读法

扫了本机全部会话，四家 168 个会话、4208 轮、335 万字。结论先说：

**格式名字不同、字段位置不同、事件名不同，但都是同一件事——一行一个 JSON，里面有一条带 role 和 content 的消息。所以按形状认比按名字认稳，一份读取器就够。**

之前写了四份专用适配器（WorkBuddy / Claude / OMP / DSH 各一份）。拿形状识别跑同一批文件对比，**168 个会话的轮数和字符数逐字节一致**，于是全删了，只留一份。

---

## 一、一览

| | WorkBuddy | Qoder | OMP | DSH | Claude Code（本机未装） |
|---|---|---|---|---|---|
| 路径 | `~/.workbuddy/projects/<ws>/<sid>.jsonl` | `~/.qoder/projects/<slug>/<sid>.jsonl` | `~/.omp/agent/sessions/<slug>/<ts>_<id>.jsonl` | `~/.dsh/sessions/<ws>/<sid>/session.v4.jsonl.zstd` | `~/.claude/projects/<slug>/<sid>.jsonl` |
| 编码 | 明文 | 明文 | 明文 | **多帧 zstd** | 明文 |
| 会话数 | 64 | 2 | 99 | 3 | — |
| 体积 | 187.9MB | 0.14MB | 45.5MB | 4.6MB | — |
| 有效字符 | 181 万 | 1.0 万 | 100 万 | 52.6 万 | — |
| 轮数 | 2630 | 21 | 1075 | 482 | — |
| 平均每轮 | 690 字 | 490 字 | 936 字 | 1091 字 | — |
| 字节/字 | **108** | 14 | 45 | **9** | — |

最后一行是"日志里有多少是水"：WorkBuddy 每 1 个有效字符要写 108 字节，DSH 只要 9 字节。差的不是格式，是工具调用结果和工作区快照——它们占了 WorkBuddy 日志的九成以上。

---

## 二、共同点（五条，全部要处理）

**1. 一行一个事件，事件里带一条消息。** 没有 XML、没有 zip 里的二进制，都是 JSONL（DSH 只是先压了一层）。

**2. 消息的形状是 role + content。** content 是块数组，块带 type：`text` / `thinking` / `tool_use` / `tool_result` / `input_text`。只要 type 是文本类的块。

**3. 一条回复会被拆成多个事件。** 这是最容易被忽略的一条，也是之前丢字最多的地方：DSH 按 step 拆（一个会话 183 个 step 才 37 轮），OMP 每次工具调用前后各发一条 assistant 消息，WorkBuddy 流式分块。**必须合并相邻同角色消息**，否则后半段回复因为"没有配对的提问"被整段丢掉——本机实测这样丢了 292 条、6.5 万字。

**4. 有大量伪装成 user 的注入块。** 各家叫法不同，但都得在读取时丢掉，否则会被当成用户说的话抽成记忆：

| 来源 | 标记 | 是什么 |
|---|---|---|
| WorkBuddy | `<cb_summary>` | 上下文压缩后的纪要，一条能到 48 万字 |
| WorkBuddy | `<conversation_history_summary>` | 旧版纪要格式 |
| WorkBuddy | `<task-notification>` | 后台任务完成通知 |
| WorkBuddy | `<system-reminder>` / `<craft_mode>` | 系统提示注入 |
| WorkBuddy | `<function_call>` / `<file-history` | 工具结果、文件快照 |
| OMP | `custom_message`（customType=handoff/skill） | 交接上下文、技能注入 |
| OMP | `compaction` 事件 | 压缩摘要 |
| OMP | role=developer（attribution=agent） | agent 自己说的话 |
| DSH | `source.kind = "plugin:*"` | 插件注入的上下文（包括记忆注入本身） |
| DSH | `developer/message` / `system/message` | 系统层消息 |
| Qoder | `origin.kind != "human"` | 非人手输入 |
| Qoder | `attachment` / `runtime-config` / `active-leaf` | 附件与运行时事件 |

**5. 子代理单独记一份，不能算进主线。** Claude/Qoder 标 `isSidechain`，OMP 的 `session` 事件带 `parentSession` 指回父会话。本机 OMP 99 个文件里有一批就是这种子线程。

---

## 三、各自的特殊（这些必须单独处理）

**DSH：多帧 zstd，Node 解不干净。**
`zlib.zstdDecompressSync` 和 `createZstdDecompress` 都只解第一帧，而且**不报错**：1MB 的文件解出 243 字节，看起来像成功了。必须按帧魔数 `28 B5 2F FD` 切开，逐帧解（本机 702 帧、2.94MB、0 帧失败）。
另外它的第一行是 `{type:"session", version:4}`，**和 OMP 的第一行长得一模一样**（OMP 是 version 3）。按"第一个匹配就返回"的方式嗅探，DSH 会被认成 OMP，解出 0 轮还不报错。

**WorkBuddy：单文件能到 51MB，水最多。**
一个会话 51MB，其中有效对话只有 26 万字。同目录下还有 `*.file-rollback.ndjson`（文件回滚记录），不是对话，要按文件名排除。

**Qoder：照抄了 Claude Code 的格式。**
user/assistant + `message.content` 块数组，和 Claude Code 一样；多出来的是 `workspace-directories`、`runtime-config`、`attachment`、`last-prompt`、`active-leaf` 几种自己的事件。用同一份代码就能读。

**OMP：role 词表最杂。**
`user` / `assistant` / `toolResult` / `developer` / `fileMention`。只收 `user`（attribution=user）和 `assistant`。它的 `session` 事件里还有 `parentSession`，用来判断是不是子会话。

---

## 四、所以统一读法是这样的

```
一行一个 JSON
  → 先看要不要解压（扩展名 .zstd 或文件头 28 B5 2F FD）→ 多帧拆开
  → 每条事件，从 [message, data.message, data, 自己] 里找第一个带 role 的对象
  → role 归一：user/human/prompt/input → user；assistant/ai/model/bot/output → assistant
  → content 归一：字符串直接用；数组只取 text / input_text / output_text 块
  → 过滤器（四层，一个都不能少）：
       注入块（cb_summary 等前缀）
       注入标记（plugin: / origin.kind / attribution）
       工具产物（<function_call / <file-history）
       子代理（isSidechain / parentSession）
  → 相邻同角色合并
```

`sniff()` **只用来给条目打来源标签**（`custom-mem-source`），不参与解析。这样新 harness 出来，解析零改动，标签最多显示 `unknown`。

代价要说清楚：形状识别对"role 字段叫别的名字"的格式无能为力（比如用 `author`）。真遇到就加一个别名，不用写适配器。

---

## 五、查自己机器上有多少

```bash
node src/cli.mjs scan           # 每家列 3 个样本
node src/cli.mjs scan --all     # 全读一遍，统计轮数和字数
node src/cli.mjs scan --harness omp
```

本机 168 个会话全量扫描 1.8 秒。

---

## 六、这些数字说明了什么

**能进记忆的原料比想象的多。** 四家合起来 335 万字，按 0.62 token/字估算约 200 万 token。全量回灌一次按 DeepSeek 价位算是几十块钱，不是几百。

**但九成是水。** WorkBuddy 的 187MB 里只有 181 万字是对话，其余是工具输出和文件快照；DSH 压到 9 字节/字，恰恰因为它只存事件不存文件内容。所以"读日志"的成本不在解析，在**过滤**——把工具产物挡在外面，剩下的才是语料。

**跨 harness 的记忆是有意义的。** 本机这四家不是重复的：WorkBuddy 长会话多（2630 轮/64 个），OMP 集中在 5–8 月的项目，DSH 只有 3 个但每轮最长。同一件事可能在不同 harness 里讨论过，分开存就永远串不起来。
