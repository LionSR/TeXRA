---
created: 2026-11-06
status: proposed
---

# 程序，不是 agent：小内核和 theorist 的程序插件

基线：`main` 的 `d173e42`（2026-11-14）。路径相对仓库根。度量用 `wc -l`
和 `grep`，"现状的度量"一节给出可复核的数字。本文是设计的当前状态，不是
讨论的记录；负责人的裁决集中在"决定记录"，2026-11-14 这次改写相对
11-06 版改了什么列在"修订记录"。

## 摘要

TeXRA 今天只有一种用户可创造的单位：agent 文件。于是审稿视角是 agent，
Wolfram 用法是 agent，一条 `latexdiff` 命令也是 agent。bundled 目录有 35
个文件（加 lean4 插件 5 个），随后长出了一整层让它们"可用"的补偿机制：
team、workspace 级 agent 选择、排序和黑名单、customize 副本和漂移提示、
launch form 的选项表。**数量是症状，单位是病因。** 这个诊断不变：单位应
该是程序（沙箱里的 JS），不是 agent。

11-06 版把程序放进了内核旁边的一组新目录（`.texra/tasks/`、
`~/.texra/tasks/`、插件随包的 `tasks/`），并为它们配了解析器、发现规则、
撞名规则、`author` 标记和一个设置页。负责人 2026-11-14 的方向是另一种切
法：**内核小而美，theorist 的东西是程序插件。** 本文按这个方向重写：

- **程序只有一个家：插件。** 工具今天就只住在插件里；程序也住进去。
  `Plugin` 上的 `scriptModules` 和 `agentBlock` 两个字段换成 `modules` 和
  `programs`，契约不变大。
- **内核只多认识一件事，少认识一类事。** 核心概念的十三个名词里，Agent
  换成 Program，其余十二个都留着。agent 文件、persona、catalog、skill、
  team、task 块、recipe 这些词从内核消失。
- **产品是内核加几个 theorist 插件。** "AI theorist"不是 `assistant.yaml`，
  也不是一个 team：它是开着的那些插件各自带来的程序、工具和一段 prompt。
  聊天是内核的模型循环，没有 agent 文件。
- **用户不从目录里挑。** 让人在三十个 agent 里选是不行的（负责人
  2026-11-14）。默认就是聊天，不选任何东西就能开始；picker 里除了聊天只
  有开着的插件带的十来个程序，新增一个要过棘轮。

这不是一个新方向。仓库里已经有三处"run 是一段程序"：goal 策略是一个脚本
模块（`packages/harness/src/tools/plan/goalScript.ts`），document task 的
recipe 是一段内联 JS（`packages/texra/src/agent/output/documentRecipe.ts`），
后台脚本是 `AgentConfig.script.kind: 'background'`；前两处已经由插件用
`scriptModules` 出货。它们各自特例化了同一个东西，各有一条启动路径。提案
把它们合成"插件的程序，按名启动"这一件事。

## 现状的度量（`d173e42`）

| 事实                                            | 数字                                  | 来源                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bundled agent 文件                              | 35（顶层 33，`write/` 2），3524 行    | `find packages/extension/resources/agents -name '*.yaml'`                                                                                                                  |
| 其中 document task（带 `task:` 块）             | 15，工具全 0，轮数 1 或 2             | `grep -l '^task:'`                                                                                                                                                         |
| 插件随包目录                                    | lean4 987 行，multi-agent 305 行      | `packages/extension/resources/plugins/`：lean4 是 5 个 agent（609 行）加 5 个 skill，multi-agent 是 1 个 skill                                                             |
| bundled skills                                  | 9 个 `SKILL.md`，目录 593 行          | `packages/extension/resources/skills/`                                                                                                                                     |
| team：预设、启动、CLI、标签页、`apply_team`     | 1647 行（8 个文件）                   | `agentTeams.ts`、`agent/teams/`、`teamCatalogPorts.ts`、`packages/cli/src/commands/team.ts`、`cliTeams.ts`、`TeamsTab.ts`、`ApplyTeamTool.ts`                              |
| workspace 选择和 agent 设置页                   | 618 + 890 + 689 行                    | harness `agent/workspaceAgents/` 和它的 schema；设置页前端的 Agents、Skills 标签页和选择面板；后端 `settingsAgentCommands.ts` 和 catalog 控制器                            |
| agent 索引（扫描、customize 副本、插件 agent）  | 1549 + 264 行                         | `packages/harness/src/agent/index/`、`tools/agentCatalogFollower.ts`                                                                                                       |
| skills 子系统                                   | 1447 + 107 + 92 行                    | `packages/harness/src/skills/`、三个 skill schema、`packages/cli/src/commands/skills.ts`                                                                                   |
| documents 插件（工具、recipe、task 块、选项表） | 2271 行                               | `packages/texra/src/tools/documents/` 1837、`documentRecipe.ts` 164、`packages/texra/src/shared/plugins/documents.ts` 270                                                  |
| 插件                                            | 19 个：harness 内置 6，app 13         | `harnessBuiltins`（`packages/harness/src/tools/builtinPlugins.ts`）、`texraPlugins`（`packages/texra/src/tools/registry.ts`）                                              |
| `Plugin` 的字段                                 | 13                                    | `packages/harness/src/tools/plugins.ts`                                                                                                                                    |
| 带 `scriptModules` 的插件；带 `prompt` 段的插件 | 2（goal、documents）；3               | `grep scriptModules`；`memory-workflow`、`core`、`documents`                                                                                                               |
| 一个插件的程序今天的启动路径                    | 3 条                                  | host 表单经 `documentTaskConfig`；模型经 `document_task` 工具；`plan` 工具经 `launchBackgroundScript(goalScript(…))`                                                       |
| 读"这个 run 是不是 task"的地方                  | 22 个源文件                           | `isTaskConfig`、`recipeBlockOf`、`script.kind`（`packages/harness/src/shared/schemas/runRecords.ts`），含定义和再导出；视图上另有一份 `RunView.recipe`，进度视图的组件读它 |
| harness 公开导出                                | 754：root 36、host 163、node 48、其余 | `config/api-reports/*.md` 的 `Exports:` 行（plugins 134、schemas 299、transcript 74）                                                                                      |
| harness、app 源码                               | 80570、81378 行                       | `packages/{harness,texra}/src` 的 `.ts`、`.tsx`                                                                                                                            |
| 工具定义；工具代码                              | 52 个；31505 行                       | 19 个插件的工具表之和，`grep 'defineTool('` 也得 52；`packages/texra/src/tools` 19003，`packages/harness/src/tools` 12502                                                  |

35 个文件按做的事分簇：审稿 10 个（读 LaTeX 写批注，只有视角不同）、改稿
7 个、研究 6 个（共享同一段"Mathematical Communication"样板）、编排 3 个
（`orchestrator` 和 `engineer` 只差提示词）。

补偿层的清单，每一条都只为"几十个可用"而存在：

- `WorkspaceAgentsSelectionSchema` 的四种 kind（`inherit`、`all`、`team`、
  `custom`）、`HiddenCustomAgentKeysSchema`、`AgentDelegationScopeSchema`
  （`packages/harness/src/shared/schemas/workspaceAgents.ts`）。
- 五个 team、starter、Teams 标签页、`apply_team` 工具、`setup` 里问学科的
  那段对话。
- `PREFERRED_TOOL_USE_AGENTS`、`BUILTIN_TEAM_ROOT_AGENT_NAMES`、
  `NON_DEFAULT_TOOL_USE_AGENTS`
  （`packages/texra/src/shared/constants/agents.ts`）、agent 选项上的
  `isOrchestrator` 和 `rounds`。
- `customizeCopy`、`basedOn`、newer-built-in 提示。
- `DOCUMENT_TASK_OPTIONS` 这张五行的表和它在各个面上的渲染。

## 诊断

Ousterhout 的说法：当一个热点太复杂，找它背后的数据结构、重复的事实或放错
的所有者。这里有两处放错。

**第一处：可创造的单位放错了。** agent 文件把三种不同的东西压进一个形状：

1. **模型调用的参数**：prompt、tools、temperature。
2. **知识**：rubric、格式约定、领域用法。384 行的 `enhance.yaml` 几乎全是
   这个。
3. **流程**：几轮、每轮读什么、何时停。`task:` 块用 Nunjucks 写它，recipe
   用 JS 跑它。

把 2 和 3 塞进 1，目录就必然按"视角 × 流程"的积膨胀。四种审稿视角乘一种
批注流程是四个文件；再来一种流程就是八个。

**第二处：容器放错了。** 工具只有一个家，插件：每个工具属于恰好一个插
件，插件有开关、可用性探测、信任记录和一页设置。程序今天没有家，所以每
处"run 是程序"都自己找地方：goal 在插件的 `scriptModules` 里再由 `plan`
工具拼两行脚本启动，document 的 recipe 由 app 按 agent 名生成源码再挂到
agent 文件的 `task:` 块上，后台脚本写在模型的调用里。11-06 版为程序新建
了一个家（三个目录根加一个解析器），它是插件已有的那一套的平行物：

| 程序需要的       | 11-06 版新建的                               | 插件今天已有的                                                     |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| 放在哪           | `.texra/tasks/`、`~/.texra/tasks/`、`tasks/` | `resources/plugins/<id>/`，目录名就是插件 id                       |
| 按名字找到它     | 三种来源的解析器、撞名是扫描期错误           | 插件表（`toolTable`），id 唯一，模块名随 id 唯一                   |
| 关掉它           | 无（文件在就在）                             | 插件开关，关掉即收回它的一切（裁决 D9）                            |
| 能不能信         | `author` 字段，工作区的每次启动审批          | 安装式插件的信任记录：按内容摘要，改了任何文件就收回，直到重新审阅 |
| 人在哪里看见它   | 新的 Tasks 页、`texra tasks types`           | Plugins 页和 CLI 的 `/plugins`                                     |
| 对模型说它是什么 | `export const description` 静态提取          | 插件表里的数据                                                     |

内核今天认识 app 的词汇，是同一个病的另一面。核心概念的十三个名词
（`.agents/docs/implemented/architecture/2026-09-26-core-concepts.md`）
里有 **Agent**："从一个有序的来源目录解析出的定义"。`AgentConfig` 上为它
有 `agent`、`agentSource`、`persona`、`asCaller`、`delegationAgentScope`
五个字段，`Plugin` 上为它有 `agentBlock`，harness 里为它有索引、workspace
选择和 skills 三个目录共 3570 行。

反过来看已经做对的部分：

- `Plugin.scriptModules` 已经让插件出货沙箱模块；沙箱的模块加载器已经是
  "一个 specifier 整体命名一个模块，宿主给的就加载，别的一律拒绝"
  （`packages/harness/src/agent/codeSandbox/worker.ts`），没有文件系统。
- `assistant.yaml` 的 92 行 prompt 本身就是按能力分段写的（Literature、
  Computation、Formal Proofs、Document Toolkit、各工具的用法），并且要为
  可能没开的插件写"when available"。它是手工拼出来的"各插件的 prompt
  段"；而 `Plugin.prompt` 这个字段已经存在，有三个插件在用。
- codemode 的裁决里已经有一条"code mode stays domain-free"。

缺的只是：**把"插件带程序"当成唯一的路，让内核忘掉 agent。**

## 长期判断

前提（负责人裁决，见"决定记录"）：模型会变强。由此，价值从"对模型说什么"
转到四件事：验证器（编译、diff、测试、texcount、文献 API）、持久的编排（长
goal、恢复、预算、并行）、用户和社区积累的程序、以及可观测和可审批的执
行。提示词趋近于零；凡是提示词里教模型"按步骤做"的部分，都应该是一段步
骤被验证过的程序。

因此 TeXRA 分两层看：

- **内核**是一个持久执行程序的 harness，程序的操作是模型调用和工具调
  用，历史是真相。1.0 PRD 的第一段已经这么说了："内核维护调用、权限、资
  源和持久化契约；goal、研究流程和领域策略由脚本及插件表达"。
- **产品**是一组插件。一个 theorist 的做法（改稿、审稿、推导、形式化、查
  文献）是带验证器的程序，住在插件里，随插件开关、分发和信任。

三年尺度上要守住的不变量：

- **历史一个写者，run loop 一个程序**（AGENTS.md "Agent system"）。程序
  是 `script` 调用的 guest，不是第二个引擎。
- **持久化不随代码变**：钉住的源码和摘要是 run 的一部分；改了程序文件不
  改正在跑的 run，恢复用原源码。
- **一个 fact 一个 owner**：一段程序是谁的，由它的名字（`<插件>:<名字>`）
  回答，审批和信任从它推导，不另存一份。

## 设计

### 两层

```
内核      @texra-ai/harness、@texra-ai/llm   持久地跑程序；认识 run、call、tool、program、plugin
theorist  @texra-ai/texra 的插件             程序 + 工具 + 一段 prompt：documents、lean4、…
host      extension、desktop、cli            三个壳
```

内核对 theorist 一无所知：它不认识 document、LaTeX、审稿、Lean，也不认
识"内置的 task 目录"。theorist 插件只通过 `Plugin` 这一个契约进入内核，
和一个仓库外的 embedder 写插件用的是同一个契约。

### 内核认识什么

| 核心概念    | 今天                                                                                 | 之后                                                                       |
| ----------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Agent       | 从有序的来源目录解析出的定义：built-in、custom、插件、inline                         | 删。换成 **Program**：插件出货的沙箱模块，按 `<插件>:<名字>` import 和启动 |
| Plugin      | 工具、prompt 段、layer、探测、开关、fact、一个 agent 文件块                          | 同左，agent 文件块换成程序                                                 |
| Composition | 钉住的目录按 agent 的工具声明收窄                                                    | 钉住的目录按 run 的工具列表收窄                                            |
| Run         | 以一份 agent 定义打开                                                                | 以一组 chat 参数或一个程序打开                                             |
| 其余九个    | Process、Session、History、Projection、Input、Call、Request、Host、Application state | 不动                                                                       |

之后内核里不再出现的词：agent 文件、persona、agent source、catalog、
customize 副本、skill、team、delegation scope、workspace 选择、task 块、
recipe。

"小"在这里指内核认识的名词和公开面，不指行数。harness 的 80570 行里，大
头是持久化协议本身：`agent/runtime` 19220、`shared/session` 7135、
`controllers`（SQLite 存储）6550，本提案不动它们。本提案从 harness 拿走的
是约 4500 行 app 词汇和 `./host` 入口上为它们而设的导出（见"删除清单"）。
把内置插件从内核目录里搬出去是另一件事，见"负责人问题"4。

### 插件契约

`Plugin`（`packages/harness/src/tools/plugins.ts`）13 个字段，改两个：

```ts
interface Plugin {
  // id、tools、availability、toggle、injectedWhen、prompt、processLayer、
  // sessionLayer、decision、factKinds、requires：不变

  /** 它出货的沙箱模块，源码按名字；以 `<id>:<name>` 被 import。
   *  今天的 scriptModules，命名空间从 builtIn: 改为插件 id。 */
  readonly modules?: Readonly<Record<string, string>>;

  /** 其中可以被人或模型按名启动的模块（默认导出是
   *  async (args) => result），名字到一行描述：picker 和模型的脚本
   *  声明里显示的那一行。今天的 agentBlock 的位置。 */
  readonly programs?: Readonly<Record<string, string>>;
}
```

- `agentBlock` 连同 `AgentBlock`、`AgentBlockResult`、`RecipeChange`、
  `boundFiles`、`boundFile`、`agentBlockOf`、`ToolTable.blocks` 和
  `ITool.launchesTasks` 一起删。PRD 也说 `agentBlock`"不应被写成 agent 模
  板发布接口"。
- 命名空间用插件 id（`documents:revise`、`goal:goal`），不再用
  `builtIn:`。id 已经是持久化的、唯一的、不复用的，于是"两个插件出同名模
  块"这条表检查（`toolTable`）因构造而不需要，"这段程序是谁的"由名字回
  答。
- 描述是插件表里的数据。不为发现而求值任何源码，原生插件也不从源码里提
  取它。
- 没有按程序的工具声明。一个程序的 run 被 offer 的工具从插件表推出：一
  次聊天此刻会被 offer 的那些，加上它自己的插件和它 `requires` 的插件的
  工具，不看开关（今天 task 的"工具不受开关影响"就是这一条）。程序是固
  定的代码，它调什么写在源码里；能收窄的是它启动的 `agent()`，那是代码
  里的一个 `tools` 列表。`requires` 今天只检查表里有没有那个插件，这里
  让它多回答一件事：它的程序用得到谁的工具。
- 工具定义上换一个事实。今天的 `launchesTasks` 删；换成"这个工具只在自
  己插件的程序里有意义"（`document_context` 这一类，读的是程序 run 自己
  的状态），这样的工具不进聊天的默认工具集（"聊天不是一个 agent"一
  节）。
- `injectedWhen` 的一半理由是"agent 没声明这个工具也给它"；agent 的工具声
  明消失后，这个字段只剩"跟着一个设置开关"这一半，留到删 agent 文件那一
  期再看它是否还要。

### 一个程序是什么

```js
// packages/extension/resources/plugins/documents/programs/annotate.js
import { revise, addsOnly, ANNOTATE_FORMAT } from 'documents:revise';

export default (args) =>
  revise({
    ...args,
    system: 'You annotate. You never rewrite.',
    requests: [ANNOTATE_FORMAT],
    // 代码能检查 YAML 只能要求的事：diff 只新增 \criticize{ 行
    verify: addsOnly('\\criticize{'),
  });
```

- **契约。** 一个 ES 模块，默认导出 `async (args) => result`。`args` 是
  launch form 已有的四组文件加指令加 memories（`LaunchSurfaceSchema`，
  `packages/texra/src/shared/session/surface.ts`），没有按程序的输入
  schema；由事件触发的程序从 `args.event` 拿到事件。返回值是 run 的结构化
  输出。
- **import。** 只有一种 specifier：`<插件>:<名字>`。加载器不变：宿主给
  的就加载，别的拒绝并列出可用的名字。没有文件系统路径，所以没有越界和
  解析根这两个问题。模块之间的静态 `import` 和脚本里的动态 `import()` 走
  同一个加载器。
- **启动只有一条路。** `start({ program: 'documents:annotate', args })`。
  run 以一段两行的生成脚本打开（import 这个模块，调用它的默认导出），这
  正是 `goalScript()` 今天生成的东西，所以 `script` 工具、它的行和重放都
  不变。今天的三条启动路径（表单经 `documentTaskConfig`、模型经
  `document_task` 和 `ChildRuns.launch({ task })`、`plan` 经
  `launchBackgroundScript`）都变成这一条。
- **钉住。** 一步能 import 的模块，源码按 specifier 存为 `context.blob`，
  摘要写进这一步的 `tools.offered.modules`
  （`packages/harness/src/shared/schemas/offeredTools.ts`）；这是模块今天
  就钉在的地方，不另开一份。恢复用钉住的源码。
- **没有按程序的选项。** `reflect`、`attachTeXCount` 这类开关是程序里的
  一行 `if`；真需要一个开关的地方是第二个程序。launch form 的五个开关和
  `texra run` 的对应 flag 随之消失，这是明说的损失（"权衡"）。
- **源码是真实的文件。** bundled 插件的程序是它目录
  `resources/plugins/<id>/programs/` 里的 `.js` 文件；这个目录今天放的是
  `agents/` 和 `skills/`，按 id 对上插件，随插件开关收回。host 的组装根在
  建插件表时读入，交给内核的是值，内核不读程序目录。今天的 `GOAL_MODULE`、
  `DOCUMENTS_MODULE` 和 `recipeSource()` 是 TS 里的模板字符串，没有 lint、
  没有高亮，常量靠 `JSON.stringify` 拼进源码；之后它们是可以 lint、可以在
  编辑器里读、可以让模型当例子读的文件。

### 原语：一个 `start`，三个糖，一个收件箱

控制面和能力面分开。能力面是工具，永远开放：新能力是一个新工具或 PATH
上的一个 CLI，不碰控制面。控制面要完备，而且要小：

```
start(config)      生成一个子 run；await 它就是 wait。config 是 run 配置本身
tools.*            效果
import             复用
```

`agent(prompt, { system, tools, model })`、`program(name, args)` 和
`self(prompt, { fork })` 是 `start` 的三个糖：`agent` 是 `start` 一个 chat
叶子，`program` 是 `start` 一个插件的程序，`self` 是 `start` 一个 chat 叶子
并取调用者的 system 和 tools、可选复制对话。它们的参数加起来恰好是 run
配置的联合，所以脚本里的 `start`、SDK 的 `session.start`、launch form 和
`texra run` 发的是同一个东西，PRD 要的"一扇门"在这里闭合。

收件箱是唯一的通道：用户文本、子 run 的报告、同级消息、订阅通知都是它里
面的一条消息（`packages/harness/src/agent/followUp/`）。一个程序**不读**
自己的收件箱（"触发"一节说为什么），它从 args 拿到触发它的事件。

JS 图灵完备，加上 `start` 和 `await`，能表达任何可计算的编排：顺序、分
支、循环、递归、fan-out、监督循环、辩论、人在回路。Unix 的对照：`start`
是 fork 加 exec，`await` 是 wait，收件箱是 pipe，插件表是 PATH，args 和
返回值加 run 存储是 stdin 和 stdout，`AGENTS.md` 是 env，审批策略加"子
run 的工具 ⊆ 父 run"是权限。

诚实的缺口：没有时间触发（需要一个让 host 到点发消息的 `schedule` 工具，
今天只有 GitHub 订阅）；程序把控制权交给人没有原语（结束并返回结果，host
决定下一步，goal 的 `needs_user` 就是这样）；上下文只有 fork 整个对话或
fresh 两档。

### run 的两类

`AgentConfigSchema`（`packages/harness/src/shared/schemas/agentConfig.ts`）
今天是"persona 可选，script 可选，两种 script kind"。目标形态是一个联合：

```
run.chat     { system, tools, model, temperature, instruction, files…, memories,
               outputSchema, workingDirectory }                    内核的模型循环
run.program  { program: '<插件>:<名字>', args, conversation? }      插件的程序，按名
             { code, title, tools, timeoutMs, conversation }       模型写的脚本送后台
```

- 按名的程序和内联的代码是 `program` 的两种写法，差别就是"谁写的"：有
  名字的是那个插件的，内联的是模型的。所以不需要 `author` 字段，
  `recipe.block` 和 `recipe.options` 随 `task:` 块删。
- `conversation` 是可选的父对话边：一个从聊天里启动的程序（后台脚本、
  goal）记录它 fork 的来源，`self()` 只在这条边存在时可用，这正是今天
  `selfOf` 的规则（`packages/harness/src/tools/codemode/SelfTool.ts`：后
  台脚本有可 fork 的对话，recipe 没有）。picker 或 CLI 启动的程序没有这
  条边，`self()` 在里面是错误，用 `agent()`。
- `chat` 的字段就是今天 `InlinePersonaSchema` 加 `AgentConfig` 上已有的
  几项，直接放在 config 上：没有 `persona` 子对象、没有 `agent` 名、没有
  `agentSource`。`agent()` 的输入去掉 `agentName` 和 `persona`，直接取
  `system`、`tools`、`model`；`asCaller` 变成"复制父运行的 system 和
  tools"。
- 聊天本身仍是内核原生的模型轮次。"一切都是程序"（聊天循环也是 guest 脚
  本）与 run loop 唯一写者的契约冲突，不做。

这个联合是**格式变更**：`run.config` 的行版本要升
（`packages/harness/src/shared/schemas/rowVersions.ts`），golden store 重
生成。今天约 20 个源文件读"这个 run 是不是 task"，它们的替代是"这个 run
是不是以一个按名的程序打开的"，一个事实，仍从 `run.config` 读；这和已否
决的候选 `RUN-trusted-script-launch-grants`（不另存一份授权记录）一致。

### 聊天不是一个 agent

没有 agents 目录之后，聊天是内核的模型循环加上开着的插件：

- **system 文本** = 调用者给的 `system`（根聊天不给）、`AGENTS.md`、附上
  的 memories、harness 自己的工具使用说明、然后每个开着的插件的 `prompt`
  段。除第一项外都是 `buildOpeningSystemPrompt` 和 `stepInstructions`
  （`packages/harness/src/agent/prompt/PromptBuilder.ts`）今天就在拼的；
  消失的是排在最前面的 persona prompt、skills 列表，以及"Available
  agents"这一段（`delegationSection`）。`assistant.yaml` 里各能力的那几句搬到各自插件
  的段里，插件没开就没有那几句，不必再写"when available"。通用的部分
  （你在哪、什么时候写脚本、什么时候启动一个程序）是 app 的 `core` 插件
  的段，40 行以内；这个插件和它的段今天就在（`TEX_INSTRUCTIONS`）。
- **工具** = 开着的插件对聊天开放的工具。19 个插件共 52 个工具，
  `assistant.yaml` 手抄了其中 37 个；没抄的 15 个恰好是三类：setup 的 8
  个（只给 setup 那次对话）、documents 里只供它的程序调用的 6 个
  （`document_context` 到 `document_propose`）、和 `self`（只在脚本里有
  意义）。所以默认集合不用抄：一个工具默认对聊天开放，除非它的定义说它
  只属于自己插件的程序；一次给了 `tools` 列表的 `start`（setup、
  `agent()` 的子运行）拿到的就是那张列表。
- **可启动的程序** = 开着的插件的 `programs`，和工具声明并列出现在脚本声
  明里（`packages/harness/src/tools/codemode/declarations.ts` 加一段）。

所以没有叫 assistant 的文件、常量或名字：它是"插件开着时你得到的东西"。
审稿、搜索、写代码不是目录项，是模型在脚本里用不同的 `system` 字面量调
`agent()`；"只读审稿"是一个 `tools` 列表。headless 的一次性聊天是
`texra run chat --print`。

`setup` 是 setup 插件自己的一组 chat 参数（它的 system 文本和工具列
表），由 setup 命令作为一次普通的 `start` 发出；内核里没有它的名字。删掉
问学科选 team 的一段。

script-only 翻为默认：两个模型的评测通过率持平、每次成功的成本低 18% 到
66%（codemode 文档 "Still open" 第二轮），按 Q10 补 glm 和 fan-out journey
后翻；Q3 的按模型回退标志留给过不了线的模型。

### theorist 的程序插件

把今天的资产照实搬过去，19 个插件里带程序的是三个：

| 插件                   | 今天的来源                                                 | 程序                                                                                           | 工具                             |
| ---------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------- |
| `documents`            | 15 个 task 文件、`critic`、`latexFixer`                    | `edit`、`annotate`、`enhance`、`apply`、`merge`、`transcribe`、`slides`、`poster`、`fix-build` | `document_*`、`accept_run_files` |
| `lean4`                | 5 个 agent、5 个 skill                                     | `prove`、`blueprint`                                                                           | `lean_*`                         |
| `goal`（harness 内置） | `builtIn:goal`                                             | `goal`                                                                                         | `plan`                           |
| 其余 16 个             | arxiv、zotero、wolfram、latex 提取和诊断、github、setup 等 | 无                                                                                             | 原样                             |

其余的 bundled agent 不变成程序：`research`、`numerics`、`prover`、
`search`、`review`、`presenter`、`simplifier`、`progressCheck`、四个写代
码的、三个编排的和 `latexDiff`，差别是工作方式的描述，不是流程，随"模型
会变强"直接变成 `agent()` 的一行参数。`creator` 不保留：写一个程序就是写
一个文件。9 个 bundled skill 和 multi-agent 的那个 skill 删；TeXRA 特有的
约定（`\criticize{}` 的格式、输出文档的格式）进对应的程序。

三条规则：

1. **按能力切，不按学科切。** 物理、数学、CS 的 theorist 都要改稿和查文
   献；按学科切会让同一个程序有三个家。学科是"这个项目开着哪些插件"加
   `AGENTS.md` 里的约定，不是一个插件。今天的五个 team 回答的问题（这个项
   目看见哪些 agent）随目录一起消失：picker 里是 chat 加十来个程序。
2. **一个 theorist 程序是一个带验证器的做法。** 它值得是程序而不是一句提
   示词，是因为有东西能检查它：`documents` 的编译、diff 和 texcount，
   `lean4` 的诊断。往后新增的程序（拿 CAS 逐步复核一段推导、对着 `.bib`
   和 arXiv 核对每条引用）按同一个标准进来；本提案不建它们。
3. **一个棘轮。** bundled 程序的数量只降不升。新增一个要同时交一个
   journey，并写明它为什么不能是用户自己的程序。12 个各自带 journey，棘
   轮从第一天起算。

### 目录插件：安装的和项目自己的

程序是沙箱里的 JS，不需要原生代码，所以一个只带程序的插件可以是一个目
录。安装式插件今天已经是目录（Claude Code、Codex 的布局，
`packages/harness/src/common/plugins/pluginManifest.ts`），能带 skills、
commands、agents、MCP server 和 hooks，不能带脚本模块。之后它带的是
`programs/*.js`、MCP server 和 hooks：

- **加载。** 和它的 MCP server 一样按步加载（`readInstalledPluginLoad`，
  `packages/harness/src/common/plugins/pluginTrust.ts`），进入这一步的模
  块表，名字是 `<插件名>:<文件名>`。目录里一个程序的描述由加载器从文件
  里那一行 `export const description = '…'` 静态读出，不求值；一个非
  `.js` 文件被 import 时是导出其文本的模块（模板、rubric）。这些是加载
  器的约定，内核拿到的仍是值。
- **信任用已有的那一套。** 安装式插件的信任按内容摘要记在用户的全局状态
  里：启用时列出它带的东西让人审阅，改了任何文件摘要就变，插件整体收
  回，直到重新审阅。程序进这份清单（名字和描述，源码可看）。于是 picker
  里没有不受信的东西：内置的随应用出货，安装的过了这次审阅，不受信的插
  件什么都不加载。`author` 字段和按启动的审批都不需要。
- **待遇比内置的少一项。** 目录插件的程序和内置的一样，启动和它的
  `agent()` 子运行随那次审阅批准；但它的文件列表照模型脚本那样解析（工
  作区和它的子 run 的存储之内），不"按写的通过"。一次审阅不该换来读工
  作区外任意路径。这个差别从"它是哪个插件的"推出，不另存。
- **项目自己的程序是一个按路径引用的插件。** 安装式插件已经支持本地路
  径；项目的 `.texra/programs/` 就是这样一个插件。信任记录在用户的全局状
  态里，仓库不能给自己授权（裁决 D6）：克隆一个仓库，它的程序在 Plugins
  页里是"未受信"，一个都不出现在 picker 里。

这就是用户创造的闭环：模型在聊天里写了一段脚本，跑通了，用户说"存下
来"，模型把它写进 `.texra/programs/x.js`（一次普通的 `write_file`，走审
批 diff）；用户在 Plugins 页审阅一次，picker 里就有它，`texra run x` 能
跑，进 git 能分享，别人拉下来审阅一次就能用。目录从使用中长出来，而不是
从 vendor 的仓库里长出来。一段还没被审阅的程序并没有丢：模型照样能读它，
把它当一段内联脚本跑，走脚本本来的审批。

custom 扩展 bundled 的方式是 import，不是覆盖。bundled 的程序就是一个
模块，用户包一层：

```js
// .texra/programs/logic-review.js
import annotate from 'documents:annotate';
import rubric from './rubrics/logic.md';
export const description = 'Annotate for argument structure only.';
export default (args) => annotate({ ...args, rubric });
```

上游改了 `annotate`，包装自动跟上。今天的 `customizeCopy`、`basedOn` 和
newer-built-in 提示存在的唯一理由是 built-in 太大、改得太勤，用户复制一份
400 行就漂移；两个条件都消失，机制跟着删。同名不覆盖：名字带插件前缀，
不会撞。相对 specifier（`./rubrics/logic.md`）按发起 import 的模块自己的
名字解析成同一个插件里的另一个名字：specifier 字符串上的一个纯函数，没
有文件系统，越出插件的名字查不到就被拒绝。它只对目录插件有用，随这一期
加。

### 审批、重放与信任

- **信任跟着插件走。** 今天 `isTaskConfig` 只认 `script.kind: 'recipe'`：
  这样的 run 的工具不受开关影响、`agent()` 随启动批准、文件列表"按写的通
  过"、不激活 skill。之后这些待遇给"以一个按名的程序打开的 run"，因为有
  名字就意味着它的插件被加载了，被加载就意味着它是随应用出货的或者过了
  内容审阅的。三档各自从"这段代码是谁的"推出：内置插件的程序拿全部待
  遇；目录插件的程序少"文件按写的通过"一项；模型写的脚本一项都没有。
- **模型写的脚本不变。** 内联的代码是模型的：它的 `agent()` 走 Q5 的一次
  脚本请求（展示源码，批准即覆盖整段），文件列表照模型脚本解析。
- **审批不加新东西。** 程序里的嵌套调用走和今天完全相同的 per-call 程序
  （hooks、guard、approval、结果行）。模型启动一个程序是一次子运行的启动
  审批（`proposal` 请求），字段从 agent 名改为程序名。
- **重放。** 源码和模块钉在步骤上，`ScriptDiverged` 照旧。
- **发现期不执行任何代码。**

### multi-agent 编排

编排不是被删掉，是回到它本来的形态：一段程序。codemode 文档已经写了
"`agent()` 是普通工具，所以 fan-out 工作流就是一个脚本"，并以此替掉了
`delegate_multi_agents` 和五种 `workflow.*` 行。今天的 `orchestrator` 和
`engineer` 是两段提示词，只是告诉模型"拆任务然后调 `agent()`"。

留下的是机器：子运行带父边、一次脚本审批覆盖它的所有 `agent()`（Q5）、
会话级子运行并发预算、goal 的花费上限、`executions` 的运行间消息、子报告
走 follow-up 收件箱、后台程序、Q2 的结果复用、SQL 的 `run_tree` 和
`tool_calls` 视图。没有一个依赖 agent 文件或 team。

每种模式是几行：

```js
// fan-out / fan-in
const [math, cites, code] = await Promise.all([
  agent('Check every derivation in §3.', {
    system: REVIEWER,
    tools: READ_ONLY,
  }),
  agent('Verify each citation against refs.bib.', {
    system: LIBRARIAN,
    tools: [...READ_ONLY, 'bash'],
  }),
  agent('Run the tests and report failures.', { tools: ['bash', 'read_file'] }),
]);

// pipeline
const annotated = await program('documents:annotate', { files });
const applied = await program('documents:apply', from(annotated));

// supervisor loop：goal 已经是它，verdict 和花费上限的语义在里面。
// 它用 self()，所以只能从一个聊天的脚本里调（program 的 conversation 边）
const { goal } = await import('goal:goal');
return goal(objective, { maxCostUsd: 5 });

// debate + judge
const [a, b] = await Promise.all([
  agent(q, { system: PRO }),
  agent(q, { system: CON }),
]);
return agent(`Judge:\n${a.response}\n---\n${b.response}`, {
  system: JUDGE,
  schema: VERDICT,
});
```

team 给过的是一张"编排者可以挑的专家名单"。替代有两层：模型为当下需要的
专家当场写一段 system 文本；需要跨会话复用或带专属工具的专家，是一个五
行的程序，脚本声明里的程序列表就是名单。

不出编排库（`fanOut`、`pipeline`、`supervise`）：`Promise.all` 就是
fan-out，`program` 加 `from` 就是 pipeline。唯一值得作为库出货的模式是
goal，因为它编码了 verdict、暂停原因和花费上限这些 harness 语义，而它已
经在了。`multi-agent` 插件的开关保留作为用户的一次同意。
`docs/guide/multi-agent-workflows.md` 改写成上面四个模式。

### document task 的归宿

15 个带 `task:` 块的文件是同一个函数的 15 组参数，那个函数今天就是一段
JS 的 recipe。`documents:revise` 导出一个原语，现在的 recipe 泛化后的样
子：

```js
revise({
  files,
  context,
  media,
  instruction,
  memories,
  requests, // 每轮一段文字；长度就是轮数
  system, // 可选；默认 "You revise LaTeX documents."
  outputs, // 可选；不给就是原文件名
  review, // 可选；轮间 critic 的 rubric，默认是 critic.yaml 那 12 行
  verify, // 可选；每轮产物的检查函数，失败即下一轮的输入
});
```

步骤不变：`document_context`、`agent()` 一次、`document_extract`、
`document_compile`、`document_diff`，轮间 `document_review`，最后
`document_propose`。`critic` 不再是 agent，是 `review` 的默认常量。

这不是 recipe 的改写，是 documents 工具的契约变更：`document_context` 今
天每次调用都经 `AgentCatalog` 读 agent 的 `task:` 块（`documentState.ts`
的 `documentTaskOf`），轮数取 `task.requests.length`（`documentTools.ts`），
prefix 和 requests 由它渲染 Nunjucks。之后 prefix、requests、轮数由
`revise` 作为工具输入传给 `document_context`，Nunjucks 删；"Pass N of M"的
M 今天来自目录选项的 `rounds`，之后来自 `document_context` 第一次调用写进
documents fact 的 `revisions`。

按参数去重后 15 个文件是 8 个程序，每个十几行：

| 今天                                  | 之后          | 差别只在                           |
| ------------------------------------- | ------------- | ---------------------------------- |
| correct, polish, generic              | `edit`        | requests 文字，由 instruction 区分 |
| criticize, firstread, logic, notation | `annotate`    | 无；它们独有的句子不保留           |
| enhance, devise                       | `enhance`     | 两段 requests                      |
| apply                                 | `apply`       |                                    |
| merge                                 | `merge`       |                                    |
| ocr, transcribe_audio                 | `transcribe`  | 由媒体文件后缀决定                 |
| paper2slide                           | `slides`      | 模板 import                        |
| paper2poster                          | `poster`      | 三个模板 import                    |
| critic                                | `review` 参数 |                                    |

第九个是 `fix-build`：编译失败后的修复，今天 host 手拼 config 启
`latexFixer`（`compileFixer.ts` 的 `planCompileFixer`）。

代码赢过 YAML 的地方是 `verify`：YAML 只能要求模型"别改别的"，代码可以
检查。`annotate` 断言 diff 只新增 `\criticize{` 行；`merge` 断言输出含原文
的每个 `\section`；`edit` 断言 texcount 没有掉一半；`slides` 和 `poster`
断言带模板能编译。每个几行，失败就是下一轮的输入。

模型自己用同一个原语。用户说"把这篇校对一下"，聊天里的模型不需要 picker
里有 `edit`：一行 `program('documents:edit', { files })`。九个 bundled 程
序只为两件事存在：picker 里的一次点击，和 `texra run documents:edit
paper.tex`。

这和裁决"Adaptive document workflows are not planned"（2026-09-06）的关
系：那条拒绝的是由模型选择、用候选文件的 document 工作流取代固定的工作
流。这里固定的工作流还在（`revise` 的步骤不变），模型在一段脚本里组合一
个固定的原语，每段脚本过 Q5 的一次审批并按记录重放。它是"策略是代码"，
不是"引擎里有自适应"。本提案把这条列为要负责人确认的一处（下文）。

### 启动面

用户不挑 agent。launch form 今天默认选中 `orchestrator`，列表是
workspace 选择放行的那些 agent（全开是 35 个加插件的 5 个，team 存在就
是为了把它砍短）；之后默认是 chat，不选任何东西就能开始，要什么在聊天
里说，由模型启动对应的程序。

picker 列 chat 和开着的插件的程序，仅此。`launchTarget: 'agent' | 'team'`、
`selectedTeamId`、`agent` 字段和五个选项字段删。`texra run <程序 | chat>`
一个命令，`--print` 照旧，`texra chat` 照旧，`texra team`、`texra agents`、
`texra skills` 删。`document_task` 工具和 `builtIn:documents` 的
`revise(agentName)` 包装删，`from()` 留给串联。提案卡今天显示 agent 名，
之后显示程序名，或 `label` 和 system 文本的首句。

Plugins 页（和 CLI 的 `/plugins`）多列一项：每个插件的程序，名字、描述、
源码。不新建 Tasks 页。

## run 怎么开始、怎么结束、结果去哪

结论先说：**结束的一侧已经是一个机制，开始的一侧有五种叫法，结果的读法
有一处插件特例。** 本提案改的只是后两者。

### 开始：谁启动一个 run，用什么命名它

| 入口                                       | 今天的命名方式                                                                          | 代码                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| host 的 launch form                        | `agent` 名、`launchTarget`、`selectedTeamId`、选项表                                    | `LaunchSurfaceSchema` → `session.start({ config })`                               |
| `texra run <agent>`、`texra team run`      | agent 名、team id                                                                       | `packages/cli/src/commands/run.ts`、`team.ts`                                     |
| SDK                                        | agent 名或 inline persona，或整份 `config`                                              | `StartRequestSchema`                                                              |
| host 自己按名字启动                        | `'latexFixer'`、`'merge'`、`'setup'`；表单默认 `'orchestrator'`、CLI 默认 `'assistant'` | `planCompileFixer`、`handleFixCompilation`、`HostRunActions.merge`、`launchSetup` |
| 模型：`agent()`                            | `agentName` 或内联 `persona`                                                            | `AgentTool.ts`、`proposalFlow.ts` 的 `requireAgent`                               |
| 模型：`document_task()`                    | agent 名，子 run 开在 recipe 上                                                         | `DocumentTaskTool.ts`                                                             |
| 模型：`self()`                             | 同一个 agent；fork 或 fresh；只有后台脚本有可 fork 的对话                               | `SelfTool.ts`                                                                     |
| 模型：`script` 后台、plan 的 "Run as Goal" | 父 run 的 agent 和工具，`script.kind: 'background'`                                     | `backgroundScript.ts`、`PlanTool.ts`、`goalScript.ts`                             |
| 进程子运行（后台 bash、agent CLI）         | 工具自己供给那一轮                                                                      | `processRun.ts`                                                                   |
| 恢复、fork、聊天续轮                       | 同一份 rows                                                                             | `resumeRun.ts`、`forkRun.ts`、`rootLaunch.ts`、`FollowUps.ts`                     |

一个 run 要跑什么，今天有五种表示：agent 名、team、内联 persona、recipe
块、script kind。它们在同一张 `AgentConfig` 上共存。本提案收成两种
（`chat`、`program`）：host 和 CLI 启动 chat 或一个程序；SDK 给
`{ system, tools }` 或 `{ program, args }`；模型用 `agent()`、
`program()`、`self()`；host 自己按名字启动的几处变成对插件程序的调用
（`documents:fix-build`、`documents:merge`）或 setup 插件的 chat 参数，
两个默认值删。`requireAgent` 的 scope 和 shadowing 解析删。

### 结束：一个终点，一种投递

这一侧已经统一，本提案不动它：

- **一个终点。** 每个 run 的 fiber 不管怎么退出都到 `endRun`
  （`AgentRunLifecycle.ts`），一次事务写 `run.end`，同一事务把子 run 的
  报告排进父 run 的收件箱（`agent/storage/runLifecycle.ts`），除非父调用
  在等它。
- **等与不等。** 脚本里的 `agent()` 默认等（`childLaunch.ts`）；
  `background: true`、直接调用、后台脚本、进程子运行走收件箱，父 run 下
  一轮把整批排队项合成一条 user 消息（`FollowUps.ts`）。投递的信封只有一
  个构造器（`deliveryEnvelope.ts`）。
- **停止与遗留。** `run.stop` 行加 fiber 中断；进程死掉留下的子 run 在父
  run 恢复时按自己的 id 恢复（`leftoverChildren.ts`）。
- **goal。** 结果是 `completed` 或 `paused`（`needs_user`、`round_failed`、
  `no_verdict`、`spend_cap`）；"暂停是一个结果，不是一个在等的 run"。

### 结果怎么被读：唯一的插件特例

recipe 是特例：`recipeResult.ts` 按 `script.block` 找到插件的
`AgentBlock.result`，用它的 schema 校验、`delivery()` 生成投递正文、
`changes()` 列出写了哪些文件。这是 harness 里唯一一处"读一个结果要问插
件"，它有三个调用者：`AgentTool.ts`（把 `changes` 放进脚本值）、
`childDelivery.ts`（父投递）、`agent/storage/childRunOutput.ts`。

本提案删掉它：一个程序的结束就是一个脚本的结束。投递是通用的调用摘要加
文件列表加返回值（JSON，有界）；`document_propose` 的结果行含"提议的文
件、diff 路径和编译失败"，通用摘要把这些带上，父模型读到的内容不少于今
天。三个调用者一起改；documents 的 fact（UI 读 diff 和 accept 用的）照旧
由 `document_propose` 写，不受影响。

## 触发就是带着事件启动一个程序

goal mode 之所以看起来 codemode native，是因为它把三件事分开了：触发是
一次按钮（批准 plan），启动是一段两行脚本，策略是一个可替换的模块
（`goal.strategy`）。把这三件事推到每一个入口上，就是统一。

两条公理：凡是在跑的东西都是程序（叶子是 chat）；凡是让程序跑起来的事都
是一次 `start`，事件在 `args` 里。

| 触发                          | 今天怎么接                                       | 统一后                                                                        |
| ----------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| 批准 plan，"Run as Goal"      | `goalScript()` 生成两行脚本，`PlanTool` 特殊启动 | `start({ program: 'goal:goal', args, conversation })`，不特殊                 |
| launch form 点 Run            | 按 agent 还是 task 拼不同的 `AgentConfig`        | `start({ program: 'documents:edit', args })`                                  |
| `texra run`                   | 同上                                             | 同上                                                                          |
| 编译失败后修复                | `planCompileFixer` 手拼 config 启 `latexFixer`   | `start({ program: 'documents:fix-build', args })`，或程序在 `verify` 里自己修 |
| 模型要 fan-out                | 脚本里 `Promise.all(agent…)`                     | 不变                                                                          |
| PR 开了、CI 红了              | 订阅通知投进某个 run 的收件箱                    | host 收到通知，`start({ program, args: { event } })`                          |
| 用户在聊天里回话              | chat 叶子的下一轮                                | 不变                                                                          |
| host 的其他事件（保存、定时） | 无                                               | 一次 `start`，事件在 args                                                     |

一个要对事件做反应的程序，是**每个事件启动一次**的短程序，不是一个常驻
的循环。订阅住在 host，程序本身无状态，状态在文件和 run history 里。

不做 `receive()`（让程序等自己收件箱的下一条消息）：收件箱的消费是整批
的，一个 run 一个读者，把队列里所有项合成一条 user 消息一次提交
（`FollowUps.ts`），逐条消费是一个新的写点；`needsWake`
（`agent/followUp/FollowUpReader.ts`）对通知类消息不唤醒，一个在等的程序
进程死了，webhook 不会叫醒它；而且它反转 codemode 的关注点分离
（Messaging 不认识 scripts）。"每个事件启动一次"用已有的写点和唤醒规则
就能做。

边界：chat 叶子是唯一不是程序的东西；沙箱没有定时器不变，定时触发是
host 到点 `start`；脚本 24 小时的墙钟上限不变。

## 其他 surface

| 面                    | 今天涉及 agent、team、skill、task 的部分                                                                      | 之后                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 设置页                | Agents、Teams、Skills 三个标签页，选择面板，newer-built-in 提示                                               | 都删；Plugins 页列每个插件的程序                                                  |
| 进度视图的 launch     | `launchTarget`、`selectedTeamId`、`agent`、五个选项字段                                                       | chat 或程序名，加四组文件和指令                                                   |
| CLI                   | `agents`、`team`、`skills`、`chat --agent`、`run <agent>` 加选项 flag                                         | 前三个命令和 `--agent` 删；`run <程序 \| chat>`                                   |
| 设置行                | `workspaceAgents`、`hiddenCustomAgents`、`skills.*`、`codeMode.scriptOnly`、`goal.strategy`                   | 前三组删；`scriptOnly` 随翻默认删；`goal.strategy` 留，值是程序名                 |
| SDK 导出              | `./host` 上 `AgentCatalog`、`WorkspaceAgents`、`AgentDirectories`、`Skills` 四族，`./plugins` 上 `AgentBlock` | 全删。`AgentConfig`、`AgentEvent`、`AgentPlatform` 是 run 的词汇，名字不动        |
| `session.request`     | 无                                                                                                            | 不变；`StartRequest` 改为 `{ system, tools, instruction }` 或 `{ program, args }` |
| 请求                  | `proposal`（子运行的启动审批）显示 agent 名和 persona                                                         | 留；显示程序名，或 label 和 system 文本                                           |
| `docs/guide`（32 页） | `built-in-agents`、`custom-agents`、`multi-agent-workflows`、`agent-architecture`、`texra-cli`                | 分别改成程序参考、写一个程序、四个编排模式、两类 run、CLI                         |
| harness 的打包示例    | `packages/harness/example/` 的 `07-programmed-path.ts`、`10-external-plugin.ts`、`acme-notes` 用 agent 文件   | 改为插件带程序；R9（随包提供 agent 文件）改为随包提供程序                         |
| 测试                  | 引用 bundled 名字的套件和 golden store（`golden-1.0.sql` 里有一次 `polish` 的 task run）                      | 套件改写或删除，golden store 随 `run.config` 版本一起重生成                       |

## 删除清单

| 删什么                                                                                                        | 行数（量于 `d173e42`） | 留什么                            |
| ------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------- |
| 35 个 bundled agent 文件、lean4 和 multi-agent 的随包目录、bundled skills                                     | 3524 + 1292 + 593      | 12 个程序文件和各插件的 prompt 段 |
| harness：agent 索引、catalog follower、workspace 选择、skills、`AgentBlock` 和 `recipeResult`、persona schema | 约 4500                | 无                                |
| team：预设、启动、CLI、标签页、`apply_team`                                                                   | 1647                   | 无                                |
| agent 设置页（前端和后端）                                                                                    | 1579                   | Plugins 页多一列程序              |
| documents：`task:` 块、Nunjucks、`files:`/`outputs:`、选项表、`rounds`、`document_task`、recipe 源码生成      | 约 1000 of 2271        | 文档工具本身和 `revise`           |
| CLI：`texra agents`、`texra skills`（`team` 已计入上面）                                                      | 363                    | `texra run`                       |
| 新增：`modules`/`programs` 和按名启动、脚本声明里的程序、`revise`、12 个程序文件、目录插件的程序加载          | 约 +900                |                                   |

净减约 1.3 到 1.4 万行，其中约 5400 行是提示词和 skill 文本。新增比
11-06 版少，因为不建工作区解析器、模块入口、task 加载器、Tasks 页和
types 命令。

## 与已有裁决和 PRD 的关系

需要负责人明确改口的六处，本提案不假装它们不存在：

1. **codemode Q8 "No script files"**（2026-10-02）。收窄为：模型写的脚本
   仍不落文件；插件出货的程序是文件，源码和摘要钉在步骤上。recipe 和 goal
   今天就是插件出货的源码，所以这是把已有做法说成规则。
2. **PRD "Agent 文件和 imports"，参数化 prompt。** 原文保留"参数化
   prompt"和"脚本模块"两种组合方式；本提案只留脚本。task 块的 Nunjucks 能
   表达的，一段 JS 都能表达，反之不然。原文把工作区 import 推后，并要求到
   时同时交付相对路径、越界和循环规则；11-06 版把它提前到 1.0，本版**不
   再提前**：内核仍只 import 已启用插件注册的模块，这正是 PRD 1.0 的范
   围。
3. **PRD "Agent 文件和 imports"，agent 文件本身**，以及 R6 的"文件与
   inline 定义一致"、R9 的"插件随包提供 agent 文件"。本提案没有 agent 文
   件也没有 persona；R6 因只剩一种形式而平凡成立，R9 改为随包提供程序，
   示例梯子随之改。
4. **skills 和安装式插件的 agents**（PRD "安装式 manifest"一行）。删掉它
   们失去导入第三方 skill 包和 Claude Code 的 subagent 文件；模型仍能
   `read_file` 用户指给它的任何 Markdown。commands 是按 skill 读的，一起
   失去；MCP 和 hooks 不受影响。
5. **裁决 "Adaptive document workflows are not planned"（2026-09-06）**。
   见"document task 的归宿"末段。
6. **安装式插件带程序**（新）。PRD 的能力矩阵写"安装式 manifest…不承诺原
   生脚本模块"；裁决 D11 写仓库外的插件靠 hooks 和数据扩展，code plugin
   等到有一个具名的插件做不成 MCP 加 hooks 加数据时再建；核心概念的
   Plugin 一行写"不加载第三方代码"。本提案让目录插件带沙箱里的程序：它
   不是原生代码，没有环境权限，效果只经过它的 run 被 offer 的工具，而同
   一个受信插件的 hooks 和 MCP server 今天已经能起本地进程。要负责人确
   认这算 D11 的"数据"多带一种，而不是它推后的 code plugin。

两处比 11-06 版更贴近已有裁决：

- **D9**（"一个开关应该收回一个插件贡献的一切"）原样成立，对象从插件的
  skills 和 agents 换成它的程序。**D10** 的 team 仍然删：它回答的问题随
  目录消失。
- general-package 设计比较过"最小内核，每个内置都是插件"这一案，因 churn
  没选。本提案不搬目录，靠删除让内核变小；`builtins/` 目录那一步仍按原
  裁定等一个具名的 embedder。

不与之冲突的：无流程引擎、历史一个写者、`agent()` 替代 delegation 工具
（Q7）、Q2 的结果复用、Q5 的一次脚本审批、1.0 的 SQL 只读视图、codemode
的关注点分离表、"code mode stays domain-free"、
`RUN-trusted-script-launch-grants` 的否决。

## 更彻底的方案：Unix

比本提案再往前一步就是 Unix：`texra` 是读 stdin 写 stdout 的过滤器，task
是 PATH 上任意语言的可执行文件，工具是 CLI，持久化靠内容寻址的缓存而不是
重放。它撞四面墙：Windows 上没有 shell；1.0 PRD 的 P0 承诺（公开 SDK、故
障点测试、运行所有权、重放）全是进程内契约；沙箱让每个嵌套调用在执行前
过审批并在卡片树里可见，shell 脚本做不到；三个 host 的 UI 全来自 run
history 的行。

"小内核、程序在外面"是从它借来的原则，本提案在 harness 之内兑现它。还可
以单独落的四条：

1. **工具是 CLI，bespoke 工具要有理由。** 一个插件工具只在三种情况下有资
   格存在：需要审批语义、需要写 run history 的行、需要结构化结果供脚本分
   支。其余的（`extract_figures`、`extract_bib_entries`、arxiv、Zotero）变
   成随包的 CLI，模型用 bash 调。这一刀砍的是三万行工具代码里最大的一
   块，也把插件作者的扩展方式改成"写一个程序加一个 CLI"。是负责人问题
   6。
2. **发现靠插件表。** picker 和模型读的是同一张表。
3. **headless 走文本流。** `texra run` 已经输出 NDJSON；再让它从 stdin 读
   文件列表、向 stdout 打产物路径，shell 组合就免费了。
4. **缓存是一等机制。** 把 Q2 的内容寻址复用从 `agent()` 扩到
   `program()`，范围从一个 run 扩到会话：改了 `paper.tex` 一行，重跑整条
   流水线，只有输入变了的步骤真的跑。重放仍负责中断续跑。能安全缓存的前
   提是产物不直接改工作区，而是进 run 存储再由用户 accept，这正是
   documents 今天的设计。

## 权衡

- **确定性对灵活性**：程序钉在 run 上，所以一个程序的行为在运行中不变；
  代价是改了文件要重新启动才生效。这是 PRD 要求的。
- **项目程序每改一次要审阅一次**：信任按内容，所以模型替你改了
  `.texra/programs/x.js`，它从 picker 里消失直到你在 Plugins 页再看一眼。
  11-06 版是每次启动审批一次。这里换成每个版本审批一次：稳定的程序不再
  打扰，改动的程序多一步。
- **不会编程的用户**：YAML 从来没有比十几行带模板字符串的 JS 更容易；384
  行的 YAML 没人读得完。模型代写。
- **换一个口吻聊天**：由 `AGENTS.md` 承担，它是项目级的。按会话切换
  persona（`texra chat --agent research`）消失；要它的人写一个三行程序调
  `agent()`。
- **每次启动的开关**：launch form 的五个开关和对应 flag 消失，变成程序里
  的一行。
- **聊天的 system 文本跟着插件开关变**：开关一个插件会改下一步的 system
  文本。插件的 prompt 段今天就是按步钉住、变化时作为一条更新消息发出，
  机制不变，只是它承担的内容变多。
- **弱模型**：script-only 对 DeepSeek 和 Gemini flash 已验证；更弱的模型
  走 Q3 回退。某个便宜模型在某类论文上确实需要一段 rubric，用户写三行程
  序 import 一段文本就有了，不需要为所有人预留 400 行。
- **可发现性**：35 个名字至少告诉用户 TeXRA 能干什么。缩到十来项后，
  Plugins 页和程序参考页承担这个角色。
- **互操作**：安装式插件的 skills、commands 和 agents 不再加载。
- **破坏范围**：1.0 不保兼容。用户的 custom agent 和 custom team 失效，
  changelog 写迁移路径：agent 变程序或 `AGENTS.md`，team 变插件开关；不
  写 YAML 到 JS 的转换器（AGENTS.md 禁止 legacy reader），由模型对话完
  成。

## 分期

每一期独立可合。顺序按"先让程序进契约，再搬内容，最后删目录"排：负责人
在删 35 个之前先看到 picker 里十来项的样子。

1. **程序进插件契约，一个按名启动**（harness）。`Plugin.modules` 和
   `programs`，specifier 改为 `<插件>:<名字>`，按名启动（run 以生成的两行
   脚本打开），脚本声明里列程序。第一个消费者是 goal：`plan` 工具改用按
   名启动，`goal.strategy` 的值是程序名。无用户可见变化。
2. **documents 搬成程序**。`revise` 原语和 documents 工具的契约变更；程序
   是 `resources/plugins/documents/programs/` 里的文件。先移 `edit` 和
   `annotate`，journey 跑一次作回归；再移剩下六个和 `fix-build`；最后一
   个移完就删 `task:` 块、Nunjucks、选项表、`document_task`、
   `critic.yaml`、`AgentBlock`、`recipeResult` 和它的三个调用者。picker 出
   现程序。
3. **lean4 和随包目录**。`resources/plugins/<id>/` 下的 `agents/` 和
   `skills/` 换成 `programs/`；lean4 的两个程序。
4. **目录插件带程序**。安装式插件的 `programs/`、项目的
   `.texra/programs/`、加载器的约定、信任审阅里列出程序。和第 2、3 期互
   不依赖，可以提前。
5. **script-only 翻默认**。补 Q10 两项，翻；回退标志留。
6. **格式批**（API 冻结前一次）。`AgentConfig` 联合 `chat | program`，
   `run.config` 行版本升、golden store 重生成，`StartRequest` 和 `agent()`
   改签名，`asCaller` 改为复制父 run 的 system 和 tools。
7. **删 agent 文件和补偿层**。agents 目录、agent 索引和 schema、team、
   workspace 选择、skills、customize、三个 CLI 命令；聊天的 system 文本
   改由插件的段拼出；测试套件改写或删；文档和迁移说明。
8. **（可选）工具改 CLI**。先从 `latex-extract` 和 `arxiv` 两个插件试。

第 1 期到第 4 期在格式批之前，过渡期的存法（按名启动在 `run.config` 上
怎么记）在第 1 期的 PR 里定，约束是不为信任另存一份事实。

## 负责人问题

1. **读法对不对。** 本文把"core 小而美，theorist 的 program plugin"读
   成：内核只多认识"插件带程序"并忘掉 agent；程序没有插件之外的家，项目
   自己的程序是一个按路径引用的插件；产品是内核加 theorist 插件。
2. **theorist 插件怎么切。** 按能力（`documents`、`lean4`、往后的文献和
   推导），学科是开着哪些插件加 `AGENTS.md`（推荐）；还是按学科各一个插
   件（physicist、mathematician、computer scientist），各带自己的程序？
3. **名字。** 定为 program：`programs/`、`Plugin.programs`、
   `program('documents:edit')`、`texra run <program>`。11-06 版在 task 和
   recipe 之间没定；`texra tasks` 今天指服务里的运行，不撞。
4. **"小"的口径。** 名词和公开面（本提案）；还是也要物理上拆：把
   harness 的内置插件（memory、executions、MCP、web、plan，约 3900 行）
   搬出内核目录或单独成包？后者在 general-package 设计里已裁定等一个具
   名的 embedder。推荐：先前者。
5. **接受六处改口**（"与已有裁决和 PRD 的关系"）？其中第 6 处是新的。
6. **工具改 CLI**（Unix 一节第 1 条）作为第 8 期？推荐：接受，先试两个插
   件。
7. **第 1 期现在开**，还是等 1.0 PRD 的在途线合完？推荐：现在开，它只碰
   `Plugin` 的两个字段、模块表的命名空间和 `plan` 工具的启动。

## 决定记录

负责人 2026-11-06：

- 模型会变强是设计前提，不是待验证的假设。rubric 和通用领域知识现在就
  删，评测只作回归检查。
- persona 不是单位："import code 更 end to end"。
- 不要 skills。
- 要 fully embrace codemode；document task 是有用的，保留其能力。
- multi-agent 编排要考虑在内。
- 要一个 code 的大一统（"触发"一节）。

负责人 2026-11-14：

- "core 比较小而美，然后有一些 theorists 的 program plugin。"本文按"负
  责人问题"1 的读法重写；读法本身待确认。
- "搞 30 个 agent 让用户选肯定是不行的。"启动面默认是聊天，picker 不列
  agent（"启动面"一节）。
- 文档要对上最新的 `main`：基线和度量取自 `d173e42`。

## 修订记录

**2026-11-14，按小内核和程序插件重写。** 相对 11-06 版：

- 程序的家从三个目录根（`.texra/tasks/`、`~/.texra/tasks/`、插件的
  `tasks/`）改为插件；"三种来源，一个解析器"一节删，内核的模块加载器不
  变。
- `author` 字段和"工作区 task 每次启动审批"删，信任用安装式插件已有的内
  容摘要记录。
- "bundled 的两个 chat"改为"聊天不是一个 agent"：没有 assistant 常量，
  system 文本由插件的段拼出。
- 新增"内核认识什么"和"theorist 的程序插件"两节；Tasks 页、
  `texra tasks types` 和沙箱的 `type: 'module'` 入口不再需要。
- 改口从六处仍是六处：工作区 import 不再提前、team 那一条因 D9 原样成立
  而降级，新增"安装式插件带程序"。
- 度量在 `d173e42` 重量；两处引用已漂移并改正（`needsWake` 现在在
  `FollowUpReader.ts`，`AgentBlock.result` 的调用者是三处）。

**2026-11-06，无上下文审稿后的修正**（仍然成立的部分已并入正文）：goal 用
`self()`，所以 `program` 要有可选的 `conversation` 边；模块钉在步骤的
`tools.offered.modules`，不在 `AgentConfig` 上另开一份；`receive()` 撤
回；联合是格式批，不是第 1 期；`revise` 是 documents 工具的契约变更；发
现期不求值。

## 不做的事

- 不做流程引擎、不做第二个 run history 写者、不做任务调度器。
- 不做第二个程序容器：没有工作区 task 根，没有 `~/.texra/tasks/`，内核不
  读程序目录。
- 不做 persona 或 chat 预设的目录：`Plugin` 上没有"命名的聊天"。
- 不做常驻程序和 `receive()`；事件触发是每事件一次 `start`。
- 不做 npm 包解析、不做远程依赖、不做文件系统路径的 import。
- 不做按程序的输入 schema 或选项表。
- 不做 YAML 到 JS 的兼容转换器。
- 不做编排库；goal 是唯一出货的模式，而它已经在了。
- 不做"聊天也是程序"。
- 不做学科插件，除非负责人问题 2 选了它。

## Verified

在 `d173e42` 上：

- `find packages/extension/resources/agents -name '*.yaml' | wc -l` 得 35，
  共 3524 行；`grep -l '^task:'` 得 15。
- 各目录行数如"现状的度量"表（`wc -l`）；`config/api-reports/*.md` 的
  `Exports:` 行为 36、163、48、134、299、74。
- `packages/harness/src/tools/plugins.ts` 的 `Plugin` 有 13 个字段；
  `scriptModules` 只有 `goal` 和 `documents` 两处；`texraPlugins` 列 19
  个插件。
- `packages/harness/src/agent/codeSandbox/worker.ts`：`setModuleLoader` 按
  `input.modules` 的键查 specifier，别的（含相对路径）拒绝；脚本以
  `type: 'global'` 加函数体包装求值。
- `packages/harness/src/tools/sessionTools.ts`：一步的 `modules` 由开着的
  内置插件的 `scriptModules` 拼成 `builtIn:<name>`；安装式插件不进这张
  表。
- `packages/harness/src/shared/schemas/offeredTools.ts`：模块按 specifier
  钉为 `context.blob` 的摘要。
- `goalScript.ts`：`goalScript()` 两行，`GOAL_MODULE` 是 `self()` 循环；
  `PlanTool.ts` 用 `launchBackgroundScript` 启动它。
- `PromptBuilder.ts`：`buildOpeningSystemPrompt` 把 persona prompt 排在最
  前，其后是 `AGENTS.md`、memories 和工具说明；没有 harness 自己的身份文
  本。带 `prompt` 段的插件是 `memory-workflow`、`core`、`documents`。
- `packages/extension/resources/plugins/<id>/` 按 `Plugin.id` 对上插件；
  `enabledBuiltInRoots` 对关掉的插件略过它的 `agents/`。
- 安装式插件：`PluginManifestSchema` 没有脚本或模块字段；信任是
  `PluginTrust { version, digest }`，`readInstalledPluginLoad` 只加载启用
  且摘要匹配的；记录在用户的全局状态，没有项目级的插件目录。
- 插件开关 `tools.disabled` 在全局状态，没有按 workspace 的开关。
- `isTaskConfig` 和 `recipeBlockOf` 在 `runRecords.ts`，都读
  `script.kind === 'recipe'`；`readRecipeResult` 有三个调用者。
- `documentState.ts` 经 `AgentCatalog` 读 task 块；`documentTools.ts` 的轮
  数取 `docs.task.requests.length`。
- `assistant.yaml` 92 行，列 37 个工具；19 个插件的工具表共 52 个，没
  列的 15 个是 setup 的 8 个、documents 的 `document_context`、
  `document_extract`、`document_compile`、`document_diff`、
  `document_review`、`document_propose` 和 codemode 的 `self`。
- codemode 文档的裁决 Q2、Q3、Q5、Q7、Q8、Q10 和 "code mode stays
  domain-free"；"Still open" 第二轮的评测表。
- 裁决台账的 D6、D9、D10、D11 和 "Adaptive document workflows are not
  planned"；`refuted-candidates.json` 的
  `RUN-trusted-script-launch-grants`。
