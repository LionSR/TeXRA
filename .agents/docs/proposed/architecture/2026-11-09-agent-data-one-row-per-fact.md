---
created: 2026-11-09
status: proposed
---

# Agent 数据：一个事实只存一行，展示由推导产生

这是一份评审后的设计提案，基线是 `main` 的 `db09959`。提案本身没有实现，也没有做原型；文中的数字都是对源码的静态统计。评审中发现的一个缺陷和几处过时陈述已在同一分支修掉，见 §8。范围是一次运行（run）的数据怎么存、怎么读，不含设置和其他当前值。

与已定案规则的关系：

- 按 [one fact, one representation](./2026-11-03-one-fact-one-representation.md) 的规则写：先按含义给事实命名并列出它的每一种表示，同一个 PR 里只留一种，保留一个事实之前先看同类项目存了什么。
- 沿用 [one run model](../../implemented/architecture/2026-09-10-one-run-model.md) 的 R1：一个事实只写成一种行，派生值只有一个归约函数。
- 不改 [Harness 1.0 PRD](./2026-10-28-harness-1-release-prd.md)“最小存储契约”的任何一条：沿用已记录的事实，不建第二套日志，保留存储词汇和原调用含义。
- 和两处已定案的说法不同，都在正文里说明理由：[storage v1](../../implemented/architecture/2026-09-28-storage-v1-design.md) §10 的“卡片仍由 loop 写入”（§3.1），以及 one fact, one representation §G 落地时“存储的 provider 枚举由存储自己拥有并保持封闭”（§3.3，只作为待决问题提出）。
- 落地时要随之改写的规范：`packages/harness/docs/spec.md` 的 §3.1 和 §4 的 W3、W4，`packages/harness/AGENTS.md` 的 “Event channels and cards”。

## 结论

**设计问题只有一个：行是按“谁读”分的（展示行和私有行），不是按“什么事实”分的。** 两边都需要的事实因此存成两行，再在读取时对齐；一次工具调用写 4 行，其中 2 行是为展示另写的。

推荐的设计是两条规则，都不引入新的行词汇：

1. **展示行只在没有执行行持有这个事实时才存。** 其余展示事件由一个函数从已提交的行推导，实时路径和冷读共用它。第一片是工具卡片。
2. **一个主题一个归约函数。** “一个 run 的记录行说明了什么”只写一遍，放在 `shared/session/` 的纯函数里，由 store 的投影、视图和窄读取共用。

另有一个需要负责人重开既有决定才能动的问题：行里的 provider 枚举是封闭的，所以移除一个 provider 仍然要升行版本（§3.3）。

不推荐的两种设计：把行统一成“开/关”成对的 op 行（只是改名，且和 PRD 的决定冲突）；用可变的状态表当真相（和“历史是唯一真相”冲突）。对比见 §2。

可以清除的过时设计见 §3.4。复读代码时还发现一个和本提案无关的缺陷，已在同一分支修复，见 §8。

## 1. 设计问题

### 1.1 行按读者分，同一事实因此有两行

`packages/harness/src/shared/schemas/sessionEvent.ts` 把 37 种行分成 26 种展示行和 11 种私有行，一行是否到达渲染端由它的类型决定（`isDisplayRow`）。从设计记录的先后看，展示词汇（trace）在前，运行历史是后来加上的执行真相；从那以后，展示行被一种一种地改成投影（`run.model`、`conversation.progress` 已退役，卡片输出和 `usage` 已改成投影，run 和 turn 不再是 stage）。这个过程停在了一半。按事实列出它现在的每一种表示：

| 事实               | 执行行                                    | 展示行                                                                | 现在怎么对齐                                                                                                                                                    |
| ------------------ | ----------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工具调用开始       | `tool.intent`（callId、attempt）          | `tool.start`（logId、toolName、实际执行的 input、card、section）      | 同一批提交：慢工具在 intent 那批，快工具在 result 那批（`cardRows`，`agent/runtime/loop/toolUseDispatch.ts:305-346`）                                           |
| 工具调用结束       | `tool.result`                             | `tool.end`（logId、status、files）                                    | 读时把同批的 `tool.result` 填进 `tool.end`（`settleCards`，`controllers/session/rowReader.ts:370-398`）；分页因此必须停在批次边界（`databaseLayer.ts:155-164`） |
| 一次计费的模型回合 | `model.message` response 的 `usage`       | `usage`                                                               | 已是投影（`projected_row`）：这一项已经只有一种存储表示                                                                                                         |
| 模型输出的文本     | response 的 `turn.content`                | `stream.end.finalText`（正文和思考各一条）、`response.finalized.text` | 不对齐，各存一份（`agent/runtime/ModelInvoker.ts:348-365`）                                                                                                     |
| 用户输入           | `followup.queued`、`model.message` append | `log`（`userMessage`）                                                | 不对齐，各存一份（`agent/trace/traceLogs.ts:160`）                                                                                                              |
| 模型失败           | `model.message` failed 的 `error`         | `log`（error）、`run.end.error`、`request.opened` 的重试载荷          | 按值复制到四种行                                                                                                                                                |

三处旁证：

- 代码自己的注释这样描述（`shared/schemas/traceEvent.ts:65-85`）：有运行历史的 run，`tool.end` 不存输出、`usage` 不存行；没有运行历史的 run（agent-CLI 子运行）两者都存。同一种行有两种含义，读取方要先知道这个 run 属于哪一类。
- 规范为了让这两种表示保持一致，写了两条 MUST（`packages/harness/docs/spec.md` §4）：W3 要求慢工具的 `tool.start` 和 intent 同批提交，W4 要求 `tool.result` 和它的整张卡片同批提交，并且分别规定了慢工具、快工具、没有开始过的调用和结果未知的调用各写哪几行。这些规则只在卡片是另一行时才需要。
- 规范说 `at` 只是信息性的（spec §2.2），但展示读取用“`at` 相等”判断批次边界，原因就是 `settleCards` 要在同一页里同时看到两行。

同类项目的做法（`.agents/docs/evidence/2026-10-30-harness-design-against-pi-durable-and-deepseek/pi-durable.md`）：pi-durable 的转录就是 entries，六种 entry，没有另写的卡片行；它的工具 intent 提交的是最终参数。

### 1.2 改动放大有记录

`shared/schemas/rowVersions.ts` 的版本注释就是记录。一次概念上的改动升了几种行的版本：

| 改动                   | 升版的行                                                                                                    | 次数 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ---- |
| 模型失败的形状（四次） | `model.message` v9、v10、v12、v16；`run.end` v3、v5、v9；`request.opened` v7、v8、v10；`log` v4、v5、v6、v8 | 14   |
| 移除 provider（两次）  | `run.config` v5、v6；`model.message` v6、v7；`context.edit` v4、v5；`request.opened` v3                     | 7    |
| 媒体改成按地址存       | `model.message` v5；`context.edit` v3；`tool.result` v2；`followup.queued` v3；`log` v3                     | 5    |
| 用量字段改名           | `model.message` v8；`context.edit` v6；`usage` v2                                                           | 3    |
| 只有展示变了           | `tool.start` v2、v4；`stage.start` v2、v3；`log` v2、v7；`process.output` v2                                | 7    |

没有 upcaster，所以每次升版都让已有的 run 变成只读。发布前这只是不方便；冻结之后就是用户的 run 不能续跑。

其中一部分已经修掉：协议改成开放字符串之后（`StoredProtocolSchema`，#14476），移除 provider 不再升 `model.message` 和 `context.edit`。`run.config` 和 `request.opened` 里的 provider 枚举仍然封闭，这是有意的决定，见 §3.3。

### 1.3 同一条记录规则写了几遍

“一次 activation 会清掉上一次的 end 和 stop”这条规则现在有四个实现：

- `controllers/session/projections.ts:171-177`（`RECORD_STEPS`，store 的 `run_record` 投影）
- `shared/session/sessionViewUpdate.ts:673-687`（视图）
- `shared/session/runRowReads.ts:149-150`（`lifecycleOf`，input 读取）
- `shared/session/runRowReads.ts:274`（`turnReceipt`，回执）

“detach 切断父边”有三个实现，“用户起的标题不被模型标题覆盖”有两个。T5（#14854）已经把 store 里的两份收成 `run_record` 一份，它点名的第三份（视图）和窄读取还在。

### 1.4 用《软件设计的哲学》的词说

- **重复，两种表示。** 卡片行和调用行；四处 activation 规则。
- **信息泄漏。** “这个 run 有没有运行历史”泄漏到了 `tool.end`、`usage`、`settleCards`、`displayRows` 和转录的归约里。
- **特例和通用混在一起。** 快工具和慢工具的卡片在不同的批次打开；这是展示时机的特例，却写在提交路径和规范的 MUST 里。
- **时间分解。** 卡片按“什么时候显示”组织（开始一行、结束一行），而调用事实已经按同样的时刻各有一行。
- **没有把错误定义掉。** W3 和 W4 规定的是“两行必须一起提交”。只有一行时，这类错误不存在。
- **改动放大。** §1.2。

## 2. 三种设计

AGENTS.md 要求先比较两种设计再选（two designs compared before choosing），这里比较三种。

| 设计                       | 做法                                                           | 结论                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 行层统一                | 所有“会等待的事”存成 `op.open` / `op.close` 两种行，种类是数据 | **不推荐。** PRD 已决定“保留存储词汇和原调用含义……不引入第二套日志”。各种调用的规则不同（重放、重试预算、是否阻塞调用方），统一的只是名字；每个读者仍要按种类分支，接口没有变深。 |
| B. 记录层统一              | 行保持原样；展示由推导产生；每个主题一个归约函数               | **推荐。** 不改词汇，删掉的是副本和重复的规则。代码里已经有三处先例：`usage` 投影、`runRows.ts` 的共享归约、`plugin.fact` 的种类即数据。                                          |
| C. 状态表为真（pi 的做法） | 调用和任务存成可变记录，原地更新                               | **不采用。** 和“历史是唯一真相，投影可以丢掉重建”冲突；恢复和实时走同一个归约函数是这个代码库最强的性质，不值得换。                                                               |

A 和 B 的区别是统一发生在哪一层。读者要的统一形状（一次调用有发出、开始、结束和状态）已经存在于 `HISTORY_TABLES`，那是一个投影。把同样的形状压到行上，换来的只有一次格式重写。

## 3. 推荐设计

### 3.1 规则一：展示行只在没有执行行持有这个事实时才存

**机制。** 展示流的定义是一个函数：输入一条已提交的行，输出它产生的展示事件。展示种类的行原样返回；执行行返回它对应的展示事件；其余返回空。它推广的是现有的 `Database.displayRows`（`controllers/session/databaseLayer.ts:182-188`），发布者已经用它从内存里的已提交行算出实时批次（`agent/runtime/sessionEventsLayer.ts:181`）。冷读用同一个函数：读出展示种类的行和它们的来源行，解码后逐行映射。`projected_row` 留给来源行很重的种类当缓存（现在只有 `usage`）。

事件词汇不变。渲染端、NDJSON、SDK 事件流和 trace 导出看到的仍是 `tool.start`、`tool.end`、`usage`；变的只是这些事件在有运行历史的 run 上不再是存下来的行。

**一条硬约束：一条存储行最多产生一条转录事件。** 视图的转录按 `seq` 去重（`shared/session/sessionViewUpdate.ts:1011-1012`），共用一个 `seq` 的第二条转录事件会被丢掉。`Run.events` 背后的 `replayTrace` 原来也只按 `seq` 去重，并且已经因此丢过事件，见 §8。

**第一片：工具卡片。**

- `tool.intent` 并入 `tool.start` 的字段：logId、toolName、实际执行的 input、card、section。推导函数把它映射成 `tool.start`。PRD 的许可契约要求先持久化执行意图、再执行同一个操作；而调用体实际执行的 input（经过钩子改写之后的）现在只有 `tool.start` 直接记着，执行侧要从 `hook.outcome` 重建。pi-durable 的 intent 提交的也是最终参数。
- `tool.result` 并入 logId。推导函数把它映射成 `tool.end`：状态来自 disposition，输出来自同一行，编辑过的文件来自同一行的 `result.edits`（今天也是这样算的，`toolUseDispatch.ts:587-596`）。一次没有开始过就结束、但今天有卡片的调用（被守卫拒绝、工具不可用）再带上 toolName 和 input，它的 `tool.end` 自己就能建卡片。
- loop 不再写卡片行。`tool.start`、`tool.end` 这两种行只留给没有运行历史的 run（外部 agent 自己报告的调用）。

由此删掉的：

- `cardRows` 和它的三处调用点上的开/关参数（`toolUseDispatch.ts:305-346, 368, 500, 604-611`）。
- `settleCards`、`cardResult`，以及展示读取里为它多选的 `tool.result`（`rowReader.ts:60-67, 370-398`）。
- 按 `at` 相等推断批次边界的 `DISPLAY_PAGE_END`（`databaseLayer.ts:155-164`）。每条展示事件只来自一行，分页可以停在任意一行。store review 的 F3 原本的修法是加一个 `batch` 列；这里是让“批次身份”不再被需要，`at` 也回到规范说的“只是信息性的”。
- 规范里 W3 的卡片条款和 W4 里按慢、快、未开始、结果未知分别列出的卡片规则。
- 每次已执行的工具调用从 4 行变成 2 行。

**和 storage v1 §10 的关系。** §10 决定输出只存一次、卡片仍由 loop 写入，给出的理由是没有工具侧的卡片、没有第二条追加路径。这两条在这里仍然成立，而且更强：卡片不是 loop 另外写的一行，而是 loop 的调用行本身。§10 拒绝的方案（两份都留、展示侧截断）也仍然被拒绝。

**一个要 UI 负责人定的选择。** 快工具的卡片现在在结果那一批才出现。并入后有两种做法：

- intent 总是带展示字段，卡片在调用体开始时出现。快工具会多一条提前的 `tool.start`；“快慢”这个展示特例从提交路径和规范里消失。推荐这个。
- intent 只在慢工具上带展示字段，快工具由自足的 `tool.end` 建卡片。出现时机和现在一样，但 NDJSON 上快工具不再有 `tool.start`。

**其余展示行，没有逐个核对，不属于本提案要做的部分。**

| 展示行                                   | 现状               | 判断                                                                                                |
| ---------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| `stream.end.finalText`（模型正文和思考） | 存                 | 可能可以推导：先核对转录对原始分块文本和最终文本的要求                                              |
| `log`（模型失败）                        | 存                 | 可能可以推导：failed 行和 `run.end` 已持有                                                          |
| `log`（`userMessage`）                   | 存                 | 不确定：正文在 `run.config`、`followup.queued` 或 append 里，但它还带着只为展示的数据（脚本摘要等） |
| `response.finalized`                     | 存，运行状态也读它 | 不动：它自己是一个事实                                                                              |
| `context.state`                          | 存，列表读它       | 不动：小，而且列表需要                                                                              |
| 其余 `log`、`stage.*`、`process.output`  | 存                 | 不动：没有别的行持有                                                                                |

### 3.2 规则二：一个主题一个归约函数

`shared/session/runRows.ts` 已经是“运行状态和视图都读的行只处理一次”的地方，覆盖 5 种行（位置、请求、follow-up）。T5 把 run 的记录规则收进了 `controllers/session/projections.ts` 的 `RECORD_STEPS`，但 `controllers/` 在 `shared/` 上面，视图在 `shared/` 而且跑在浏览器里，够不着，所以它和两个窄读取仍各写了一遍。

做法是把 `RECORD_STEPS` 和 `recordAfter` 搬进 `shared/session/`，让它对“每个槽里放什么”通用：投影放 commit，视图和读取放行本身。

- 规则（activation 清除、detach、标题、授权、输入关闭）只写在这个纯函数里。
- store 的 `run_record` 投影应用它并保存结果（搬过来，不是再写一份）。
- 视图的 `applyRunEvent` 从它的结果取字段，不再自己判断这几条规则。
- `lifecycleOf` 删除，`turnReceipt` 里那一行规则删除。

这一片的收益比 §3.1 小：重复的是五条各两三行的规则，不是一整套机制。它值得做的理由是这些规则正是 one fact, one representation 记录的反复出错的那一类（停止、恢复、父边），而不是行数。

之后可以再看一步，但不属于本提案的必做部分：`run_record` 和 `listing_entry` 为同样 14 种行各存了一份“最新一行的 commit”。冷视图如果从 `run_record` 初始化，`listing` 投影只需要保留未关闭的请求、未消费的输入和 `context.state`。

**不做的一件事。** 不为“调用”另建共享的读模型。卡片改成由行自己推导之后，调用行只剩两个读者：loop 的运行状态（回答能否续跑）和历史查询（填给模型的表），它们回答的是不同的问题。把 `HistoryQuery.ts` 的 `callWrites` 提成共享函数只会有一个调用方，按 AGENTS.md 的规则（single-caller extractions are banned）不做。

### 3.3 待决问题：行里的封闭 provider 枚举

这一条和一个已落地的决定冲突，所以只提出问题，不列为规则。

- **现状。** `run.config` 的 `binding.backend`（`shared/schemas/runInput.ts:51-54, 94-97`）和 `request.opened` 重试载荷里的 API key provider 是封闭枚举。移除 OpenRouter 和 Copilot 各升了一次 `run.config`，前者还升了一次 `request.opened`。
- **既有决定。** one fact, one representation §G 落地时写明：存储的枚举（`ModelBackendSchema`、`ApiKeyProviderIdSchema`）由存储自己拥有并保持封闭，用编译期检查和 llm 的目录对齐；理由是 harness 以 caret 范围依赖 llm，目录在新版 llm 里变长时，不能在没有 harness 发布的情况下把存储的联合类型变宽。
- **冲突在哪。** 这个理由保护的是“变长”。它的代价落在“变短”上：PRD 的日常变更检查之一是“更换或移除执行 backend……不为此更新多个历史事件版本”，对这两种行现在不成立。
- **一个两头都顾的做法。** 写入方的类型保持封闭（harness 自己的列表，编译期检查不变），所以新版 llm 仍然不能让 harness 写出列表之外的值；读取方把已存的值当字符串读，不认识的 backend 在绑定时被拒绝续跑并说明原因。先例是缺插件的事实读作 `unavailable`（#14586）和 `StoredProtocolSchema`（#14476）。这正是 PRD 的要求：“旧调用是什么，就一直保存成什么；新代码能否继续它，另行判断。”
- **是否重开由负责人定。** 现有证据只有两次移除。

模型失败按值存在四种行里。v16 之后它是 verdict，措辞归读者，形状已经比之前稳定；本提案不动它，只记录：下一次改它仍然会升四种行。

### 3.4 可以清除的过时设计

| #   | 过时的设计                                                                                       | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 清除的代价                                                             |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | 有运行历史的 run 上的卡片行                                                                      | §3.1                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 格式：`tool.intent`、`tool.result` 升版                                |
| 2   | 每行的 `origin` 列、`OwnerId`、`ProcessIdentity`、`platform/defaults/nodeProcesses.ts`（215 行） | 只在 `databaseLayer.ts:629, 664` 写入；代码里没有读取方。它原本供 claim 的存活证明使用；ownership 那一片删掉了 `ProcessIdentity.owners` 和 claim，盖戳这一半留了下来。为了盖这个戳，每个进程在建 process layer 时要读一次 `/proc`（Linux）或起一次 `ps` / PowerShell（`controllers/session/sessionLayer.ts:362-367`）。pi-durable 没有任何主机名、pid 或进程身份。但它写在规范（spec §1、§2.2）和对外指南（`docs/api/durable-protocol.md`）里，剩下的用处是人工排查 | 格式：DDL 少一列；NDJSON 和 trace 的载荷少一个字段；规范和指南各改一处 |
| 3   | `run.position` 的 `family`                                                                       | 只有一个值 `'toolUse'`（`shared/schemas/runHistoryEvent.ts:36`），唯一的写入是常量（`agent/runtime/loop/rows.ts:79`），唯一的读取是判空（`sessionViewUpdate.ts:749`）                                                                                                                                                                                                                                                                                               | 格式：`run.position` 升版                                              |
| 4   | 按 `at` 相等推断批次边界                                                                         | 随第 1 项消失                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 无                                                                     |
| 5   | 三份已过时的 implemented 说明（代码注释里的同类描述已改）                                        | single-owner liveness §2 和 §3、storage v1 §8 和 Q6、core concepts 的 Claim 和不变量 1，都还在描述 `owner_id`、claim 和多进程共享一个库；规范 §7 已经写明“没有 daemon，也没有 claim”。代码里十三处提到 claim 的注释已在同一分支改掉                                                                                                                                                                                                                                 | 无格式变化                                                             |
| 6   | 冻结时归零：行版本号、17 个退役行种类、1 个退役插件事实                                          | 按 AGENTS.md，1.0 的格式还没有发布，`config/storage/frozen/` 也不存在；需要负责人确认没有已发布的构建写过这些版本                                                                                                                                                                                                                                                                                                                                                   | 需要负责人决定：现有的开发库在归零时会被整体拒绝一次                   |

关于第 2 项的两种做法：整个删掉；或者保留这一列供人工排查，但只盖主机名和 pid，删掉进程启动时间的探测。后者不改格式，也去掉了每次启动的子进程。

第 1、3 项（以及第 2 项，如果选择删掉）都是格式变更。按 PRD 推进顺序的规则（不可逆的先做，存储格式在冻结前一次做完），它们应当进同一个格式批，共用一次 golden 重生成。

已在别处记录、这里不重复的：全局库打开完整的事件库、`StoreMode` 的四个值、独占库上的 `retryBusy`、闭包参数包（store review F5）、没有前进步骤（F4）。不在此列的两项：当前值的 family 版本（PRD 已决定不引入 family 版本框架）；pre-1.0 的库整体移到 `.pre1`（storage v1 的 Q3 已决定）。

## 4. 放弃什么

- 如果选推荐的做法，快工具的卡片会比现在早出现，NDJSON 上它的 `tool.start` 也更早。
- 被守卫拒绝或工具不可用的调用，NDJSON 上只有一条自足的 `tool.end`，不再有成对的 `tool.start`。按开始和结束配对的外部读者要知道这一点。
- 如果删掉 `origin`，NDJSON 和 trace 的行载荷里不再有它。仓库里没有依赖它的读者，但它是对外输出和规范的一部分，要随契约版本说明。
- 冷读有运行历史的 run 的转录时，要解码 `tool.intent` 和 `tool.result` 两种行。今天已经解码 `tool.result`；多出来的是 intent，它是小行。
- 行的 `seq` 变稀疏的程度会变（卡片不再占序号）。没有找到依赖序号连续的读者。

不放弃的：一个发布者、`RunCell.append` 是运行历史的唯一写入方、没有快照、恢复和实时是同一个归约函数、事件词汇、视图契约、历史查询的四张表。

## 5. 顺序

1. **修 §8 的缺陷。** 已在同一分支完成。
2. **格式批（冻结前，一次重生成 golden）。** §3.4 的第 1、3 项，以及第 2 项和 §3.3（如果负责人决定做）。它们互不依赖，但共用一次重生成。规范的 W3、W4 和 AGENTS.md 的卡片段落在同一个 PR 里改写。
3. **记录归约函数（§3.2）。** 没有格式变化，不受冻结约束。
4. **注释和说明（第 5 项）。** 注释已在同一分支改完；三份 implemented 说明还没有动。
5. **冻结时归零（第 6 项）。** 只在冻结那一刻有意义，由负责人决定。

## 6. 验收标准

- `cardRows`、`settleCards`、`cardResult`、`DISPLAY_PAGE_END` 在 `packages/harness/src` 里搜不到。
- golden 库里有运行历史的 run 没有 `tool.start` 和 `tool.end` 行；它的转录和 NDJSON 仍然有这两种事件。
- 规范 §4 里没有关于卡片和调用行同批提交的 MUST。
- “activation 清除 end 和 stop”只有一个实现：按 `'run.activate'` 搜索，处理它的归约只剩 `shared/session/` 里的那个纯函数和 `runState.ts`。
- 如果删掉 `origin`：`platform/defaults/nodeProcesses.ts` 不存在；打开会话不再起 `ps` 或 PowerShell。
- 按测试规则，这些片不加新的单元测试；格式变更由 golden 和崩溃一致性回放覆盖。

## 7. 风险和没有验证的部分

- 没有做原型，也没有量过冷读的开销。卡片那一片落地时应当量一次长 run 的转录读取。
- 卡片的映射必须满足“一条存储行最多一条转录事件”；被拒绝的调用因此只有一条 `tool.end`，这是对外可见的变化。
- 快慢工具的展示时机是产品行为，需要 UI 负责人定。
- 视图的归约在浏览器里运行，§3.2 的纯函数不能引入非浏览器安全的依赖。
- `origin` 是否有仓库外的读者（用户脚本读 NDJSON，或人工排查时直接查库）无法从仓库里确认。
- §3.1 表里的其余展示行没有核对。

## 8. 复读时发现的缺陷和过时陈述

和本提案无关。三项都已在同一分支修掉，各是一个提交：

1. **`Run.events` 丢掉模型标题的 `usage` 事件。** 模型写的 `run.description` 带着它那次请求的计费用量，`displayRows` 为它再投影一条 `usage`，两条共用一个 `seq`（`controllers/session/projections.ts:291-307`）。`replayTrace` 原来把一个 `seq` 的第一行读完就当整个 `seq` 已读，所以先到的 `run.description` 占掉了它，后到的 `usage` 被丢掉。影响：只在给根 run 起标题的进程里出现（`processLayer` 提供 `LabelsRootRuns`）；从 `Run.events` 累加 `usage` 的读者会少算这一次请求；视图的总用量不受影响，它按 commit 而不是 `seq` 去重。修法：`replayTrace` 记下最新 `seq` 上已读的行种类（`controllers/session/runTrace.ts` 的 `kinds`）。一个 `seq` 上每种行最多一条（一条事件行，每种投影行一条），所以另一种行会被读到，重复送达的行仍然不会。回归测试在 `packages/harness/test/controllers/session/runTrace.vitest.ts`，修复前失败。
2. **规范里的 schema 版本号过时。** `packages/harness/docs/spec.md` 写的是 “The store MUST carry … schema version 102”，代码是 103（`controllers/session/storeSchema.ts` 的 `SCHEMA_VERSION`）。已改成 103。同一段里“102 及以上”和“102 以下”说的是 1.0 基线，没有动。
3. **`scripts/check-fact-spread.mjs` 的谓词表里还有 `ownedHere`。** 仓库里已经没有这个名字，其他被删掉的谓词都随删除离开了这张表。已从表里和 `packages/harness/AGENTS.md` 的示例里去掉。

## Verified

在 `main` 的 `db09959` 上核对。设计部分全部是读代码和 `grep`。§8 的修复跑过 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run gate:docs` 的三个脚本、`node scripts/check-api-report.mjs` 和 `npm test`（253 个文件、569 个测试通过）：

- 37 种行、26 种展示行、11 种私有行：`shared/schemas/sessionEvent.ts` 的三个 union 和 `shared/schemas/rowVersions.ts` 的 `ROW_KINDS`。
- 一次工具调用写的行，以及哪些调用有卡片：`agent/runtime/loop/toolUseDispatch.ts` 的 `commit`、`cardRows`、`bodyStarts`、`skipCall` 和结果提交；规范 §4 的 W3、W4 与代码一致。
- `tool.end` 和 `usage` 在两类 run 上的不同含义：`shared/schemas/traceEvent.ts:65-85`。
- 编辑过的文件可以从已存的结果推出：`SettledToolResultSchema` 保留 `edits`（`shared/schemas/toolResult.ts:256-265`）。
- 读取 `tool.start`、`tool.end` 的地方都在展示事件一侧（转录、视图、`runTrace`、压缩活动投影）；写入只有 dispatch 和外部 agent 的 `openToolCard`。
- 视图的转录按 `seq` 去重：`sessionViewUpdate.ts:1011-1012`；`tool.end` 找不到卡片时被忽略：`shared/session/transcriptUpdate.ts:200-203`。
- `origin` 没有读取方：在 `packages/*/src` 里搜索行信封的 `.origin`，命中的都是别的字段（模型的 origin、转录行的 `origin === 'local'`）；`OwnerId`、`ProcessIdentity`、`processStartIdentity` 的全部使用点都在写入路径上。
- `family` 的读写点：`rows.ts:79`、`runRows.ts:108`、`sessionViewUpdate.ts:749`。
- 版本升级次数：逐条读 `rowVersions.ts` 的注释后计数。
- activation 规则的四个实现：按 `'run.activate'` 搜索后逐个读。
- blob 地址只有一种算法：内联字符串和媒体都是 JSON 文本的 sha256（`utils/core/idHash.ts` 的 `blobAddress`）。
- 行种类在 harness 之外只在五个文件里被点名，都是展示事件，没有私有行：`packages/trace-viewer/src/traceFrames.ts`（`run.start`、`run.position`）、`packages/cli/src/runtime/headless/executeCli.ts:243`（`request.decided`）、`sessionProgressSubscription.ts:127` 和 `taskAttach.ts:69`（过滤 debug 级的 `log`）、`packages/texra/src/tools/agentCli/agentCliShared.ts:259`（外部 agent 发出 `usage`）。
- 已定案的决定：PRD“最小存储契约”和“实现前需要收敛的选择”；storage v1 §5、§10 和 §13；one run model §2 和 §3；one fact, one representation 的规则、§A 的“Who may run this run”行和 §G 的落地说明；规范 §2.2、§3、§4 和 §7；rulings ledger（没有关于 `origin`、卡片或 `family` 的裁决）；`refuted-candidates.json`（`STORE-context-blob-as-brought-blob`、`RUN-one-skip-signal`、`ROW-followup-closed-as-run-removed` 等与本提案不冲突）。
- 没有核对的：git 历史（这个检出只有 51 个提交，无法确认各次升版的日期）；`release/0.40` 分支。
