---
created: 2026-11-09
status: proposed
---

# Agent 数据：一个事实只存一行，展示由推导产生

这是一份只读评审后的设计提案，基线是 `main` 的 `db09959`。没有改动任何代码，也没有做原型；文中的数字都是对源码的静态统计。范围是一次运行（run）的数据怎么存、怎么读，不含设置和其他当前值。

与已定案规则的关系：

- 沿用 [one run model](../../implemented/architecture/2026-09-10-one-run-model.md) 的 R1：一个事实只写成一种行，派生值只有一个归约函数。本提案是把这条规则执行到底，不是新规则。
- 不改 [Harness 1.0 PRD](./2026-10-28-harness-1-release-prd.md)“最小存储契约”的任何一条：沿用已记录的事实，不建第二套日志，保留存储词汇和原调用含义。
- 只和一处已定案的说法不同：[storage v1](../../implemented/architecture/2026-09-28-storage-v1-design.md) §10 的“卡片仍由 loop 写入”。理由在 §3.1。

## 结论

**设计问题只有一个：行是按“谁读”分的（展示行和私有行），不是按“什么事实”分的。** 两边都需要的事实因此存成两行，再在读取时对齐；一次工具调用写 4 行，其中 2 行是为展示另写的。

推荐的设计是三条规则，都不引入新的行词汇：

1. **展示行只在没有执行行持有这个事实时才存。** 其余展示事件由一个函数从已提交的行推导，写入路径和冷读路径共用它。第一片是工具卡片。
2. **一个主题一个归约函数。** “一个 run 的记录行说明了什么”只写一遍，放在 `shared/session/runRows.ts`，由 store 的投影、视图和窄读取共用。
3. **会增减的名字存成开放字符串，在执行边界校验。** `run.config` 里的 backend 还是封闭枚举，移除一个 provider 仍然要升行版本。

不推荐的两种设计：把行统一成“开/关”成对的 op 行（只是改名，且和 PRD 的决定冲突）；用可变的状态表当真相（和“历史是唯一真相”冲突）。对比见 §2。

可以清除的过时设计见 §3.4，最确定的两项是：有运行历史的 run 上的卡片行，以及没有任何读者的 `origin` 列和为它存在的整套进程身份探测。

## 1. 设计问题

### 1.1 行按读者分，同一事实因此有两行

`packages/harness/src/shared/schemas/sessionEvent.ts` 把 37 种行分成 26 种展示行和 11 种私有行，一行是否到达渲染端由它的类型决定（`isDisplayRow`）。从设计记录的先后看，展示词汇（trace）在前，运行历史是后来加上的执行真相；从那以后，展示行被一种一种地改成投影（`run.model`、`conversation.progress` 已退役，卡片输出和 `usage` 已改成读时投影，run 和 turn 不再是 stage）。这个过程停在了一半：

| 事实               | 执行行                                    | 展示行                                                                | 现在怎么对齐                                                                                                                                                    |
| ------------------ | ----------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工具调用开始       | `tool.intent`（callId、attempt）          | `tool.start`（logId、toolName、实际执行的 input、card、section）      | 同一批提交：慢工具在 intent 那批，快工具在 result 那批（`cardRows`，`agent/runtime/loop/toolUseDispatch.ts:305-346`）                                           |
| 工具调用结束       | `tool.result`                             | `tool.end`（logId、status、files）                                    | 读时把同批的 `tool.result` 填进 `tool.end`（`settleCards`，`controllers/session/rowReader.ts:370-398`）；分页因此必须停在批次边界（`databaseLayer.ts:155-164`） |
| 一次计费的模型回合 | `model.message` response 的 `usage`       | `usage`                                                               | 已是投影（`projected_row`），但推导写了两遍：内存路径的 `usageRows` 和 SQL 路径的 `PROJECTORS.usage`（`controllers/session/projections.ts:291-307, 334-370`）   |
| 模型输出的文本     | response 的 `turn.content`                | `stream.end.finalText`（正文和思考各一条）、`response.finalized.text` | 不对齐，各存一份（`agent/runtime/ModelInvoker.ts:348-365`）                                                                                                     |
| 用户输入           | `followup.queued`、`model.message` append | `log`（`userMessage`）                                                | 不对齐，各存一份（`agent/trace/traceLogs.ts:160`）                                                                                                              |
| 模型失败           | `model.message` failed 的 `error`         | `log`（error）、`run.end.error`、`request.opened` 的重试载荷          | 按值复制到四种行                                                                                                                                                |

代码自己的注释也这样描述（`shared/schemas/traceEvent.ts:65-85`）：有运行历史的 run，`tool.end` 不存输出、`usage` 不存行；没有运行历史的 run（agent-CLI 子运行）两者都存。于是同一种行有两种含义，读取方要先知道这个 run 属于哪一类。

### 1.2 改动放大有记录

`shared/schemas/rowVersions.ts` 的版本注释就是记录。一次概念上的改动升了几种行的版本：

| 改动                   | 升版的行                                                                                                    | 次数 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ---- |
| 模型失败的形状（四次） | `model.message` v9、v10、v12、v16；`run.end` v3、v5、v9；`request.opened` v7、v8、v10；`log` v4、v5、v6、v8 | 14   |
| 移除 provider（两次）  | `run.config` v5、v6；`model.message` v6、v7；`context.edit` v4、v5；`request.opened` v3                     | 7    |
| 媒体改成按地址存       | `model.message` v5；`context.edit` v3；`tool.result` v2；`followup.queued` v3；`log` v3                     | 5    |
| 用量字段改名           | `model.message` v8；`context.edit` v6；`usage` v2                                                           | 3    |
| 只有展示变了           | `tool.start` v2、v4；`stage.start` v2、v3；`log` v2、v7；`process.output` v2                                | 7    |

没有 upcaster，所以每次升版都让已有的 run 变成只读。发布前这只是不方便；冻结之后就是用户的 run 不能续跑。PRD 的日常变更检查之一是“更换或移除执行 backend……不为此更新多个历史事件版本”，这一条现在还不成立。

### 1.3 同一条记录规则写了几遍

“一次 activation 会清掉上一次的 end 和 stop”这条规则现在有四个实现：

- `controllers/session/projections.ts:171-177`（`RECORD_STEPS`，store 的 `run_record` 投影）
- `shared/session/sessionViewUpdate.ts:673-687`（视图）
- `shared/session/runRowReads.ts:149-150`（`lifecycleOf`，input 读取）
- `shared/session/runRowReads.ts:274`（`turnReceipt`，回执）

“detach 切断父边”有三个实现，“用户起的标题不被模型标题覆盖”有两个。T5（#14854）已经把 store 里的两份收成 `run_record` 一份，它点名的第三份（视图）和窄读取还在。

### 1.4 用《软件设计的哲学》的词说

- **重复，两种表示。** 卡片行和调用行；两处 `usage` 推导；四处 activation 规则。
- **信息泄漏。** “这个 run 有没有运行历史”泄漏到了 `tool.end`、`usage`、`settleCards`、`displayRows` 和转录的归约里。
- **特例和通用混在一起。** 快工具和慢工具的卡片在不同的批次打开；这是展示时机的特例，却写在提交路径上。
- **时间分解。** 卡片按“什么时候显示”组织（开始一行、结束一行），而调用事实已经按同样的时刻各有一行。
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

**机制。** 展示流的定义是一个函数：`displayOf(row)`，输入一条已提交的行，输出它产生的展示事件。展示种类的行原样返回；执行行返回它对应的展示事件；其余返回空。它推广的是现有的 `Database.displayRows`（`controllers/session/databaseLayer.ts:182-188`），发布者已经用它从内存里的已提交行算出实时批次（`agent/runtime/sessionEventsLayer.ts:181`）。冷读也用同一个函数：读出展示种类的行和它们的来源行，解码后逐行映射。`projected_row` 只留给来源行很重的种类当缓存（现在只有 `usage`）。

事件词汇不变。渲染端、NDJSON、SDK 事件流和 trace 导出看到的仍是 `tool.start`、`tool.end`、`usage`；变的只是这些事件在有运行历史的 run 上不再是存下来的行。

**一条硬约束。** 转录按 `seq` 去重（`shared/session/sessionViewUpdate.ts:1011-1012`），所以一条存储行最多产生一条转录事件。

**第一片：工具卡片。**

- `tool.intent` 并入 `tool.start` 的字段：logId、toolName、实际执行的 input、card、section。`displayOf` 把它映射成 `tool.start`。PRD 的许可契约要求先持久化执行意图、再执行同一个操作；而调用体实际执行的 input（经过钩子改写之后的）现在只有 `tool.start` 直接记着，执行侧要从 `hook.outcome` 重建。
- `tool.result` 并入 `tool.end` 的字段：logId、files。`displayOf` 把它映射成 `tool.end`，状态来自 disposition，输出来自同一行。一次没有开始过就结束的调用（被拒绝、工具不可用）再带上 toolName 和 input，它的 `tool.end` 自己就能建卡片。
- loop 不再写卡片行。`tool.start`、`tool.end` 这两种行只留给没有运行历史的 run（外部 agent 自己报告的调用）。

由此删掉的：

- `cardRows` 和它的三处调用点上的开/关参数（`toolUseDispatch.ts:305-346, 368, 500, 604-611`）。
- `settleCards`、`cardResult`，以及展示读取里为它多选的 `tool.result`（`rowReader.ts:60-67, 370-398`）。
- 按 `at` 相等推断批次边界的 `DISPLAY_PAGE_END`（`databaseLayer.ts:155-164`）。每条展示事件只来自一行，分页可以停在任意一行。store review 的 F3 原本的修法是加一个 `batch` 列；这里是让“批次身份”不再被需要。
- 每次已执行的工具调用从 4 行变成 2 行。

**和 storage v1 §10 的关系。** §10 决定输出只存一次、卡片仍由 loop 写入，给出的理由是没有工具侧的卡片、没有第二条追加路径。这两条在这里仍然成立，而且更强：卡片不是 loop 另外写的一行，而是 loop 的调用行本身。§10 拒绝的方案（两份都留、展示侧截断）也仍然被拒绝。

**一个要 UI 负责人定的选择。** 快工具的卡片现在在结果那一批才出现。并入后有两种做法：

- intent 总是带展示字段，卡片在调用体开始时出现。快工具会多一条提前的 `tool.start`；“快慢”这个展示特例从提交路径上消失。推荐这个。
- intent 只在慢工具上带展示字段，快工具由自足的 `tool.end` 建卡片。出现时机和现在一样，但 NDJSON 上快工具不再有 `tool.start`。

**后续候选，逐个核对后再做。**

| 展示行                                   | 现状               | 判断                                           |
| ---------------------------------------- | ------------------ | ---------------------------------------------- |
| `usage`                                  | 已投影             | 两处推导并成 `displayOf` 一处                  |
| `stream.end.finalText`（模型正文和思考） | 存                 | 候选：先核对转录对原始分块文本和最终文本的要求 |
| `log`（`userMessage`）                   | 存                 | 候选：`followup.queued` 已持有全文             |
| `log`（模型失败）                        | 存                 | 候选：failed 行和 `run.end` 已持有             |
| `response.finalized`                     | 存，运行状态也读它 | 不动：它自己是一个事实                         |
| `context.state`                          | 存，列表读它       | 不动：小，而且列表需要                         |
| 其余 `log`、`stage.*`、`process.output`  | 存                 | 不动：没有别的行持有                           |

### 3.2 规则二：一个主题一个归约函数

`shared/session/runRows.ts` 已经是“运行状态和视图都读的行只处理一次”的地方，覆盖 5 种行（位置、请求、follow-up）。把生命周期和记录行也放进去：`run.start`、`run.activate`、`run.stop`、`run.end`、`run.detach`、`run.removed`、`followup.closed`、`run.config`、`run.description`、`approval.policy`、`run.report`、`process.exit`、`plugin.fact`。

- 规则（activation 清除、detach、标题、授权）只写在这个纯函数里。
- store 的 `run_record` 投影应用它并保存结果指向的行（今天的 `RECORD_STEPS` 和 `recordAfter` 搬过来，不是再写一份）。
- 视图的 `applyRunEvent` 从它的结果取字段，不再自己判断。
- `lifecycleOf` 和 `turnReceipt` 用它，不再各写一遍。

这是把 T5 做完：T5 把规则的主人定在投影里，但投影在 `controllers/`，视图在 `shared/` 而且跑在浏览器里，够不着。规则放进 `shared/` 的纯函数，投影只负责持久化。

之后可以再看一步，但不属于本提案的必做部分：`run_record` 和 `listing_entry` 为同样 14 种行各存了一份“最新一行的 commit”。冷视图如果从 `run_record` 初始化，`listing` 投影只需要保留未关闭的请求、未消费的输入和 `context.state`。

**不做的一件事。** 不为“调用”另建共享的读模型。卡片改成由行自己推导之后，调用行只剩两个读者：loop 的运行状态（回答能否续跑）和历史查询（填给模型的表），它们回答的是不同的问题。把 `HistoryQuery.ts` 的 `callWrites` 提成共享函数只会有一个调用方，按 AGENTS.md 的规则（single-caller extractions are banned）不做。

### 3.3 规则三：会增减的名字存成开放字符串

`StoredProtocolSchema` 已经这样做了（#14476）：协议是字符串，执行边界判断支不支持。还没做的是：

- `run.config` 的 `binding.backend`（`shared/schemas/runInput.ts:51-54, 94-97`）仍是 `MODEL_PROVIDERS` 的封闭枚举，所以移除 OpenRouter 和 Copilot 各升了一次 `run.config`。
- `request.opened` 重试载荷里的 API key provider 同理（v3）。

改成字符串后，移除一个 provider 时旧行照常可读，持有它的 run 在绑定时被拒绝续跑并说明原因。这正是 PRD 的要求：“旧调用是什么，就一直保存成什么；新代码能否继续它，另行判断。”

模型失败按值存在四种行里。v16 之后它是 verdict，措辞归读者，形状已经比之前稳定；本提案不动它，只记录：下一次改它仍然会升四种行。

### 3.4 可以清除的过时设计

| #   | 过时的设计                                                                                       | 证据                                                                                                                                                                                                                                                                                                                                                                                                             | 清除的代价                                           |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | 有运行历史的 run 上的卡片行                                                                      | §3.1                                                                                                                                                                                                                                                                                                                                                                                                             | 格式：`tool.intent`、`tool.result` 升版              |
| 2   | 每行的 `origin` 列、`OwnerId`、`ProcessIdentity`、`platform/defaults/nodeProcesses.ts`（215 行） | 只在 `databaseLayer.ts:629, 664` 写入；全仓库没有读取方。它是 claim 时代的存活证明留下的，claim 已被 #14769 删除。为了盖这个戳，每个进程在建 process layer 时要读一次 `/proc`（Linux）或起一次 `ps` / PowerShell（`controllers/session/sessionLayer.ts:362-367`）                                                                                                                                                | 格式：DDL 少一列；NDJSON 和 trace 的载荷少一个字段   |
| 3   | `run.position` 的 `family`                                                                       | 只有一个值 `'toolUse'`（`shared/schemas/runHistoryEvent.ts:36`），唯一的写入是常量（`agent/runtime/loop/rows.ts:79`），唯一的读取是判空（`sessionViewUpdate.ts:749`）                                                                                                                                                                                                                                            | 格式：`run.position` 升版                            |
| 4   | 按 `at` 相等推断批次边界                                                                         | 随第 1 项消失                                                                                                                                                                                                                                                                                                                                                                                                    | 无                                                   |
| 5   | `usage` 展示行的两处推导                                                                         | `projections.ts:291-307` 和 `:334-370`                                                                                                                                                                                                                                                                                                                                                                           | 无格式变化                                           |
| 6   | 行里的封闭 backend 枚举                                                                          | §3.3                                                                                                                                                                                                                                                                                                                                                                                                             | 格式：`run.config`、`request.opened` 升版            |
| 7   | 提到 claim 的注释和三份已过时的 implemented 说明                                                 | 注释：`sessionEvent.ts:81, 329-330`、`identifiers.ts:28`、`database.ts:149`、`currentValues.ts:5`、`nodeProcesses.ts:19-21`、`runProgram.ts:74`、`Inbox.ts:110`、`ToolUseFollowUp.ts:39`、`sessionPrograms.ts:206`、`sessionReads.ts:6`、`toolUseDispatch.ts:618`。说明：single-owner liveness §2 和 §3、storage v1 §8 和 Q6、core concepts 的 Claim 和不变量 1，都还在描述 `owner_id`、claim 和多进程共享一个库 | 无格式变化                                           |
| 8   | 冻结时归零：行版本号、17 个退役行种类、1 个退役插件事实、`.pre1` 移走路径                        | 按 AGENTS.md，1.0 的格式还没有发布，`config/storage/frozen/` 也不存在；需要负责人确认没有已发布的构建写过这些版本                                                                                                                                                                                                                                                                                                | 需要负责人决定：现有的开发库在归零时会被整体拒绝一次 |

第 1、2、3、6 项都是格式变更。按 PRD 推进顺序的规则（不可逆的先做，存储格式在冻结前一次做完），它们应当进同一个格式批，共用一次 golden 重生成。

已在别处记录、这里不重复的：全局库打开完整的事件库、`StoreMode` 的四个值、独占库上的 `retryBusy`、闭包参数包（store review F5）、没有前进步骤（F4）。当前值的 family 版本（F1）不在此列：PRD 已决定不引入 family 版本框架。

## 4. 放弃什么

- 如果选推荐的做法，快工具的卡片会比现在早出现，NDJSON 上它的 `tool.start` 也更早。
- NDJSON 和 trace 的行载荷里不再有 `origin`。没有找到依赖它的读者，但它是对外输出的一部分，要随契约版本说明。
- 冷读有运行历史的 run 的转录时，要解码 `tool.intent` 和 `tool.result` 两种行。今天已经解码 `tool.result`；多出来的是 intent，它是小行。
- 行的 `seq` 变稀疏的程度会变（卡片不再占序号）。没有找到依赖序号连续的读者。

不放弃的：一个发布者、`RunCell.append` 是运行历史的唯一写入方、没有快照、恢复和实时是同一个归约函数、事件词汇、视图契约、历史查询的四张表。

## 5. 顺序

1. **格式批（冻结前，一次重生成 golden）。** §3.4 的第 1、2、3、6 项。它们互不依赖，但共用一次重生成。
2. **`displayOf`。** 把 `displayRows`、`usageRows` 和投影里的 `usage` 推导并成一处。没有格式变化，可以先于第 1 步落地，为卡片铺路。
3. **记录归约函数（§3.2）。** 没有格式变化，不受冻结约束。
4. **注释和说明（第 7 项）。** 任何时候。
5. **冻结时归零（第 8 项）。** 只在冻结那一刻有意义，由负责人决定。

## 6. 验收标准

- `cardRows`、`settleCards`、`cardResult`、`DISPLAY_PAGE_END` 在 `packages/harness/src` 里搜不到。
- golden 库里有运行历史的 run 没有 `tool.start` 和 `tool.end` 行；它的转录和 NDJSON 仍然有这两种事件。
- “activation 清除 end 和 stop”只有一个实现：按 `'run.activate'` 搜索，处理它的归约只剩 `runRows.ts` 和 `runState.ts`。
- `platform/defaults/nodeProcesses.ts` 不存在；打开会话不再起 `ps` 或 PowerShell。
- PRD 的三项日常变更检查：新增一个普通插件工具不改核心存储版本；移除一个 backend 不升任何行版本。
- 按测试规则，这些片不加新的单元测试；格式变更由 golden 和崩溃一致性回放覆盖。

## 7. 风险和没有验证的部分

- 没有做原型，也没有量过冷读的开销。第 2 步落地时应当量一次长 run 的转录读取。
- 没有逐一核对 §3.1“后续候选”里的三种展示行；它们列在那里是因为证据指向重复，不是因为已经确认可以删。
- 快慢工具的展示时机是产品行为，需要 UI 负责人定。
- 视图的归约在浏览器里运行，§3.2 的纯函数不能引入非浏览器安全的依赖。
- `origin` 是否有仓库外的读者（用户脚本读 NDJSON）无法从仓库里确认。

## Verified

在 `main` 的 `db09959` 上核对，全部是读代码和 `grep`，没有运行测试：

- 37 种行、26 种展示行、11 种私有行：`shared/schemas/sessionEvent.ts` 的三个 union 和 `shared/schemas/rowVersions.ts` 的 `ROW_KINDS`。
- 一次工具调用写的行：`agent/runtime/loop/toolUseDispatch.ts` 的 `commit`、`cardRows`、`bodyStarts` 和结果提交。
- `tool.end` 和 `usage` 在两类 run 上的不同含义：`shared/schemas/traceEvent.ts:65-85`。
- 转录按 `seq` 去重：`shared/session/sessionViewUpdate.ts:1011-1012`；`tool.end` 找不到卡片时被忽略：`shared/session/transcriptUpdate.ts:200-203`。
- `origin` 没有读取方：在 `packages/*/src` 里搜索行信封的 `.origin`，命中的都是别的字段（模型的 origin、转录行的 `origin === 'local'`）；`OwnerId`、`ProcessIdentity`、`processStartIdentity` 的全部使用点都在写入路径上。
- `family` 的读写点：`rows.ts:79`、`runRows.ts:108`、`sessionViewUpdate.ts:749`。
- 版本升级次数：逐条读 `rowVersions.ts` 的注释后计数。
- activation 规则的四个实现：按 `'run.activate'` 搜索后逐个读。
- 行种类在 harness 之外只在五个文件里被点名，都是展示事件，没有私有行：`packages/trace-viewer/src/traceFrames.ts`（`run.start`、`run.position`）、`packages/cli/src/runtime/headless/executeCli.ts:243`（`request.decided`）、`sessionProgressSubscription.ts:127` 和 `taskAttach.ts:69`（过滤 debug 级的 `log`）、`packages/texra/src/tools/agentCli/agentCliShared.ts:259`（外部 agent 发出 `usage`）。
- 已定案的决定：PRD“最小存储契约”和“实现前需要收敛的选择”、storage v1 §5、§10 和 §13、one run model §2 和 §3、`refuted-candidates.json`（`STORE-context-blob-as-brought-blob`、`RUN-one-skip-signal`、`ROW-followup-closed-as-run-removed` 等与本提案不冲突）。
