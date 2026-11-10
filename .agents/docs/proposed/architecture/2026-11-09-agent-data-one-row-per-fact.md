---
created: 2026-11-09
status: proposed
---

# Agent 数据：一个事实只存一行，展示由推导产生

这是一份评审后的设计提案，基线是 `main` 的 `db09959`。范围是一次运行（run）的数据怎么存、怎么读，不含设置和其他当前值。

**进度。** 提案里的格式批已在同一分支落地（§5 的第 1、2 步）。规则二（§3.2）第一次算账时被否决，换成“单一事实来源”的问法之后找到了更小的做法，已落地。三份 implemented 说明里点名的过时段落已改。冻结时归零还没有做，要等负责人决定。正文各节写明哪些已经是现状、哪些仍是提议。实现时有两处和最初的提案不同，见 §3.1 的“和最初提案的两处不同”。

与已定案规则的关系：

- 按 [one fact, one representation](./2026-11-03-one-fact-one-representation.md) 的规则写：先按含义给事实命名并列出它的每一种表示，同一个 PR 里只留一种，保留一个事实之前先看同类项目存了什么。
- 沿用 [one run model](../../implemented/architecture/2026-09-10-one-run-model.md) 的 R1：一个事实只写成一种行，派生值只有一个归约函数。
- 不改 [Harness 1.0 PRD](./2026-10-28-harness-1-release-prd.md)“最小存储契约”的任何一条：沿用已记录的事实，不建第二套日志，保留存储词汇和原调用含义。
- 和两处已定案的说法不同，都在正文里说明理由：[storage v1](../../implemented/architecture/2026-09-28-storage-v1-design.md) §10 的“卡片仍由 loop 写入”（§3.1），以及 one fact, one representation §G 落地时“存储的 provider 枚举由存储自己拥有并保持封闭”（§3.3）。负责人选择了更激进的做法，两处都已按本提案落地。
- 随格式批改写的规范：`packages/harness/docs/spec.md` 的 §2.3、§3.1、§3.3 和 §4 的 W3、W4，`packages/harness/AGENTS.md` 的 “Event channels and cards”，以及对外指南 `docs/api/durable-protocol.md` 的写入点表。

## 结论

**设计问题只有一个：行是按“谁读”分的（展示行和私有行），不是按“什么事实”分的。** 两边都需要的事实因此存成两行，再在读取时对齐；基线上一次工具调用写 4 行，其中 2 行是为展示另写的。

推荐的是两条规则，都不引入新的行词汇：

1. **展示行只在没有执行行持有这个事实时才存。** 其余展示事件由一个函数从已提交的行推导，实时路径和冷读共用它。第一片是工具卡片，**已落地**。
2. **一个主题一个归约函数，一份索引。** “一个 run 的记录行说明了什么”只写一遍，由 store 的记录读取、视图和窄读取共用；store 不再另存一份记录。**已落地**，做法和最初的提议不同（§3.2）。

行里封闭的 provider 枚举（§3.3）：存下来的 backend 已改成按字符串读，**已落地**；重试载荷里的 API key provider 仍然封闭。

不推荐的两种设计：把行统一成“开/关”成对的 op 行（只是改名，且和 PRD 的决定冲突）；用可变的状态表当真相（和“历史是唯一真相”冲突）。对比见 §2。

可以清除的过时设计见 §3.4，其中四项已清除。复读代码时还发现一个和本提案无关的缺陷，已在同一分支修复，见 §8。

## 1. 设计问题

本节描述基线（`db09959`）上的状态。表里标了“已解决”的行，现状见 §3。

### 1.1 行按读者分，同一事实因此有两行

`packages/harness/src/shared/schemas/sessionEvent.ts` 把 37 种行分成 26 种展示行和 11 种私有行，一行是否到达渲染端由它的类型决定（`isDisplayRow`）。从设计记录的先后看，展示词汇（trace）在前，运行历史是后来加上的执行真相；从那以后，展示行被一种一种地改成投影（`run.model`、`conversation.progress` 已退役，卡片输出和 `usage` 已改成投影，run 和 turn 不再是 stage）。这个过程在基线上停在了一半。按事实列出基线上的每一种表示：

| 事实               | 执行行                                    | 展示行                                                                | 基线上怎么对齐                                                                        | 现状           |
| ------------------ | ----------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------- |
| 工具调用开始       | `tool.intent`（callId、attempt）          | `tool.start`（logId、toolName、实际执行的 input、card、section）      | 同一批提交：慢工具在 intent 那批，快工具在 result 那批（`cardRows`）                  | 已解决（§3.1） |
| 工具调用结束       | `tool.result`                             | `tool.end`（logId、status、files）                                    | 读时把同批的 `tool.result` 填进 `tool.end`（`settleCards`）；分页因此必须停在批次边界 | 已解决（§3.1） |
| 一次计费的模型回合 | `model.message` response 的 `usage`       | `usage`                                                               | 已是投影（`projected_row`）：这一项只有一种存储表示                                   | 基线上已解决   |
| 模型输出的文本     | response 的 `turn.content`                | `stream.end.finalText`（正文和思考各一条）、`response.finalized.text` | 不对齐，各存一份（`agent/runtime/ModelInvoker.ts`）                                   | 未动           |
| 用户输入           | `followup.queued`、`model.message` append | `log`（`userMessage`）                                                | 不对齐，各存一份（`agent/trace/traceLogs.ts`）                                        | 未动           |
| 模型失败           | `model.message` failed 的 `error`         | `log`（error）、`run.end.error`、`request.opened` 的重试载荷          | 按值复制到四种行                                                                      | 未动           |

基线上的三处旁证：

- 代码自己的注释这样描述（`shared/schemas/traceEvent.ts`）：有运行历史的 run，`tool.end` 不存输出、`usage` 不存行；没有运行历史的 run（agent-CLI 子运行）两者都存。同一种行有两种含义，读取方要先知道这个 run 属于哪一类。
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

其中一部分已经修掉：协议改成开放字符串之后（`StoredProtocolSchema`，#14476），移除 provider 不再升 `model.message` 和 `context.edit`；本分支之后也不再升 `run.config`（§3.3）。`request.opened` 重试载荷里的 provider 枚举仍然封闭。

### 1.3 同一条记录规则写了几遍

“一次 activation 会清掉上一次的 end 和 stop”这条规则有四个实现：

- `controllers/session/projections.ts` 的 `RECORD_STEPS`（store 的 `run_record` 投影）
- `shared/session/sessionViewUpdate.ts`（视图）
- `shared/session/runRowReads.ts` 的 `lifecycleOf`（input 读取）
- `shared/session/runRowReads.ts` 的 `turnReceipt`（回执）

“detach 切断父边”有三个实现，“用户起的标题不被模型标题覆盖”有两个。T5（#14854）已经把 store 里的两份收成 `run_record` 一份，它点名的第三份（视图）和窄读取在基线上还在。现在这三条规则各只有一个实现，见 §3.2。

### 1.4 用《软件设计的哲学》的词说

- **重复，两种表示。** 卡片行和调用行；四处 activation 规则。
- **信息泄漏。** “这个 run 有没有运行历史”泄漏到了 `tool.end`、`usage`、`settleCards`、`displayRows` 和转录的归约里。
- **特例和通用混在一起。** 快工具和慢工具的卡片在不同的批次打开；这是展示时机的特例，却写在提交路径、规范的 MUST 和工具的公开选项（`slow`）里。
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

### 3.1 规则一：展示行只在没有执行行持有这个事实时才存（工具卡片已落地）

**机制。** 展示流的定义是一个函数：输入一条已提交的行，输出它显示成什么。展示种类的行原样返回；调用行返回它的卡片事件；其余返回空。实现是 `controllers/session/rowReader.ts` 的 `callCard` 和 `controllers/session/databaseLayer.ts` 的 `shown`。发布者用它从内存里的已提交行算出实时批次（`Database.displayRows`），冷读（`readDisplay`、`readDisplayAggregate`、`readInputBatch`）读出展示种类的行和 `tool.intent`、`tool.result`，解码后逐行映射，所以实时和冷读不会不一致。`projected_row` 留给来源行很重的种类当缓存（现在只有 `usage`）。

事件词汇不变，事件的配对也不变。渲染端、NDJSON、SDK 事件流和 trace 导出看到的仍是成对的 `tool.start`、`tool.end`；变的是这些事件在有运行历史的 run 上不再是存下来的行。

**一条硬约束：一条存储行最多产生一条转录事件。** 视图的转录按 `seq` 去重（`shared/session/sessionViewUpdate.ts` 的 `applyTranscriptRow`），共用一个 `seq` 的第二条转录事件会被丢掉。`Run.events` 背后的 `replayTrace` 原来也只按 `seq` 去重，并且已经因此丢过事件，见 §8。

**工具卡片现在怎么存。**

- `tool.intent`（v2）带上卡片打开时要显示的字段：logId、toolName、调用体实际执行的 input（经过钩子改写之后的）、工具声明的 card、脚本的 section；脚本调用的 `stageId` 在行的顶层。`callCard` 把它映射成 `tool.start`。调用体实际执行的 input 原来只有 `tool.start` 直接记着；现在它在执行意图那一行上，和 PRD 的许可契约（先持久化执行意图、再执行同一个操作）以及 pi-durable 的做法一致。
- `tool.result`（v5）带上它关闭的卡片的 logId；不显示卡片的调用（重复调用、脚本的宿主函数、从没开始过就被报告而不执行的调用）是 null。`callCard` 把它映射成 `tool.end`：状态来自结果的 status，输出来自同一行，编辑过的文件来自同一行的 `result.edits`。
- loop 不再在调用行旁边写卡片行。每次已执行的工具调用从 4 行变成 2 行。
- 没有运行历史的 run（外部 agent 自己报告的调用，`AgentTrace.openToolCard`）仍然存 `tool.start` 和 `tool.end`。

**和最初提案的两处不同。**

1. **调用体没开始就结束的调用，仍然是一对事件。** 被守卫或钩子拒绝的调用，以及 run 里没有这个工具的调用，没有 intent。最初的提案让它的 `tool.result` 带上 toolName 和 input，推导出一条自足的 `tool.end`，代价是对外契约改变：按开始和结束配对的读者要多处理一种形状，按 `tool.start` 统计调用的读者会漏掉这些调用。实现时改成：loop 在结果那一批里、结果之前存一条 `tool.start` 行（`toolUseDispatch.ts` 的 `opening`），`tool.result` 照常推导出 `tool.end`。每个存储行仍然只产生一条事件，事件契约完全不变；这个事实也仍然只有一种表示（调用体开始过的在 intent 上，没开始过的在这一条 `tool.start` 上）。规范里因此留下一条同批提交的 MUST，只管这一种情形。
2. **`slow` 这个工具选项删掉了。** 提案只说“快慢这个展示特例从提交路径和规范里消失”。落地后每张卡片都在调用体开始时打开，`slow` 只剩下“是否把工具打印的内容流到卡片上”一个用途，而会打印的四个工具本来都声明了 `slow`。所以流式输出改成对所有调用体已开始的调用生效，`ITool.slow` 和 `defineTool` 的 `slow` 选项连同九处声明一起删除。SDK 的示例（`packages/harness/example/acceptance.ts`）原来要声明 `slow: true` 才能在调用开始时看到卡片，现在不用。

**由此删掉的。**

- `cardRows` 和它三处调用点上的开/关参数，`rows.ts` 里只为卡片存在的 `displayRow`。
- `settleCards`、`cardResult`：推导只看一行，不再需要在同一批里找相邻的行。
- 按 `at` 相等推断批次边界的分页逻辑。每条展示事件只来自一行，分页可以停在任意一行；`DISPLAY_PAGE_END` 现在只是“往后数 2000 行”。store review 的 F3 原本的修法是加一个 `batch` 列；这里是让“批次身份”不再被需要，`at` 也回到规范说的“只是信息性的”。
- 规范里 W3 的慢工具卡片条款和 W4 里按慢、快、未开始、结果未知分别列出的卡片规则。
- `ITool.slow`（上面第 2 点）。

**和 storage v1 §10 的关系。** §10 原来决定输出只存一次、卡片仍由 loop 写入，给出的理由是没有工具侧的卡片、没有第二条追加路径。这两条理由仍然成立，而且更强：卡片不是 loop 另外写的一行，而是 loop 的调用行本身。§10 拒绝的方案（两份都留、展示侧截断）也仍然被拒绝。§10 的正文已按现状改写。

**其余展示行：核对过，这条规则现在套不上。** 落地卡片之后逐个读了代码。三类重复都还在，但都不是“一行对一条事件”的关系，而硬约束（一条存储行最多一条转录事件）正好卡在这里：

| 展示行                                   | 持有同一事实的行                                              | 为什么现在不能由它推导                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream.end.finalText`（模型正文和思考） | `model.message` response 的 `turn.content`                    | 一次响应关两条流（思考和正文），两个 `finalText` 都是从这一行的 `turn` 算出来的（`agent/runtime/ModelInvoker.ts`）。由响应行推导就是一行产生两条转录事件；而且两条流各自的 `stream.start` 是在响应行存在之前写的，流的 id 那时就定了                                      |
| `log`（`userMessage`）                   | `followup.queued` 的正文，`model.message` append 的模型侧消息 | 一批 follow-up 合成一条 append，却各显示一行用户消息（`agent/runtime/FollowUps.ts` 的 `logFollowUps`）。显示的是 `displayText`、脚本摘要和按当时模型能力算出的附件种类，不是发给模型的文本；run 的第一条指令根本没有 follow-up 行（`executeAgent.ts`、`loop/runLoop.ts`） |
| `log`（模型失败）                        | `model.message` failed 的 `error`                             | 其余三份各在一条必须自足的行上：列表只送每个 run 最新的 `run.end` 和还开着的 `request.opened`，它们不能依赖另一行                                                                                                                                                         |
| `response.finalized`                     | 没有                                                          | 它自己是一个事实：替换规则清理之后的最终文本，运行状态也读它                                                                                                                                                                                                              |
| `context.state`                          | 没有                                                          | 小，而且列表需要                                                                                                                                                                                                                                                          |
| 其余 `log`、`stage.*`、`process.output`  | 没有                                                          | 没有别的行持有                                                                                                                                                                                                                                                            |

前两行卡在硬约束上，但硬约束不是决定性的理由，读取成本才是。响应行是库里最重的几种行之一（整个回合的内容，加上签名和加密的推理）。如果转录的文本改成读取时从它推导，每次冷读转录都要解码全部 `model.message` 行；SQL 不读载荷（只有行编解码器认识存储形状），所以连“只选 response 那一种”都做不到。要避开这个成本只能把推导结果缓存进 `projected_row`，那就又把文本存了一份。所以 `stream.end.finalText` 留着：它是响应文本在写入时由生产者算好的展示副本，按“单一事实来源”说，真相仍然只有响应行一处，这一份和投影一样可以从它重算，只是由 loop 写而不是由 store 的投影器写。用量走的是另一条路（`projected_row` 缓存），原因相同：来源行太重。

### 3.2 规则二：一个主题一个归约函数，一份索引（已落地）

**最初的提议和它为什么先被否决。** 最初的提议是把 `controllers/session/projections.ts` 的 `RECORD_STEPS` 搬进 `shared/session/`，让它对“每个槽里放什么”通用（投影放 commit，视图和读取放行本身）。动手前按代码估算：投影从不持有行，它从上一次存下来的 commit 记录往前走一步，所以共享函数必须对槽通用，再从“行的记录”推出 `RunRows` 还要每个槽的行类型。新增约 120 行和两个泛型类型，删掉约 85 行，净增加。当时的结论是不做。

**换一个问法：这份记录的唯一来源是什么。** 按“单一事实来源”重新看，问题不在归约函数，而在 store 把同一份索引存了两次：

- `listing_entry` 按 `(aggregate, listing key)` 存每种行最新一条的 commit，记录要读的 14 种行都在里面（每个插件事实、每种标题作者各一个 key）。
- `run_record` 按槽存同样这些行的 commit，只是在写入时多套了一条规则（activation 清掉 end、stop 和输入关闭）。

而这条规则不需要在写入时套：把“每种行最新的一条”按 commit 顺序过一遍归约函数，结果和过一遍全部行相同（每个字段只取某一种行的最新值，能把它清掉的只有 activation，谁的 commit 更大谁赢）。所以记录根本不用存。

**现在的做法。**

- `shared/session/runRowReads.ts` 的 `recordAfter(record, row)` 是记录规则唯一的陈述：状态就是 `RunRows`，每个字段带着自己的行类型，没有泛型，也没有类型转换。
- store 删掉了 `run_record` 表和它的投影器。`readRunRecord` 从 `listing_entry` 读出这个 run 每种记录行最新的一条（`READ_RUN_RECORD`），严格解码后用 `recordAfter` 折叠。
- input 读取原来的 `lifecycleOf` 删除，改成对它选出的行用同一个函数；回执的 `turnReceipt` 在顺序扫描里逐行用它，不再自己记 end 和 stop。
- 视图给每个 run 保留一份记录（`SessionState.records`），标题、挂接的父 run、end 留下的输出和丢失的结果都从记录里读，不再自己写“用户标题优先”“detach 切断父边”“activation 清掉 end”。
- 原来由 `run_record` 的 `unread` 保证的一点保留了下来：投影重建时解码不了的记录行，登记成这个 run 的 `unread` 列表项（每个 run 只记第一条），记录读取和冷列表都会选到它，所以读取会在这一行上失败，而不是缺了它照常回答。`listing` 投影因此升到 v2。

**结果。** “activation 清掉 end 和 stop”“detach 切断父边”“用户标题优先”各只剩一个实现。源码 9 个文件，加 216 行、删 320 行；store 少一张表、一个投影器和一份索引。没有格式变更（投影表不在行格式里），已有的库在下次打开时重建列表投影。先前记进 `refuted-candidates.json` 的 `ROW-record-rules-one-reducer` 已删除：被否决的是“对槽通用的归约函数”，落地的做法里没有存下来的 commit 记录，那个代价不存在了。

**没有做的一步。** 冷视图现在可以直接从记录读取初始化；`listing` 投影里只为视图存在的部分因此可以再收窄。没有核对，不属于这一片。

**不做的一件事。** 不为“调用”另建共享的读模型。卡片改成由行自己推导之后，调用行只有三个读者：loop 的运行状态（回答能否续跑）、历史查询（填给模型的表）和 `callCard`（显示成卡片），它们回答的是不同的问题。把 `HistoryQuery.ts` 的 `callWrites` 提成共享函数只会有一个调用方，按 AGENTS.md 的规则（single-caller extractions are banned）不做。

### 3.3 行里的封闭 provider 枚举（backend 已落地）

- **基线。** `run.config` 的 `binding.backend` 和 `request.opened` 重试载荷里的 API key provider 是封闭枚举。移除 OpenRouter 和 Copilot 各升了一次 `run.config`，前者还升了一次 `request.opened`。
- **既有决定。** one fact, one representation §G 落地时写明：存储的枚举（`ModelBackendSchema`、`ApiKeyProviderIdSchema`）由存储自己拥有并保持封闭，用编译期检查和 llm 的目录对齐；理由是 harness 以 caret 范围依赖 llm，目录在新版 llm 里变长时，不能在没有 harness 发布的情况下把存储的联合类型变宽。
- **冲突在哪。** 这个理由保护的是“变长”。它的代价落在“变短”上：PRD 的日常变更检查之一是“更换或移除执行 backend……不为此更新多个历史事件版本”。
- **已落地的做法，两头都顾。** 写入方的类型保持封闭（harness 自己的列表，编译期检查不变），所以新版 llm 仍然不能让 harness 写出列表之外的值。读取方把已存的 `binding.backend` 当字符串读（`shared/schemas/runInput.ts` 的 `RunBindingSchema`）；不认识的 backend 在下一次绑定时被按名字拒绝（`agent/runtime/modelAccess/routeDecision.ts` 的 `decideRoute`）。所以移除一个 provider 不再升 `run.config`：绑定在它上面的 run 仍然可读，只是不能在这个构建上续跑。先例是缺插件的事实读作 `unavailable`（#14586）和 `StoredProtocolSchema`（#14476）。这正是 PRD 的要求：“旧调用是什么，就一直保存成什么；新代码能否继续它，另行判断。”回归测试在 `packages/harness/test/controllers/session/rowCodec.vitest.ts`。
- **没有动的一半。** `request.opened` 重试载荷里的 `ApiKeyProviderIdSchema` 仍然封闭。它描述的是一个待回答的请求向用户提供哪把 key，读者（各端的重试卡片）按枚举值取文案；按字符串读要给每个读者加“不认识的 provider”分支。请求是短命的，移除 provider 时还开着的重试请求很少，这里维持既有决定。

模型失败按值存在四种行里。v16 之后它是 verdict，措辞归读者，形状已经比之前稳定；本提案不动它，只记录：下一次改它仍然会升四种行。

### 3.4 可以清除的过时设计

| #   | 过时的设计                                                                             | 状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 有运行历史的 run 上的卡片行                                                            | **已清除**（§3.1）。`tool.intent` 升到 v2，`tool.result` 升到 v5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2   | 每行的 `origin` 列、`OwnerId`、`ProcessIdentity`、`platform/defaults/nodeProcesses.ts` | **已清除**，选的是整个删掉。它原本供 claim 的存活证明使用；ownership 那一片删掉了 claim，盖戳这一半留了下来，代码里没有读取方，却让每个进程在建 process layer 时读一次 `/proc` 或起一次 `ps` / PowerShell。DDL 少一列，schema 版本升到 104；NDJSON 和 trace 的行载荷里不再有 `origin`；规范和指南各改了一处                                                                                                                                                                                                                                                                                                                     |
| 3   | `run.position` 的 `family`                                                             | **已清除**。只有一个值 `'toolUse'`，唯一的写入是常量。读取方有两个，不是最初写的一个：视图的判空，以及 trace viewer 的位置标签（`packages/trace-viewer/src/main.ts`），后者现在不再显示它。`run.position` 升到 v5                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4   | 按 `at` 相等推断批次边界                                                               | **已清除**，随第 1 项消失                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 5   | 三份已过时的 implemented 说明                                                          | **已改掉点名的段落。** single-owner liveness §2 和 §3、core concepts 的 History、Call、Claim 和不变量 1、storage v1 的分层表、DDL、§8、§9、§10 和 Q1、Q6：关于 `owner_id`、claim、`origin`、多进程共享一个项目库和 loop 另写卡片行的说法都按现在的代码改了。**storage v1 的其余描述仍然过时**（基线版本号、已退役的 `run.model` 投影、打开顺序里按共享库写的细节）。按“一个主题一个归属”处理：`.agents/docs/INDEX.md` 现在把“store 和持久协议的现状”归给规范（`packages/harness/docs/spec.md`，它有检查保证），storage v1 只归属 1.0 的决定和理由，并在开头写明两者不一致时以规范为准。要不要把它删到只剩决定和理由，由负责人定 |
| 6   | 冻结时归零：行版本号、17 个退役行种类、1 个退役插件事实                                | **未做，需要负责人决定。** 按 AGENTS.md，1.0 的格式还没有发布，`config/storage/frozen/` 也不存在；需要确认没有已发布的构建写过这些版本。现有的开发库在归零时会被整体拒绝一次                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

第 1 到 4 项是格式变更，按 PRD 推进顺序的规则（不可逆的先做，存储格式在冻结前一次做完）放在同一个格式批里，每一片各重生成一次 golden。

已在别处记录、这里不重复的：全局库打开完整的事件库、`StoreMode` 的四个值、独占库上的 `retryBusy`、闭包参数包（store review F5）、没有前进步骤（F4）。不在此列的两项：当前值的 family 版本（PRD 已决定不引入 family 版本框架）；pre-1.0 的库整体移到 `.pre1`（storage v1 的 Q3 已决定）。

### 3.5 每个事实的唯一来源和归属

落地之后，一次运行的数据按“事实、唯一来源、谁写、怎么读”列出来是这样。“怎么读”那一列里的东西都是从来源算出来的，可以丢掉重建。

| 事实                         | 唯一来源（行）                                                                                | 谁写                                                   | 怎么读                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| run 的存在和父边             | `run.start`；`run.detach` 切断挂接的父 run                                                    | 启动方；store 盖上父 run 的 `uid`                      | `recordAfter` 的 `parent`；`event_sequence.parent_id` 是另一个事实（回收时用的启动父边）              |
| 生命周期和输入是否关闭       | `run.activate`、`run.stop`、`run.end`、`followup.closed`、`run.removed`                       | `agent/storage/runLifecycle.ts`、`RunHistory.activate` | `recordAfter`：记录读取、input 读取、回执、视图共用的唯一规则                                         |
| 循环位置、请求、待处理的输入 | `run.position`、`request.opened` / `request.decided`、`followup.queued` / `followup.consumed` | loop 的 `RunCell.append`、请求和 `Inbox` 的事务        | `runRows.ts` 的 `applyRunRow`：运行状态和视图共用；位置落到视图上只经过 `standingAfter`               |
| 模型对话（字节精确）         | `model.message`、`context.edit`                                                               | `ModelInvoker`、loop、压缩                             | `applyRunRows`                                                                                        |
| 一次工具调用和它的卡片       | `tool.intent`、`tool.result`；调用体没开始就结束的调用另有一条 `tool.start`                   | loop（`toolUseDispatch.ts`）                           | 运行状态；`callCard`；历史查询                                                                        |
| 用量                         | 计费行上的 `usage`（response、failed、`context.edit`、模型起的标题）                          | 产生这次计费的调用                                     | `usageRows`；`projected_row` 是它的缓存，`run_usage` 是合计                                           |
| 配置和模型绑定               | 最新的 `run.config`                                                                           | loop 首次绑定和切换模型时                              | `recordAfter` 的 `config`；运行状态                                                                   |
| 标题                         | `run.description`，用户起的优先                                                               | 标题助手、用户改名                                     | `recordAfter` 的 `title`                                                                              |
| 授权                         | 最新的 `approval.policy`，否则 `run.start` 带的快照                                           | `Approvals.change` / `decideUnder`                     | `recordAfter` 的 `grants`；视图的 `policy`                                                            |
| 插件事实                     | 每种最新的 `plugin.fact`                                                                      | 工具结果的 `facts`、请求决定的钩子                     | `recordAfter` 的 `facts`；由插件自己的读取器解释                                                      |
| “每种行最新一条”             | `listing_entry`（投影，唯一的一份）                                                           | store 的 listing 投影器，在追加的事务里                | 冷列表；记录读取                                                                                      |
| 模型输出的文本               | `model.message` response 的 `turn.content`                                                    | `ModelInvoker`                                         | 运行状态。转录读的是写入时算好的展示副本（`stream.end.finalText`、`response.finalized`），理由见 §3.1 |

仍然各存一份、没有收掉的重复只有 §3.1 表里的三类展示行，每一类都写了原因。

## 4. 放弃了什么

- 快工具的卡片比以前早出现：调用体开始时就打开，NDJSON 上它的 `tool.start` 也更早。转录里卡片排在它的调用体写出的日志前面，脚本的 stage 排在它第一个调用的小节前面。已记入 CHANGELOG。
- 调用体需要自己请求审批的快工具（例如文件编辑的审阅），卡片现在在审批请求之前打开，审批期间显示为进行中。慢工具原来就是这样。
- NDJSON 和 trace 的行载荷里不再有 `origin`。仓库里没有依赖它的读者。
- 冷读有运行历史的 run 的转录时，要解码 `tool.intent` 和 `tool.result` 两种行。以前已经解码 `tool.result`；多出来的是 intent，它带着调用的 input，大字符串按地址存在 blob 里。
- 行更少了，`seq` 的取值随之变化。没有找到依赖具体序号的读者；golden 测试里一个写死的提交序号随重生成更新。
- 这个构建之前写的 run 都读作“更早的构建写的”，只读、不能续跑。1.0 的格式还没有发布，这是既定规则。

没有放弃的：一个发布者、`RunCell.append` 是运行历史的唯一写入方、没有快照、恢复和实时是同一个归约函数、事件词汇和事件的配对、视图契约、历史查询的四张表。

## 5. 顺序

1. **修 §8 的缺陷。** 已完成。
2. **格式批。** 已完成：§3.4 的第 1 到 4 项和 §3.3 的 backend。
3. **记录归约函数和单一索引（§3.2）。** 已完成，做法见 §3.2。
4. **三份 implemented 说明（第 5 项）。** 点名的段落已改；storage v1 的其余部分仍然过时，见 §3.4。
5. **冻结时归零（第 6 项）。** 只在冻结那一刻有意义，由负责人决定。

## 6. 验收标准

已满足的：

- `cardRows`、`settleCards`、`cardResult` 在 `packages/harness/src` 里搜不到；`DISPLAY_PAGE_END` 里没有 `at`。
- golden 库里有运行历史的 run 没有 `tool.start` 和 `tool.end` 行（806 行变成 749 行，少的 57 行就是这些卡片行）；它们的卡片事件和基线逐条相同，只有出现的先后变了（Verified）。
- 规范 §4 里关于卡片的 MUST 只剩一条：调用体没开始就结束的调用，它的 `tool.start` 和结果同批提交。
- `platform/defaults/nodeProcesses.ts` 不存在；打开会话不再起 `ps` 或 PowerShell。
- 这些片没有加新的单元测试，除了两个先失败后通过的回归测试（§8 的缺陷，§3.3 的 backend）；格式变更由 golden 和崩溃一致性回放覆盖。

- “activation 清除 end 和 stop”只有一个实现：`shared/session/runRowReads.ts` 的 `recordAfter`。按 `'run.activate'` 搜索，其余命中的是另外的事实（`standingAfter` 的位置规则、运行状态的 `activatedAt`、转录的流边界）。
- `run_record` 在 `packages/harness/src` 里搜不到；golden 库里没有这张表。

## 7. 风险和没有验证的部分

- 没有量过冷读的开销。卡片那一片多解码一种小行、少读两种行，预期持平或略好，但没有在长 run 上测过。
- 桌面端的 Playwright E2E 没有在这个环境里跑。卡片出现得更早，如果有截图基线拍到了快工具卡片出现之前的画面，需要刷新。
- 调用体没开始就结束的调用（被拒绝、工具不可用）在 golden 库里没有样本，也没有专门的回归测试；落地时用一个临时测试核对过它的事件和存储行，核对后删除（Verified）。
- `origin` 是否有仓库外的读者（用户脚本读 NDJSON，或人工排查时直接查库）无法从仓库里确认。

## 8. 复读时发现的缺陷和过时陈述

和本提案无关。三项都已在同一分支修掉，各是一个提交：

1. **`Run.events` 丢掉模型标题的 `usage` 事件。** 模型写的 `run.description` 带着它那次请求的计费用量，`displayRows` 为它再投影一条 `usage`，两条共用一个 `seq`（`controllers/session/projections.ts` 的 `usageRows`）。`replayTrace` 原来把一个 `seq` 的第一行读完就当整个 `seq` 已读，所以先到的 `run.description` 占掉了它，后到的 `usage` 被丢掉。影响：只在给根 run 起标题的进程里出现（`processLayer` 提供 `LabelsRootRuns`）；从 `Run.events` 累加 `usage` 的读者会少算这一次请求；视图的总用量不受影响，它按 commit 而不是 `seq` 去重。修法：`replayTrace` 记下最新 `seq` 上已读的行种类（`controllers/session/runTrace.ts` 的 `kinds`）。一个 `seq` 上每种行最多一条（一条事件行，每种投影行一条），所以另一种行会被读到，重复送达的行仍然不会。回归测试在 `packages/harness/test/controllers/session/runTrace.vitest.ts`，修复前失败。
2. **规范里的 schema 版本号过时。** `packages/harness/docs/spec.md` 写的是 102，代码当时是 103。已改；删掉 `origin` 列之后两边都是 104。
3. **`scripts/check-fact-spread.mjs` 的谓词表里还有 `ownedHere`。** 仓库里已经没有这个名字。已从表里和 `packages/harness/AGENTS.md` 的示例里去掉。

另外，golden 测试里“聊天的最后一次模型响应”这个写死的提交序号在 `main` 上就指着响应后面那一行 `run.position`（差一行，测试仍然通过，因为那一行同样会被读作更早的构建或损坏）。随卡片那一片的重生成改成了响应行本身。

## Verified

设计部分在 `main` 的 `db09959` 上读代码和 `grep` 核对。落地的每一片都跑过 `npm run gate`（lint、不变量、文档、typecheck、格式）和 `npm test`，并重生成 golden 库（`corepack pnpm --filter @texra-ai/cli run golden:store`）和 API 报告（`npm run docgen`）。

卡片那一片另外核对了：

- **卡片事件前后一致。** 改动前后各用一个临时测试（核对后删除）读出 golden 库里 18 个 run 的全部 `tool.start`、`tool.end` 和转录。每个 run 的卡片事件按多重集合比较完全相同（工具名、input、状态、输出、文件、stageId、section）；每张卡片的开始都在结束之前；转录的行除了由 `seq` 派生的 id 和时间以外相同。出现先后变了的地方都是快工具的卡片提前到了调用体开始时。
- **没有 intent 的调用和重复调用。** 临时测试跑一次响应里的三个调用：一个 run 里没有的工具、一个编辑文件的工具、一个重复调用。结果：前者是一对事件（`tool.start`，然后是带着 `tool_unavailable` 的失败 `tool.end`）；编辑工具的 `tool.end` 带着去重后的文件；重复调用的结果 `logId` 是 null，没有卡片；实时事件和冷读的事件相同。
- **分页。** 临时测试往一个库里写 4501 行，让一次调用的 intent 落在第一页的最后一行、结果落在第二页的第一行：`readDisplay(0)` 返回 4501 条，提交序号严格递增，卡片的开始和结束各一条。
- **真实 CLI。** `corepack pnpm --filter @texra-ai/cli validate:run`（用真实的二进制跑运行、恢复、服务和 NDJSON 路径）通过。

其余在基线上核对过、现在仍然成立的：

- 37 种行、26 种展示行、11 种私有行：`shared/schemas/sessionEvent.ts` 的三个 union 和 `shared/schemas/rowVersions.ts` 的 `ROW_KINDS`。
- 编辑过的文件可以从已存的结果推出：`SettledToolResultSchema` 保留 `edits`（`shared/schemas/toolResult.ts`），附件清洗不改它（`agent/core/tools/toolAttachmentExtraction.ts`）。
- 读取 `tool.start`、`tool.end` 的地方都在展示事件一侧（转录、视图、`runTrace`、压缩活动投影）；会打印到卡片上的工具只有 `bash`、`script`、`self` 和 `agent`。
- 视图的转录按 `seq` 去重；`tool.end` 找不到卡片时被忽略（`shared/session/transcriptUpdate.ts`）。
- 版本升级次数：逐条读 `rowVersions.ts` 的注释后计数。
- activation 规则在基线上的四个实现：按 `'run.activate'` 搜索后逐个读。落地后的核对见上面的验收标准；记录读取的严格性由 `src/test-kernel/controllers/session/sessionEvents.vitest.ts` 里原有的测试覆盖（损坏的记录行、重建时解码不了的行、损坏的 `run.start`），只把它直接清空的表从 `run_record` 换成了 `listing_entry`。
- 已定案的决定：PRD“最小存储契约”和“实现前需要收敛的选择”；storage v1 §5、§10 和 §13；one run model §2 和 §3；one fact, one representation 的规则、§A 的“Who may run this run”行和 §G 的落地说明；规范 §2.2、§3、§4 和 §7；rulings ledger（没有关于 `origin`、卡片或 `family` 的裁决）；`.agents/docs/refuted-candidates.json`（没有和本提案冲突的条目）。
- 没有核对的：git 历史（这个检出是浅克隆，无法确认各次升版的日期）；`release/0.40` 分支上只核对了 `slow` 选项在那里也存在。
