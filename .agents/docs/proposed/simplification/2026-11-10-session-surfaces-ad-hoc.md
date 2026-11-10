# 会话各层手写机制的审查：已改的、待定的、核实后不做的

Date: 2026-11-10
Status: proposed — 一次审查的记录。大部分候选已在同一分支落地，剩下的写明需要谁决定什么。

范围是 harness 的会话存储和运行数据的各层：SQLite store 内核、发布和读取通道（`SessionEvents`、`SessionLog`、视图的输入）、行的归约函数（运行状态、会话视图、记录），以及 run loop 的调用和输入路径。问的是：哪些机制是手写的，而 Effect v4、SQLite 或现有的形状已经提供；哪些事实被决定了两次。四个只读审查分别覆盖一层，每条候选都先对照 `.agents/docs/refuted-candidates.json` 和已有的审计记录去重，用到的 Effect API 都在 `node_modules/effect`（4.1.2）的类型和源码里核对过；落地前我又逐条对照代码复核了一遍。

## 已落地

基线是 `14c17b6`。这一轮源码 36 个文件，加 365 行、删 560 行（`git diff --stat 14c17b6..HEAD -- packages`）。

| 提交      | 改了什么                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `96ddb00` | 视图和转录各自手写的“首次写入时复制”改用 `ownCopy`；`recordAfter` 的分支和 `RECORD_ROW_TYPES` 由编译器两向对齐；`callCard` 用 `toJsonValue`。                                                                                                                                                                                                                                                                                                                                                           |
| `f9bbc17` | store 删掉自写的事务包装（`TxMode`、自定义 `makeWithTransaction`），改用 SQL 客户端自带的 `withTransaction`。顺带修掉两个缺陷：SQLite 自己回滚之后（磁盘满、I/O 错误）无条件的 ROLLBACK 失败成缺陷，写入失败的原因变成“no transaction is active”；COMMIT 失败成缺陷，和“提交失败是 `DatabaseWriteFailed`”的约定不符。聚合改成绑定一组 `[kind, id]` 对，走唯一索引。全局库的 `data_version` 轮询改成定时 Stream 加 `Stream.changes`。删掉写了常量、从不被读的 `current_value.version` 列（schema 105）。 |
| `d2674a3` | 发布者把 job 的最后一个 commit 随值返回，store 不再包一层 append 去记它；`listing` 从发布者的接口移到 store 的读取，且只过滤一次；视图的 `changes` 用 `Stream.interruptWhen`；被拒的 trace 行不再记两次；修正一处提到不存在的 `SessionEvents.publish` 的注释。                                                                                                                                                                                                                                          |
| `fc38ca7` | 删掉 `RunState.phase`：它是 `at` 的另一份（`PHASE_AT`、`phaseAfter`、`attempt` 的覆盖没有读者能看到），读者直接读 `at`。视图里 run 的位置只在 `applyEvent` 写一次；视图的授权从记录（`recordAfter` 的 `grants`）读，不再自己判断。                                                                                                                                                                                                                                                                      |
| `748ad44` | 缺陷：PostToolUse 的 `duration_ms` 用的是墙钟，系统时间一调就可能为负；改用单调时钟（和 invoker 的修法相同），注释也改成它实际测的区间。                                                                                                                                                                                                                                                                                                                                                                |
| `1e4cd5d` | inbox 的 `sameAsFirst` 走不到（带调用方 id 的发送只有 `submitFollowUp`，它在同一条按 run 的串行通道里先用 `sentBefore` 检查过，库也只有一个进程），连同 `Conflict` 一起删；`admission` 声明了用不到的 `Scope`；`runTurn` 多包了一层；`acquireUseRelease` 包着已经拿到的值，改成 `onExit`；`ConsumeOptions.alongside` 没有调用方；`Effect.fn` 里用 `getUnsafe` 读视图。                                                                                                                                  |

每个提交都跑过 `npm run gate` 和 `npm test`（253 个文件，570 个测试）。

## 待定：需要先做一个决定

1. **`run.steps` 改成 `ScopedRef`。** 它现在是 `SynchronizedRef` 加手写的“开新 scope、换值、关旧 scope”（`agent/runtime/run/AgentRun.ts`、`agent/runtime/loop/step.ts`），正是 `ScopedRef.set` 做的事，`run.model` 已经这样改过（#14781）。要先定三件事：v4 的 `set` 整个在 `uninterruptible` 下跑，acquire 也是，要传 `Effect.interruptible(acquire)`，否则停止要等插件启动完；`set` 不返回值，`warnings`、`listed`、`contributing` 要放进存的值里；旧的一代在换值之前关闭，关闭期间别的读者（比如后台启动的 `offeredBy`）读到的是旧的 step。约 −5 行。
2. **`RunCell.commit` 把一批行归约两次。** 先按临时 commit 归约一次（`agent/runtime/makeRunHistory.ts` 的 `candidates`），发布后按真实 commit 再归约一次，第二次才看见注册行。可以只在 job 里、`runStateAppend` 之后归约一次：失败的 job 回滚，什么都不发布。要定的是：拒绝从此发生在 store 的 job 里面。唯一的 `within` 调用方（`agent/storage/runLifecycle.ts`）已经会在那时让它的事务失败。约 −18 行。
3. **`edgesOf` 的 34 个空分支。** 37 种行里只有 3 种有聚合边；`referencedAggregates` 把这三条边又写了一遍。换成 `default` 加从 `edgesOf` 推出 `referencedAggregates` 约 −38 行，代价是“新加一种行不写边就编译不过”这条检查（一次审计说它好）。单做“推出 `referencedAggregates`”这一半（约 4 行）没有代价。
4. **SQLite 的磁盘满不算 `disk-full`。** 核对事务那一条时看到：`isDiskFullError`（`common/errors/errorPredicates.ts`）只认原因链里的 `code: 'ENOSPC'`，而 `node:sqlite` 报磁盘满是 `errcode` 13（`SQLITE_FULL`）。所以写库时磁盘满，`run.end` 的错误大概率记成 `unexpected`。没有端到端验证；修之前要先用一个写满的库复现。

## 测试设施：golden 生成脚本有一个 race

`packages/cli/scripts/generate-golden-store.mjs` 最后一步 `texra history delete` 删掉一个 run 后马上退出。删除的回收在会话的一个后台 fiber 里，进程退出前有时来得及回收，有时来不及。`f9bbc17` 重新生成时第一次没来得及，第二次来得及。库里聚合的个数因此不同，所有派生的 run id 都跟着变，`goldenStore.vitest.ts` 钉住的 id 就对不上。fixture 已提交，测试本身是确定的；不确定的只是重新生成。脚本的注释说这个 run 应当留在库里（“没有后续打开会回收它”），而 `main` 上的 fixture 一直是被回收的状态。两种修法：让 `history delete` 退出前等它自己的回收（行为变化），或者在脚本里不依赖这一步的时序。

## 核实后不做

| 候选                                                     | 为什么不做                                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 两个重试计划的延迟上限改用 `Schedule.min`                | 只省几行，而组合计划的终止语义要再核对一遍，不值得。                                                                                     |
| 发布者的 inbox 用 `Stream.fromQueue` 消费                | 它用 `Queue.takeAll` 取，已经取走、还没运行的 job 会躲过 `drain` 在关闭期限时的拒绝，它们的等待方会一直等。                              |
| `settling` 改成 `Deferred.into`                          | 它会把中断的 Exit 原样交给等待方，等待方看到的是中断，而不是“在关闭期限被截断”的缺陷。                                                   |
| `stopSessionRuns` 两步用一个 `timeoutOption` 包住        | v4 的 `timeoutOption` 是 `raceFirst`，被比的一方是可中断地 fork 出来的；`RunRegistry.stopAll` 本身不是不可中断的，期限会把停机停到一半。 |
| `reach` 换成 `SubscriptionRef` 的原生等待                | v4 没有“等到满足条件”的函数；`filter` 加 `runHead` 就是原生写法，而且它在源结束时报错而不是挂住。                                        |
| view 读取的 `wake` 和 `batches` 合成一个订阅             | `wake` 走容量为 1 的丢弃缓冲来合并唤醒，数据放进去会丢；先读文本再用不挂起的 `PubSub.takeUpTo` 取批次，是行排在文本块前面的原因。        |
| `values.changes` 用 `Reactivity`                         | 只有调用方的 context 里已经有它，失效通知才会被扣到提交之后，每个事务都要多 provide 一次，净省为零。                                     |
| `stored_kind` 用 `AFTER INSERT` 触发器维护               | 插件事实的版本在 `event.data` 里，而 SQL 不读载荷是有意的约束。                                                                          |
| `rowReader` 的 `scan` 用 `Effect.cached`                 | 会把一次失败的扫描缓存下来，而且它的两张表和 `read` 共用。                                                                               |
| script door 去掉 `FiberMap.makeRuntime`                  | 它真正的作用是携带 `AgentRunServices`，让 `ScriptDoor.call` 不带依赖；去掉就要转发整个捕获的 context，仓库规则禁止。                     |
| `SessionInbox` 的 observers 改成 PubSub                  | 唯一的消费者同步地把解绑 fork 进 FiberSet；PubSub 会在关闭时丢掉还没被取走的事件（`GH-subscriptions-rcmap-pubsub` 的理由之一）。         |
| `Session.records` 的读取器拆掉，调用方直接读 `log.facts` | 它是公开的 `records(runId)` 接口；每个读取器只是取一个字段，拆掉要在二十多处各写一遍，元素数不减。                                       |

已有记录、这里不重复的（各审查报告里逐条列了出处）：`StoreMode` 和闭包参数包（store review F5）、全局库打开整个事件库（storage-errors §1）、`EARLIER_RUNS` 扫描（F9）、script door 的 lane（`DISPATCH-script-lanes-semaphore`）、`sendLanes`（`EFF-ADOPT-per-key-lane-semaphore`）、发布者把行直接交给视图（R1、T1）。
