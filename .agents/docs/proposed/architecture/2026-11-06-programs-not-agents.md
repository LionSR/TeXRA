---
created: 2026-11-06
status: proposed
---

# 程序，不是 agent：小内核和 theorist 的程序插件

基线：`main` 的 `d173e42`（2026-11-14）。路径相对仓库根。度量用 `wc -l`
和 `grep`，"现状的度量"一节给出可复核的数字。本文是设计的当前状态，不是
讨论的记录；负责人的裁决集中在"决定记录"，2026-11-14 这次改写改了什么、
无上下文审稿后又改了什么，列在"修订记录"。基线之后落地的两处：第 1、2
期的程序（#14968），和从第 5 期提前的 team 删除（2026-11-17，见"分期"和
"修订记录"）；"现状的度量"里 team 的那几行是基线时的数字。

正文里的"今天"和各处度量说的是基线 `d173e42`。此后第 1、2、6 期已随
#14968 落地（2026-11-17 对照 `c78e9f9` 的源码核对过，逐项见"分期"）；第
3、4、5 期没有动，第 7 期等"负责人问题"2。

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

- **程序住在插件里。** 工具今天就只住在插件里；程序也住进去。`Plugin`
  上的 `agentBlock` 换成 `programs`，`scriptModules` 原样，契约不变大。
- **内核少认识一类事。** 核心概念的十三个名词里，Agent 换成 Program。
  agent 文件、persona、catalog、team、task 块、recipe 这些词从内核消
  失。
- **产品是内核加一个 `theory` 插件。** theorist 的东西总体是一个插件
  （负责人 2026-11-14）：八个内置程序、它们调用的步骤工具和 theorist 的
  那段文本。Lean 有外部依赖，是单独的插件，带它自己的两个程序。"AI
  theorist"不是 `assistant.yaml`，也不是一个 team。聊天是内核的模型循
  环，没有 agent 文件。
- **内置程序是起点，不是边界。** 模型应该自由地 generalize（负责人
  2026-11-14）：它能读内置程序的源码，用同样的积木写自己的程序并启动
  它。
- **程序是 workflow，视角是 hint。** `logic` 和 `notation` 不是独立的东
  西：workflow 在了，它们只是传给它的一两句话。没有 `--hint`，没有 hint
  表，让模型 free style（负责人 2026-11-14）。
- **入口 agent 只有一个，用户不能改它**（负责人 2026-11-14）。让人在三
  十个 agent 里选是不行的。不选任何东西就能开始；用户最常用的入口
  （launch form）里只有它，不列内置程序。它的基础文本和声明的工具是 app
  的常量，没有 customize、没有 custom agent、没有 `--agent`。
- **code mode 现在就可以开，不把所有工具摆给模型**（负责人
  2026-11-14）。模型拿到的只有 `script` 一个工具；脚本的描述里只声明一个小核心，其余开
  着的工具能调，靠 `searchTools` 找。

这不是一个新方向。仓库里已经有三处"run 是一段程序"：goal 策略是插件出货
的一个脚本模块（`packages/harness/src/tools/plan/goalScript.ts`），
document task 的 recipe 是 app 生成的一段内联 JS
（`packages/texra/src/agent/output/documentRecipe.ts`），后台脚本是
`AgentConfig.script.kind: 'background'`。本提案把第二处变成第一处的样
子：recipe 是插件出货的模块，按名启动。

## 现状的度量（`d173e42`）

| 事实                                            | 数字                                   | 来源                                                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bundled agent 文件                              | 35（顶层 33，`write/` 2），3524 行     | `find packages/extension/resources/agents -name '*.yaml'`                                                                                                                      |
| 其中 document task（带 `task:` 块）             | 15，工具全 0，轮数 1 或 2              | `grep -l '^task:'`；`correct`、`apply`、`merge` 一轮，其余两轮                                                                                                                 |
| 插件随包目录                                    | lean4 987 行，multi-agent 305 行       | `packages/extension/resources/plugins/`：lean4 是 5 个 agent（609 行）加 5 个 skill，multi-agent 是 1 个 skill                                                                 |
| bundled skills                                  | 9 个 `SKILL.md`，目录 593 行           | `packages/extension/resources/skills/`                                                                                                                                         |
| team：预设、启动、CLI、标签页、`apply_team`     | 1647 行（8 个文件）                    | `agentTeams.ts`、`agent/teams/`、`teamCatalogPorts.ts`、`packages/cli/src/commands/team.ts`、`cliTeams.ts`、`TeamsTab.ts`、`ApplyTeamTool.ts`                                  |
| workspace 选择和 agent 设置页                   | 618 + 890 + 689 行                     | harness `agent/workspaceAgents/` 和它的 schema；设置页前端的 Agents、Skills 标签页、选择面板和 newer-built-in 提示；后端 `settingsAgentCommands.ts` 和 catalog 控制器          |
| agent 索引（扫描、customize 副本、插件 agent）  | 1549 + 264 行                          | `packages/harness/src/agent/index/`、`tools/agentCatalogFollower.ts`                                                                                                           |
| skills 子系统                                   | 1447 + 107 + 92 行                     | `packages/harness/src/skills/`、三个 skill schema、`packages/cli/src/commands/skills.ts`                                                                                       |
| documents 插件（工具、recipe、task 块、选项表） | 2271 行                                | `packages/texra/src/tools/documents/` 1837、`documentRecipe.ts` 164、`packages/texra/src/shared/plugins/documents.ts` 270                                                      |
| 插件；工具                                      | 19 个（harness 内置 6，app 13）；52 个 | `harnessBuiltins`（`packages/harness/src/tools/builtinPlugins.ts`）、`texraPlugins`（`packages/texra/src/tools/registry.ts`）；两个包的 `src` 里 `grep 'defineTool({'` 也得 52 |
| `assistant.yaml` 列的工具                       | 52 个里的 37 个                        | 没列的 15 个：setup 的 8 个、documents 的六个步骤工具、`self`                                                                                                                  |
| `Plugin` 的字段                                 | 13                                     | `packages/harness/src/tools/plugins.ts`                                                                                                                                        |
| 带 `scriptModules` 的插件；带 `prompt` 段的插件 | 2（goal、documents）；3                | `grep scriptModules`；`memory-workflow`、`core`、`documents`                                                                                                                   |
| 读"这个 run 是不是 task"的地方                  | 22 个源文件                            | `isTaskConfig`、`recipeBlockOf`、`script.kind`（`packages/harness/src/shared/schemas/runRecords.ts`），含定义和再导出；视图上另有一份 `RunView.recipe`                         |
| harness 公开导出                                | 754：root 36、host 163、node 48、其余  | `config/api-reports/*.md` 的 `Exports:` 行（plugins 134、schemas 299、transcript 74）                                                                                          |
| harness、app 源码                               | 80570、81378 行                        | `packages/{harness,texra}/src` 的 `.ts`                                                                                                                                        |
| 工具代码                                        | 31505 行                               | `packages/texra/src/tools` 19003，`packages/harness/src/tools` 12502                                                                                                           |

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

把 2 和 3 塞进 1，目录就必然按"视角 × 流程"的积膨胀。两种只加批注的视角
乘一种流程是两个文件；再来一种流程就是四个。

**第二处：程序没有家。** 工具只有一个家，插件：每个工具属于恰好一个插
件，名字全表唯一。程序没有，所以每处"run 是程序"都自己找地方：goal 在插
件的 `scriptModules` 里，再由 `plan` 工具拼两行脚本启动；document 的
recipe 由 app 按 agent 名生成源码，挂到 agent 文件的 `task:` 块上，经
`Plugin.agentBlock` 让内核认得；后台脚本写在模型的调用里。11-06 版为程序
新建了一个家（三个目录根加一个解析器），它要的东西插件大多已经有：

| 程序需要的       | 11-06 版新建的                               | 插件今天有的                                         |
| ---------------- | -------------------------------------------- | ---------------------------------------------------- |
| 放在哪           | `.texra/tasks/`、`~/.texra/tasks/`、`tasks/` | `Plugin.scriptModules`：源码按名字，`builtIn:<name>` |
| 按名字找到它     | 三种来源的解析器，撞名是扫描期错误           | 插件表（`toolTable`）：模块名全表唯一，建表时检查    |
| 能不能信         | `author` 字段，工作区的每次启动审批          | 原生插件随应用出货；安装式插件有按内容摘要的信任记录 |
| 对模型说它是什么 | `export const description` 静态提取          | 插件表里的数据（工具的描述就是这样来的）             |
| 人在哪里看见它   | 新的 Tasks 页、`texra tasks types`           | Plugins 页和 `/plugins`：一个插件一张卡片            |
| 关掉它           | 无（文件在就在）                             | 有开关的插件随开关收回它贡献的一切（裁决 D9）        |

内核今天认识 app 的词汇，是同一个病的另一面。核心概念的十三个名词
（`.agents/docs/implemented/architecture/2026-09-26-core-concepts.md`）
里有 **Agent**："从一个有序的来源目录解析出的定义"。`AgentConfig` 上为它
有 `agent`、`agentSource`、`persona`、`asCaller`、`delegationAgentScope`
五个字段，`Plugin` 上为它有 `agentBlock`，harness 里为它有索引和
workspace 选择两个目录共 2123 行。

反过来看已经做对的部分：

- 沙箱的模块加载器只认宿主给的那张表，没有文件系统
  （`packages/harness/src/agent/codeSandbox/worker.ts`）；模块之间的静态
  `import` 走同一个加载器（在装着的 QuickJS 包装上试过）。
- `assistant.yaml` 的 prompt（文件 42 到 92 行）本身就是按能力分段写的
  （Literature、Computation、Formal Proofs、Document Toolkit、各工具的用
  法），并且要为可能没开的插件写"when available"。它是手工拼出来的"各
  插件的 prompt 段"；而 `Plugin.prompt` 这个字段已经存在，有三个插件在
  用。
- `assistant.yaml` 的工具表是 52 个工具里的 37 个，没列的 15 个恰好是只
  属于某个程序或某次对话的那些。默认集合可以推出来，不用抄。
- `script` 的描述今天就分两层：声明的工具内联成 TypeScript 声明，其余能
  调的靠 `searchTools` 找（"more are callable: `searchTools` finds
  them"）；script-only 打开时请求里只发 `script`
  （`packages/harness/src/agent/runtime/agentToolResolution.ts` 的
  `sent`）。"不把所有工具摆给模型"的机器已经在了。
- codemode 的裁决里已经有一条"code mode stays domain-free"。

缺的只是：**把"插件带程序"当成唯一的路，让内核忘掉 agent。**

## 长期判断

前提（负责人裁决，见"决定记录"）：模型会变强。由此，价值从"对模型说什么"
转到四件事：验证器（编译、diff、测试、texcount、文献 API）、持久的编排（长
goal、恢复、预算、并行）、积累下来的程序、以及可观测和可审批的执行。提示
词趋近于零；凡是提示词里教模型"按步骤做"的部分，都应该是一段步骤被验证
过的程序。

因此 TeXRA 分两层看：

- **内核**是一个持久执行程序的 harness，程序的操作是模型调用和工具调
  用，历史是真相。1.0 PRD 的第二段已经这么说了："内核维护调用、权限、资
  源和持久化契约；goal、研究流程和领域策略由脚本及插件表达"。
- **产品**是内核加一个 `theory` 插件。一个 theorist 的做法（改稿、审
  稿、形式化）是带验证器的程序，住在它里面。

三年尺度上要守住的不变量：

- **历史一个写者，run loop 一个程序**（AGENTS.md "Agent system"）。程序
  是 `script` 调用的 guest，不是第二个引擎。
- **持久化不随代码变**：钉住的源码和摘要是 run 的一部分；改了程序不改正
  在跑的 run，恢复用原源码。
- **一个 fact 一个 owner**：一个程序是谁的，由插件表回答（每个程序名属
  于恰好一个插件，和工具一样），审批和信任从它推导，不另存一份。

## 设计

### 两层

```
内核      @texra-ai/harness、@texra-ai/llm   持久地跑程序；认识 run、call、tool、program、plugin
theory    @texra-ai/texra 的一个插件         八个内置程序、它们的步骤工具、theorist 的那段文本
lean4     单独的插件                         Lean 的工具和两个内置程序；没装 Lean 就整个不出现
host      extension、desktop、cli            三个壳
```

内核对 theorist 一无所知：它不认识 document、LaTeX、审稿、Lean，也不认
识"内置的 task 目录"。`theory` 和工具插件只通过 `Plugin` 这一个契约进
入内核，和一个仓库外的 embedder 写插件用的是同一个契约。

### 内核认识什么

| 核心概念    | 今天                                                                          | 之后                                                            |
| ----------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Agent       | 从有序的来源目录解析出的定义：built-in、custom、插件、inline                  | 删。换成 **Program**：插件登记的、可以按名启动的沙箱模块        |
| Plugin      | 工具、prompt 段、layer、探测、开关、fact、一个 agent 文件块                   | 同左，agent 文件块换成程序表                                    |
| Composition | 钉住的目录按 agent 的工具声明收窄                                             | 钉住的目录按 run 的工具列表收窄                                 |
| Run         | 以一份 agent 定义打开                                                         | 以一组 chat 参数或一个程序打开                                  |
| Input       | 每条给 run 的消息                                                             | 不动；订阅通知多一种去处（host 以事件启动一个程序，"触发"一节） |
| 其余八个    | Process、Session、History、Projection、Call、Request、Host、Application state | 不动                                                            |

之后内核里不再出现的词：agent 文件、persona、agent source、catalog、
customize 副本、team、delegation scope、workspace 选择、task 块、
recipe。skill 这个词留着：安装式插件带来的 skill 还要内核加载。

"小"指内核认识的东西少，不指代码行数少（负责人 2026-11-14 选了这个口
径）。之后内核只管四件事：把一个 run 持久地跑下去（历史、恢复、停
止），调模型，调工具（审批、重放），跑插件登记的程序。什么是 document、
LaTeX、审稿、Lean，什么是 agent 文件和 team，内核一概不知道；这些只出
现在插件里。代码上，本提案从 harness 拿走约 2800 行只为 agent 目录服务
的东西，和 `./host` 入口上为它们设的导出。持久化协议那一大块不动，把
内置插件搬出内核目录也不在本提案里。

内核要改的地方不多，全部列在这里，后面各节展开：

1. `Plugin.agentBlock` 换成 `Plugin.programs`。
2. `AgentConfig.script` 的 `recipe` 成员换成按名的 `program` 成员（一次存
   法变更），run 以一段生成的两行脚本打开。
3. 一个 `program` 工具替掉 `document_task` 和 `ITool.launchesTasks`；脚本
   声明里列出程序。
4. 沙箱：给模块加载器一个明确的 normalizer；脚本失败时保留模块里的帧。
5. 删 agent 那一期：`chat` 的参数直接在 config 上（第二次存法变更）；根
   聊天能调的是开着的全部，声明的是一张短表。
6. code mode 默认打开：TeXRA 的 catalog 把 `codeMode.scriptOnly` 默认设
   成开，保留直接调用的模型把它读成关。

### 插件契约

`Plugin`（`packages/harness/src/tools/plugins.ts`）13 个字段，换一个：

```ts
interface Plugin {
  // id、tools、availability、toggle、injectedWhen、prompt、processLayer、
  // sessionLayer、decision、factKinds、scriptModules、requires：不变

  /** 它的 scriptModules 里可以被人或模型按名启动的那些（默认导出是
   *  async (args) => result）。今天的 agentBlock 的位置。 */
  readonly programs?: Readonly<
    Record<
      string,
      {
        /** 一行，picker 和模型的脚本声明里显示。 */
        readonly description: string;
        /** 它的 run 被 offer 的工具，按名字。 */
        readonly tools: readonly string[];
      }
    >
  >;
}
```

`theory` 插件登记出来是这样：

```ts
const theory: TexraPlugin = {
  id: 'theory',
  requires: ['multi-agent', 'codemode'],
  scriptModules: { revise: REVISE, edit: EDIT, annotate: ANNOTATE /* … */ },
  programs: {
    edit: { description: 'Rewrite the documents as instructed.', tools: STEPS },
    annotate: {
      description: 'Add \\criticize{} comments; never rewrites.',
      tools: STEPS,
    },
    // …
  },
  // 今天 documents 插件的步骤工具和它的 fact
  tools: [DocumentContextTool /* … */],
  factKinds: DOCUMENT_FACTS,
};
```

- **程序名和工具名一个规矩。** 原生插件的程序名全表唯一（`edit`、
  `annotate`、`prove`），建表时检查，所以 `texra run edit --input paper.tex` 不
  带前缀；模块的 specifier 仍是 `builtIn:<name>`。`scriptModules` 这个字段
  和它的命名空间都不改，`goal.strategy` 的取值和模型今天写的
  `import('builtIn:goal')` 也就不变。
- **工具由程序列出。** 今天 recipe 的 run 被 offer 的就是一张固定的表
  （`DOCUMENT_TASK_TOOLS`：`agent` 加六个步骤工具），存在 `script.tools`
  里。这张表留在程序的登记上。不从"开着的全部"推：工具面一宽，每个 run
  要为每个工具存一份定义，一步还会把它 offer 的每个插件的服务都拉起来
  （`packages/harness/src/agent/runtime/loop/step.ts`），一次改稿不该启动
  Lean 的进程池。原生插件的程序列出的工具不看开关，这是今天 task 的规
  则。
- **描述和工具是表里的数据。** 不为发现而求值任何源码，也不从源码里提取。
- **源码是真实的文件。** 一个程序是插件源码目录里的一个 `.js` 文件（如
  `packages/texra/src/tools/theory/programs/annotate.js`），构建时作为
  文本打进插件值；沙箱 worker 的源码今天就是这样进包的
  （`virtual:code-sandbox-worker`）。今天的 `GOAL_MODULE`、
  `DOCUMENTS_MODULE` 和 `recipeSource()` 是 TS 里的模板字符串，没有 lint、
  没有高亮，常量靠 `JSON.stringify` 拼进源码。不从 `resources/` 运行时
  读：`texraPlugins()` 是一张同步的值的表，没打包的 host 也没有那个目
  录。
- `agentBlock` 连同 `AgentBlock`、`boundFiles`、`boundFile`、
  `agentBlockOf`、`ToolTable.blocks` 和 `ITool.launchesTasks` 删。
  `AgentBlock.result`（一个 task 的结果怎么读给启动它的人）先原样挪到程
  序的登记上，能不能删见"结果怎么被读"。
- **工具定义上换一个事实。** `launchesTasks` 删；换成"这个工具默认不开
  放，只有点名它的程序或启动拿得到"。六个步骤工具是这样（内置程序列了
  就有，模型写的程序要了就有；它们读的是程序 run 自己的状态，今天在
  task 之外调用会被拒绝），setup 的八个也是这样（由 setup 命令在启动那
  次对话时点名）。

### 一个程序是什么

```js
// packages/texra/src/tools/theory/programs/annotate.js
import { revise, addsOnly, ANNOTATE_FORMAT } from 'builtIn:revise';

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
  launch form 的字段：四组文件、`editedFile`、`baseFile`、`commit` 和指令
  （`LaunchSurfaceSchema`，
  `packages/texra/src/shared/session/surface.ts`）；`merge` 靠
  `editedFile`。没有按程序的输入 schema。由事件触发的程序从 `args.event`
  拿到事件。
- **文件字段留在 config 上。** 四组文件今天就在 `run.config` 上
  （`NullableFileFieldsSchema`），documents 的工具从那里读它们和
  memories、指令；这不变，`args` 里的文件就是它们。文件在启动边界校验
  （存在、符号链接、是不是调用者读得到的 run 存储），和今天
  `document_task` 的输入一样（`resolveInvocationFileList`），模型传进来
  的路径不因为程序受信就免检。
- **import。** 加载器不变：宿主给的就加载，别的拒绝并列出可用的名字。要
  补一个明确的 normalizer：今天没给，QuickJS 默认的那个会先改写相对
  specifier 再查表（脚本里 `import('./builtIn:goal')` 能加载到
  `builtIn:goal`）。1.0 里相对 specifier 一律拒绝。
- **启动只有一条路。** `script: { kind: 'program', name, args }`，run 以
  一段生成的两行脚本打开：import 这个模块，调用它的默认导出。这和
  `goalScript()` 今天生成的是同一种东西（它调的是具名导出 `goal`），所
  以脚本的行和重放都不变。今天 recipe 的三个入口（launch form 和
  `texra run` 的 `documentTaskPatch`、merge 动作的 `documentTaskConfig`、
  模型的 `document_task`）都变成它。
- **启动选项不在这个成员里。** 模型、超时、标题、等不等、复用 id、审批方
  式今天就是调用字段和 `StartOptions`，照旧。
- **钉住。** 一步能 import 的模块，源码按 specifier 存为 `context.blob`，
  摘要写进这一步的 `tools.offered.modules`
  （`packages/harness/src/shared/schemas/offeredTools.ts`）。恢复用钉住的
  源码。成本：今天是两个小模块，之后是十几个小模块，每个带 `script` 的
  步骤都钉、脚本的描述里都列。所以模块表只放代码；模板这类大文本仍是
  documents 工具自己读的数据，不进模块表。
- **错误要能定位。** `script` 工具今天只留栈里含 `script.js` 的帧
  （`packages/harness/src/tools/codemode/ScriptTool.ts`），模块里抛的错
  没有位置，模块的语法错没有文件名。程序的代码都在模块里，这要改。
- **没有按程序的选项。** `reflect`、`attachTeXCount` 这类开关是程序里的
  一行 `if`；真需要一个开关的地方是第二个程序。launch form 的五个开关和
  `texra run` 的对应 flag 随之消失，这是明说的损失（"权衡"）。
- **一个程序的 run 会结束。** 它不接后续消息、不能 fork、不压缩，今天的
  task 也是这样。要让人接着聊的东西不是程序，是一次聊天。

goal 用的是同一个机制，但不是登记的程序：它是一个脚本模块
（`builtIn:goal`），由 `plan` 工具作为对话的后台脚本启动，带着自己的启
动选项（不等、24 小时上限、用户批准 plan 时给的授权、对话的工具、一次只
有一个）。这条路径不改。

### 原语：一个 `start`，三个糖，一个收件箱

控制面和能力面分开。能力面是工具，永远开放：新能力是一个新工具或 PATH
上的一个 CLI，不碰控制面。控制面要完备，而且要小：

```
start(config)      生成一个子 run；await 它就是 wait。config 是 run 配置本身
tools.*            效果
import             复用
```

`agent(prompt, { system, tools, model })`、`program(what, args)` 和
`self(prompt, { fork })` 是 `start` 的三个糖：`agent` 是 `start` 一个 chat
叶子，`program` 是 `start` 一个程序（`what` 是内置程序的名字，或者模型现
写的 `{ code, tools }`），`self` 是 `start` 一个 chat 叶子并取调用者的
system 和 tools、可选复制对话。脚本里的 `start`、SDK 的
`session.start`、launch form 和 `texra run` 发的是同一份 run 配置，各入
口再带自己的启动选项。

`agent` 和 `program` 都是工具（今天 `agent` 在 `multi-agent` 插件里），
列了才有：一个只读审稿的子运行是 `agent(p, { tools: READ_ONLY })`，它拿
不到 `program`，也就启动不了 `edit`。`agent()` 不给 `tools` 就是没有工
具，和今天不写 `tools:` 的 persona 一样；`revise` 靠这一点让改稿的那次
模型调用只出文本。

一个 run 被 offer 的是它自己的定义和启动所声明的，不受启动它的 run 的工
具限制（裁决 2026-10-24）；子运行能拿一个工具做什么归审批策略管。

收件箱是唯一的通道：用户文本、子 run 的报告、同级消息、订阅通知都是它里
面的一条消息（`packages/harness/src/agent/followUp/`）。一个程序**不读**
自己的收件箱（"触发"一节说为什么），它从 args 拿到触发它的事件。

JS 图灵完备，加上 `start` 和 `await`，能表达任何可计算的编排：顺序、分
支、循环、递归、fan-out、监督循环、辩论、人在回路。Unix 的对照：`start`
是 fork 加 exec，`await` 是 wait，收件箱是 pipe，插件表是 PATH，args 和
返回值加 run 存储是 stdin 和 stdout，`AGENTS.md` 是 env。

诚实的缺口：没有时间触发（需要一个让 host 到点发消息的 `schedule` 工具，
今天只有 GitHub 订阅）；程序把控制权交给人没有原语（结束并返回结果，host
决定下一步，goal 的 `needs_user` 就是这样）；上下文只有 fork 整个对话或
fresh 两档。

### run 的两类

`AgentConfigSchema`（`packages/harness/src/shared/schemas/agentConfig.ts`）
今天是"persona 可选，script 可选，两种 script kind"。目标形态是一个联合：

```
run.chat     { system, tools, model, temperature, instruction, files…, memories,
               outputSchema, workingDirectory }                  内核的模型循环
run.program  { name, args, model, files… }                      登记的程序，按名
             { code, title, tools, timeoutMs, model }           模型写的程序
```

- 按名的程序和内联的代码是 `program` 的两种写法，差别就是"谁写的"：有
  名字的是那个插件的，内联的是模型的。内联的今天只有一种启动法（送后
  台，结果作为 follow-up 回来）；之后它和按名的一样，脚本里默认等它结
  束。所以不需要 `author` 字段，
  `recipe.block` 和 `recipe.options` 随 `task:` 块删。两种都要 `model`：
  每个 run 都绑定一个，程序里的 `agent()` 默认用它。
- `self()` 的 fork 需要一个对话：从聊天里启动的脚本记着它的来源，fork 复
  制的是那个对话。从 picker 或 CLI 启动的程序没有对话可 fork，`self()`
  在里面只能 `fork: false`
  （`packages/harness/src/tools/codemode/SelfTool.ts` 今天的规则）。
- `chat` 的字段就是今天 `InlinePersonaSchema` 加 `AgentConfig` 上已有的
  几项，直接放在 config 上：没有 `persona` 子对象、没有 `agent` 名、没有
  `agentSource`。`agent()` 的输入去掉 `agentName` 和 `persona`，直接取
  `system`、`tools`、`model`；`asCaller` 变成"复制父运行的 system 和
  tools"。
- 聊天本身仍是内核原生的模型轮次。"一切都是程序"（聊天循环也是 guest 脚
  本）与 run loop 唯一写者的契约冲突，不做。

存法分两次变，各自落在需要它的那一期：`script` 的 `recipe` 成员换成
`program` 成员、`documents` 这个插件 id 并进 `theory`（它写在 fact 行和
offer 记录里）在第 1 期，`chat` 去掉 persona 和 agent 名在删 agent 文件的
那一期。每次都升 `run.config` 的行版本
（`packages/harness/src/shared/schemas/rowVersions.ts`）并重生成 golden
store。

今天 22 个源文件读"这个 run 是不是 task"，它们其实在问三件事，替代各不
相同：

- **受不受信**：run 是以一个登记的程序打开的，信任随它的插件（"审批、重
  放与信任"）。一个事实，仍从 `run.config` 读，不另存授权记录，和已否决
  的候选 `RUN-trusted-script-launch-grants` 一致。
- **是什么形状的 run**：一个会结束的脚本 run（不接后续、不 fork、花费含
  子运行、从行恢复）。这对按名的和内联的都成立。
- **用哪个插件的界面**：视图上的 `recipe` 换成程序名；documents 的界面
  （diff、accept、Pass N of M）认 run 上有没有 documents 的 fact，不认名
  字，这样包了一层的程序照样有界面。

### 入口只有一个 agent

入口 agent 只有一个，用户不能改它（负责人 2026-11-14）。它不是一个 agent
文件，也不在任何目录里：它是内核的模型循环，加上 `theory` 的基础文本和
开着的插件。

用户改不了的：它的基础文本、它声明的核心、它是唯一的入口。没有
customize 副本，没有 custom agent，没有 `--agent`，设置里没有它的 prompt
或工具表，也没有第二个可选的入口。用户能给的是三样，都不替换它：项目的
`AGENTS.md`（项目的约定，附在基础文本后面）、指令、插件的开关。SDK 的
embedder 可以给自己的 `system` 和 `tools`，那是另一个应用的入口，不是
TeXRA 用户的旋钮。

它由这几样拼成：

- **system 文本** = 基础文本、`AGENTS.md`、附上的 memories、harness 自己
  的工具使用说明和 workspace 信息，然后按步：工具调用方式那一段、每个开
  着的插件的 `prompt` 段（按插件 id 排）。除第一项外都是
  `buildOpeningSystemPrompt` 和 `stepInstructions`
  （`packages/harness/src/agent/prompt/PromptBuilder.ts`）今天就在拼的；
  消失的是"Available agents"这一段（`delegationSection`）；skills 列表
  留着，列的是安装式插件带来的 skill。
  第一项今天是 persona prompt，之后是 `theory` 的那段基础文本，40 行以内
  （你在哪、什么时候写脚本、什么时候启动一个程序），它是 app 的，不是内
  核的。host 把它作为根聊天的 `system` 传入；插件的 `prompt` 段按插件
  id 排，放不到最前面。`assistant.yaml` 里各能力的那几句搬到各自插件的
  段里，插件没开就没有那几句，不必再写"when available"。
- **模型拿到的只有 `script`。** code mode 默认打开：一次聊天的请求里只
  发 `script` 这一个工具，别的都从脚本里调。这是
  `codeMode.scriptOnly`：harness 那一行默认关，TeXRA 的 catalog 把它设成
  开（#14968）。
- **能调的** = 开着的插件默认开放的工具，按步解析，config 里不抄表。今
  天 `assistant.yaml` 抄的 37 个就是这个集合：52 个工具去掉 setup 的 8
  个、六个步骤工具和 `self`。那 15 个默认不开放，只有点名它的程序或启动
  拿得到。dispatch 只跑被 offer 的工具，这条规矩不变。
- **声明的只是一个小核心。** 不把所有工具摆给模型。脚本的描述里内联的
  是声明的那些；其余能调的靠 `searchTools(query)` 找、`describeTool(name)`
  读全，MCP 和插件注入的工具今天已经是这样。入口 agent 声明的是 app 的
  一张短表（文件和 shell 的六个，加 `agent` 和 `program`），和基础文本一
  样是 app 的常量。工具插件的工具不声明：各插件的 prompt 段用一两句说
  它有什么，模型用到时去找。
- **"开着就能调"成为默认。** 今天"没列也给"要插件逐个工具用
  `injectedWhen` 声明；之后这是每个默认开放的工具的默认，`injectedWhen`
  只剩"跟着一个设置"的用途。
- **MCP。** 用户在 `~/.texra/mcp.json` 里配的 server 今天要 agent 的
  `tools:` 点名 `mcp__<server>__*` 才进 run。没有 agent 文件之后，配了就
  能调、能被搜到：配置它就是同意。它的工具不声明，所以配十个 server 也
  不往每次请求里加东西。
- **可启动的程序** = 开着的插件的 `programs`，名字和描述随 `program` 的
  声明内联在脚本的描述里
  （`packages/harness/src/tools/codemode/declarations.ts` 加一段）。十
  行。

审稿、搜索、写代码不是目录项，也不是别的入口：是这个 agent 在脚本里用
不同的 `system` 字面量调 `agent()`，那些子运行不是入口。headless 的一次
性聊天是 `texra run chat --print`。

今天有两处由 host 按名字启动另一个 agent。之后它们也是这同一个入口
agent，host 替用户发第一条指令，人接着聊：

- `setup`：setup 命令发第一条指令，并在这次启动里点名 setup 插件的八个
  工具；setup 的做法写在它自己的 prompt 段里，有它的工具才出现。删掉问
  学科选 team 的一段。
- 编译失败后的修复（今天的 `latexFixer`，`compileFixer.ts` 的
  `planCompileFixer` 以 `script: null` 启动它）：host 把失败的日志和文件
  写成第一条指令。

code mode 现在就可以开（负责人 2026-11-14）：不等 journey，
`codeMode.scriptOnly` 的默认值翻成开，开关留着当关的那一侧。这取代了
codemode Q10 定的线（五晚的合并窗口）。已有的数据是三个 journey、两个模
型、每组 7 到 9 次：通过率持平，每次成功的成本低 18% 和 66%（codemode
文档 "Still open" 第二轮）；那些 journey 用的是六到八个工具、全部声明的
小 agent。

翻默认值是单独的一处改动，但不止改一个默认值。在 `d173e42` 上直接把
harness 那一行的默认值改成开：非 crash 的套件 248 个文件里 4 个失败（585
个测试里 5 个：`hooks.vitest.ts`、`sessionPrograms.vitest.ts`、
`AgentLaunchActivation.vitest.ts`、`sessionStore.vitest.ts`），crash 重放
7 个文件全部失败（9 个测试里 8 个）。原因是同一个：validation model 的对
话是按直接调工具写的，默认值一翻，它的每个直接调用都被拒绝。CLI 的
validation 脚本和桌面 e2e 跑的也是这个模型。

所以这一处改动由四件事组成，四件都已随 #14968 落地（`texraSettings.ts`
的 `defaults`、`ModelAccess.ts` 的 `keepsDirectToolCalls`、`AgentsTab.ts`
里的那一行、`packages/cli/scripts/validate-journeys.mjs` 的 `--direct`）：

1. **默认值放在 TeXRA 的 catalog 里**（`settingsCatalog` 的
   `defaults`），harness 那一行仍然是关。code mode 默认开是产品的决定，
   embedder 的 agent 照旧拿到它声明的工具。要 SDK 也默认开，把这一行挪
   到 harness 的行上。
2. **保留直接调用的模型把这个设置读成关。** 这就是 Q3 的按模型回退，
   codemode 文档把它的位置定在 `BoundModel` 旁边。第一个、目前也是唯一
   的成员是 validation model，于是夹具、crash 重放和 validation 脚本一
   行不用改。真实模型一个都没列：还没有哪个被量出不达标。
3. **开关在每个 host 都够得着。** 它今天只在 CLI 的 `/config` 里。默认
   开之后扩展和桌面版的用户必须能关，所以设置页 Agents 的 Advanced 里
   加这一行。
4. **journey 脚本默认跑 `only` 那一组**，`--direct` 取代
   `--script-only`，否则两组跑的是同一件事。

原来排在翻之前的三件事，改成翻之后补，三件都还没做：

1. 按 Q10 补 glm 和 fan-out journey。
2. 加一个整套聊天的 journey，其中要用的工具没有声明，得靠搜索找到。"只
   声明小核心"是否成立看它。
3. 给 Q3 的回退列真实模型。机制随翻默认值一起建，名单是空的。有数据之
   前，写不好脚本的模型靠用户把 `codeMode.scriptOnly` 关掉。走回退的模
   型没有脚本可搜，能调的工具要全部发给它，和今天一样。

### theorist 的程序插件

theorist 的东西总体是一个插件，叫 `theory`（负责人 2026-11-14："就一个
theory""总体是个插件"）。它带三样：八个内置程序，这些程序调用的步骤工
具和它们的 fact（今天的 `documents` 插件并进来），和 theorist 的那段基
础文本。Lean 是单独的插件（负责人同日："lean 也是个单独的插件好
了"），带它自己的两个程序。

| 插件     | 内置程序                                                                          | 今天的来源                  | 程序用到的工具                |
| -------- | --------------------------------------------------------------------------------- | --------------------------- | ----------------------------- |
| `theory` | `edit`、`annotate`、`enhance`、`apply`、`merge`、`transcribe`、`slides`、`poster` | 15 个 task 文件、`critic`   | 它自己的六个步骤工具、`agent` |
| `lean4`  | `prove`、`blueprint`                                                              | 它的 5 个 agent、5 个 skill | 它自己的 `lean_*`、`agent`    |

十个内置程序，两个插件。分法只看一件事：有没有自己的外部依赖。

- `documents` 并进 `theory`：它的步骤工具只为这些程序存在，一个只给另
  一个插件的程序供工具的插件是一道没有内容的隔断。
- Lean 单独：它要装 Lean，有自己的依赖探测和语言服务，而一个插件只有
  一个探测。程序跟着工具放在 `lean4` 里，探测没过时工具和程序一起不出
  现，不需要"某个程序的工具缺了"这种跨插件的判断。`lean4` 今天就有卡
  片。
- arxiv、zotero、wolfram 这些工具插件原样，它们的工具聊天直接能调；
  `goal` 的策略模块照旧由 `plan` 启动。

为什么不按学科切：物理、数学、CS 的 theorist 都要改稿，同一个程序会有
三个家。学科的约定写在项目的 `AGENTS.md` 里，它本来就是按项目的。也不
把 `theory` 的八个再按能力拆开：拆开之后程序散在几处，theorist 自己的
那段文本没有家。产品就是内核加 `theory`；把它从插件表里拿掉，剩下的是
一个通用的 harness，带文件、shell、web 和几个工具插件。

其余的 bundled agent 不变成程序：`research`、`numerics`、`prover`、
`search`、`review`、`presenter`、`simplifier`、`progressCheck`、四个写代
码的、三个编排的和 `latexDiff`，差别是工作方式的描述，不是流程，随"模
型会变强"直接变成 `agent()` 的一行参数。`creator` 不保留。TeXRA 自己随
应用出货的 skill（9 个 bundled 的、lean4 的 5 个、multi-agent 的 1 个）
删，这是 11-06 的"不要 skills"；安装式插件带来的 skill 照旧加载（负责人
2026-11-14）。TeXRA 特有的约定（`\criticize{}` 的格式、输出文档的格式）
进对应的程序。今天的五个 team 回答的问题（这个
项目看见哪些 agent）随目录一起消失：到处都是 chat 加十个程序。插件开关
是用户全局的，没有按项目的开关，本提案也不建。

四条规则：

1. **内置程序是起点，不是边界。** 模型应该自由地 generalize。十个程序
   是入口 agent 能按名启动的东西、`texra run` 的一个名字，也是模型读得
   到的例子；它们用的积木（`builtIn:revise`、步骤工具）模型同样拿得到，写一个
   自己的程序并启动它（"document task 的归宿"）。
2. **程序是 workflow，视角是 hint。** workflow 在了，`logic` 和
   `notation` 就只是 hint 的问题（负责人 2026-11-14）。一个程序存在，是
   因为它的代码不同：验证器不同、输入不同、产物不同。"看论证结构""看记
   号""第一次读的人会在哪里卡住"不是代码，是一两句话，随指令传给同一个
   程序。hint 不是文件，不是目录项，不进 picker，也没有 `--hint` 这个参
   数和具名的 hint 表：用户在聊天里说，模型启动程序时自己写，free
   style（负责人 2026-11-14）。
3. **一个内置程序是一个带验证器的做法。** 它值得是程序而不是一句提示词，是
   因为有东西能检查它：编译、diff、texcount，Lean 的诊断。往后的程序
   （拿 CAS 逐步复核一段推导、对着 `.bib` 和 arXiv 核对每条引用）按同
   一个标准进来；本提案不建它们。
4. **新增内置的要过门槛。** 加一个内置程序要同时交一个 journey，并写明
   它为什么不能是一个已有程序加一句 hint，也不能留给模型现写。十个各
   自带 journey。

### 审批、重放与信任

今天 `isTaskConfig` 只认 `script.kind: 'recipe'`，这样的 run 有一组待遇。
之后它们给"以一个登记的程序打开的 run"，逐项如下：

| 今天 task 的待遇                         | 之后                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| 工具是固定的表，不看开关                 | 留：程序登记里列的工具                                     |
| `agent()` 随启动批准                     | 留                                                         |
| 子运行的 prompt 和文件列表按写的通过     | 留。启动时传进来的文件另在启动边界校验（"一个程序是什么"） |
| 花费含子运行；从行恢复；结束后不接后续   | 留：这是脚本 run 的形状，不是信任                          |
| agent 名越过 delegation scope 解析       | 没有了：没有 catalog                                       |
| 指令不激活 skill；恢复时重建模板 opening | 指令不激活 skill 留着；模板没有了，不再重建 opening        |

- **模型写的程序走脚本本来的审批。** 内联的代码是模型的：Q5 的一次脚本
  请求（展示源码，批准即覆盖整段，含它的 `agent()`），文件列表照模型脚
  本解析。它要了步骤工具就有，但没有内置程序的那几项待遇。
- **审批不加新东西。** 程序里的嵌套调用走和今天完全相同的 per-call 程序
  （hooks、guard、approval、结果行）。模型启动一个程序是一次子运行的启动
  审批（`proposal` 请求），字段从 agent 名改为程序名。
- **重放。** 源码和模块钉在步骤上，`ScriptDiverged` 照旧。
- **发现期不执行任何代码。**

### multi-agent 编排

编排不是被删掉，是回到它本来的形态：一段程序。codemode 文档已经写了
"`agent()` 是普通工具，所以 fan-out 工作流就是一个脚本"，并以此替掉了
`delegate_multi_agents` 和五种 `workflow.*` 行。今天的 `orchestrator` 和
`engineer` 是两段提示词，告诉模型"拆任务然后调 `agent()`"。

留下的是机器：子运行带父边、一次脚本审批覆盖它的所有 `agent()`（Q5）、
会话级子运行并发预算、goal 的花费上限、`executions` 的运行间消息、子报告
走 follow-up 收件箱、后台脚本、子运行结果的复用、SQL 的 `run_tree` 和
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
const annotated = await program('annotate', { files });
const applied = await program('apply', { files: annotated.files });

// supervisor loop：goal 已经是它，verdict 和花费上限的语义在里面
const { goal } = await import('builtIn:goal');
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
专家当场写一段 system 文本；需要带流程的，是一个程序，脚本声明里的程序
列表就是名单。

不出编排库（`fanOut`、`pipeline`、`supervise`）：`Promise.all` 就是
fan-out，连着两次 `program` 就是 pipeline。唯一值得作为库出货的模式是
goal，因为它编码了 verdict、暂停原因和花费上限这些 harness 语义，而它已
经在了。`multi-agent` 插件的开关保留作为用户的一次同意。
`docs/guide/multi-agent-workflows.md` 改写成上面四个模式。

### document task 的归宿

15 个带 `task:` 块的文件是同一个函数的 15 组参数，那个函数今天就是一段
JS 的 recipe。`builtIn:revise` 导出一个原语，现在的 recipe 泛化后的样
子：

```js
revise({
  ...args, // 四组文件、指令
  requests, // 每轮一段文字；长度就是轮数
  system, // 可选；默认 "You revise LaTeX documents."
  review, // 可选；轮间 critic 的 rubric，默认是 critic.yaml 那 12 行
  verify, // 可选；每轮产物的检查函数，失败即下一轮的输入
});
```

步骤不变：`document_context`、`agent()` 一次、`document_extract`、
`document_compile`、`document_diff`，轮间 `document_review`，最后
`document_propose`。`critic` 不再是 agent，是 `review` 的默认常量。

这不是 recipe 的改写，是 documents 工具的契约变更。每个步骤工具今天都经
`AgentCatalog` 读 agent 的 `task:` 块（`documentState.ts` 调
`documentTaskOf`），轮数取 `task.requests.length`（`documentTools.ts`），
prefix 和 requests 由 `document_context` 渲染 Nunjucks，选项读
`script.options`。之后 prefix、requests、轮数和原来的选项由 `revise` 作
为工具输入传给 `document_context`，Nunjucks 删；文件、memories 和指令仍
从 `run.config` 读。模板（`paper2slide` 的一个、`paper2poster` 的三个）
今天由 `task.files` 绑到 agent 文件旁边，之后是 documents 插件自己的数据
文件，由工具按名字读。"Pass N of M"的 M 今天来自目录选项的 `rounds`，之
后来自 `document_context` 第一次调用写进 documents fact 的 `revisions`。

按 workflow 去重后 15 个文件是 8 个程序。同一行里的文件，workflow 相
同，差别是 hint：

| 今天                             | 程序          | workflow                                                 | 今天各文件的差别，之后是 hint          |
| -------------------------------- | ------------- | -------------------------------------------------------- | -------------------------------------- |
| correct, polish, generic, devise | `edit`        | 改写正文                                                 | 改到什么程度：只改错字和格式，还是结构 |
| criticize, firstread             | `annotate`    | 只加 `\criticize{}`，不动原文                            | 从谁的眼光看：审稿人，还是第一次读的人 |
| logic, notation, enhance         | `enhance`     | 能改的改，改不了的留 `\criticize{}`                      | 看什么：论证结构、记号一致、数学内容   |
| apply                            | `apply`       | 按批注改                                                 |                                        |
| merge                            | `merge`       | 把一份局部修改合回全文；要 `editedFile`，由 merge 动作给 |                                        |
| ocr, transcribe_audio            | `transcribe`  | 媒体到 `.tex`，由文件后缀决定                            |                                        |
| paper2slide                      | `slides`      | 带模板                                                   |                                        |
| paper2poster                     | `poster`      | 带三个模板文件                                           |                                        |
| critic                           | `review` 参数 |                                                          |                                        |

所以 `logic` 和 `notation` 不需要自己的程序，也不需要争它们该归哪一
个：它们是给 `enhance` 的一句 hint，写在指令里：
`texra run enhance --input paper.tex --instruction "只看记号是否一致"`，
或者在聊天里说一句。

合并丢掉的是各文件独有的长 rubric（"模型会变强"的裁决；留下的是一句
hint）和轮数的差别：`correct` 今天一轮，`polish`、`generic`、`devise` 两
轮，合成一个程序后取一个。

代码赢过 YAML 的地方是 `verify`：YAML 只能要求模型"别改别的"，代码可以
检查。`annotate` 断言 diff 只新增 `\criticize{` 行；`merge` 断言输出含原文
的每个 `\section`；`edit` 断言 texcount 没有掉一半；`slides` 和 `poster`
断言带模板能编译。每个几行，失败就是下一轮的输入。

八个是内置的，模型不限于它们（负责人 2026-11-14："这些是内置
program，但 model 应该自由去 generalize"）。从近到远三档：

1. **一句 hint。** `program('enhance', { files, instruction })`，绝大多
   数情况到此为止。
2. **把程序串起来。** 先 `annotate` 再 `apply`，或者几个文件并行。
3. **写自己的程序。** 模型读一个内置程序的源码（十几行），用同样的积木
   写一个变体，作为一个程序启动：

```js
const builtIn = await describeTool('annotate'); // 内置程序的源码
return program(
  {
    code: `const { revise } = await import('builtIn:revise');
return revise({
  ...args,
  requests: [
    'Mark every step a referee would ask to see proved.',
    'Now supply the ones that take two lines.',
  ],
});`,
    tools: STEPS,
  },
  { files },
);
```

模型写的程序是它自己的一个 run，所以有它自己的一份 document 状态、自己
的卡片和 diff；这就是步骤工具只给程序的 run 的原因。入口 agent 自己的
脚本不直接调步骤工具：同一个 run 里改两次稿会把同一份状态写两遍。

这改了裁决"Adaptive document workflows are not planned"（2026-09-06）。
那条不要的是由模型选择的 document 工作流取代固定的工作流。之后固定的工
作流作为内置程序还在，是默认的那条路；模型可以在它们之外写自己的。

### 启动面

入口 agent 只有一个，用户不挑也不改。launch form 今天默认选中
`orchestrator`，列表是 workspace 选择放行的那些 agent（全开是 35 个加插
件的 5 个，team 存在就是为了把它砍短）；之后没有 agent 列表，不选任何东
西就能开始，要什么在聊天里说，由它启动对应的程序。

用户最常用的入口不给调内置程序（负责人 2026-11-14）：launch form 里只
有入口 agent，没有程序的列表。`launchTarget: 'agent' | 'team'`、
`selectedTeamId`、`agent` 字段和五个选项字段删。要跑哪个程序，在聊天里
说，由入口 agent 启动；多出来的代价是一轮模型调用。

内置程序的直接启动留在不是"用户常用入口"的地方：`texra run <程序>`
（脚本、CI 和 `texra-action` 用它）和 host 自己的动作（merge）。
`texra run chat --print`、`texra chat` 和 `texra skills` 照旧，
`texra team`、`texra agents` 删。`document_task` 工具和 `builtIn:documents` 的
`revise(agentName)`、`from()` 包装删。提案卡今天显示 agent 名，之后显示
程序名，或 `label` 和 system 文本的首句。

Plugins 页（和 CLI 的 `/plugins`）上，`theory` 和 `lean4` 的卡片各列自
己的程序：名字、描述、源码。不新建 Tasks 页。

## run 怎么开始、怎么结束、结果去哪

结论先说：**结束的一侧已经是一个机制，开始的一侧有五种叫法，结果的读法
有一处插件特例。** 本提案改的是开始；结果的特例能不能删要看一次对比。

### 开始：谁启动一个 run，用什么命名它

| 入口                                       | 今天的命名方式                                                                          | 代码                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| host 的 launch form                        | `agent` 名、`launchTarget`、`selectedTeamId`、选项表                                    | `LaunchSurfaceSchema`、`documentTaskPatch` → `session.start({ config })`          |
| `texra run <agent>`、`texra team run`      | agent 名、team id                                                                       | `packages/cli/src/commands/run.ts`、`team.ts`                                     |
| SDK                                        | agent 名或 inline persona，或整份 `config`                                              | `StartRequestSchema`                                                              |
| host 自己按名字启动                        | `'latexFixer'`、`'merge'`、`'setup'`；表单默认 `'orchestrator'`、CLI 默认 `'assistant'` | `planCompileFixer`、`handleFixCompilation`、`HostRunActions.merge`、`launchSetup` |
| 模型：`agent()`                            | `agentName` 或内联 `persona`                                                            | `AgentTool.ts`、`proposalFlow.ts` 的 `requireAgent`                               |
| 模型：`document_task()`                    | agent 名，子 run 开在 recipe 上                                                         | `DocumentTaskTool.ts`                                                             |
| 模型：`self()`                             | 同一个 agent；fork 或 fresh                                                             | `SelfTool.ts`                                                                     |
| 模型：`script` 后台、plan 的 "Run as Goal" | 父 run 的 agent 和工具，`script.kind: 'background'`                                     | `backgroundScript.ts`、`PlanTool.ts`、`goalScript.ts`                             |
| 进程子运行（后台 bash、agent CLI）         | 工具自己供给那一轮                                                                      | `processRun.ts`                                                                   |
| 恢复、fork、聊天续轮                       | 同一份 rows                                                                             | `resumeRun.ts`、`forkRun.ts`、`rootLaunch.ts`、`FollowUps.ts`                     |

一个 run 要跑什么，今天有五种表示：agent 名、team、内联 persona、recipe
块、script kind。它们在同一张 `AgentConfig` 上共存。本提案收成两种
（`chat`、`program`）：host 和 CLI 启动 chat 或一个程序；SDK 给
`{ system, tools }` 或 `{ name, args }`；模型用 `agent()`、`program()`、
`self()`；host 自己按名字启动的三处变成 `merge` 程序，和同一个入口
agent 加一条 host 写的指令（setup、编译修复），两个默认值删。`requireAgent` 的 scope 和 shadowing
解析删。后台脚本和 goal 那一行不变。

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
`AgentBlock.result`。这是 harness 里唯一一处"读一个结果要问插件"，有三个
调用者（`AgentTool.ts`、`childDelivery.ts`、
`agent/storage/childRunOutput.ts`），它替 documents 做三件事，都读 run 上
的 documents fact，不读脚本的返回值：

1. **投递正文。** 每个提议的文件、它的 diff 路径、`large-change`、每一轮
   的产物和 `<compile-failures>`，由 `DOCUMENT_TASK_RESULT.delivery` 渲
   染。`document_propose` 自己的结果只有 `{ files }`。
2. **文件清单。** `changes` 是父 run 可以读子 run 存储里哪些文件的依据，
   把一个程序的产物交给下一个程序靠它。
3. **坏结果。** fact 缺失或不合 schema 时投递 `<invalid-result>`。

目标是删掉这个特例：一个程序的结束就是一个脚本的结束，投递是它的返回值
加通用的调用摘要和文件列表。这要 documents 先做到三件事：
`document_propose` 把今天只在 fact 里的东西作为值返回，`revise` 把它作为
程序的返回值交出；通用的脚本文件摘要能当那份清单；程序抛错或没有返回值
就是坏结果。做到之前，这个读法原样挪到程序的登记上（按程序名找，不按块
名）。第 2 期用同一个 journey 对比父模型读到的内容，不少于今天才删。

## 触发就是带着事件启动一个程序

goal mode 之所以看起来 codemode native，是因为它把三件事分开了：触发是
一次按钮（批准 plan），启动是一段两行脚本，策略是一个可替换的模块
（`goal.strategy`）。把这三件事推到每一个入口上，就是统一。

两条公理：凡是在跑的东西都是程序（叶子是 chat）；凡是让程序跑起来的事都
是一次 `start`，事件在 `args` 里。

| 触发                          | 今天怎么接                                     | 统一后                                                   |
| ----------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| 批准 plan，"Run as Goal"      | `PlanTool` 以后台脚本启动 `goalScript()`       | 不变：同一个机制，带 goal 自己的启动选项                 |
| launch form 点 Run            | 按 agent 还是 task 拼不同的 `AgentConfig`      | `start({ name: 'edit', args })`                          |
| `texra run`                   | 同上                                           | 同上                                                     |
| 编译失败后修复                | `planCompileFixer` 手拼 config 启 `latexFixer` | 入口 agent 加一条 host 写的指令；人可以接着聊            |
| 模型要 fan-out                | 脚本里 `Promise.all(agent…)`                   | 不变                                                     |
| PR 开了、CI 红了              | 订阅通知投进某个 run 的收件箱                  | host 收到通知，也可以 `start({ name, args: { event } })` |
| 用户在聊天里回话              | chat 叶子的下一轮                              | 不变                                                     |
| host 的其他事件（保存、定时） | 无                                             | 一次 `start`，事件在 args                                |

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

## 用户自己的程序：安装式插件带程序

用户自己的程序进 1.0（负责人 2026-11-14）。它回答的问题是：custom
agent 删掉之后，用户自己的东西放在哪。它给入口 agent 多几个能启动
的程序，不改入口 agent 本身：安装式插件不带 prompt 段，替换不了基础文
本，也加不出第二个入口。

程序是沙箱里的 JS，不需要原生代码，所以一个只带程序的插件可以是一个目
录。安装式插件今天已经是目录（Claude Code、Codex 的布局，
`packages/harness/src/common/plugins/pluginManifest.ts`），能带 skills、
commands、agents、MCP server 和 hooks，不进脚本的模块表。让它带
`programs/*.js` 要做的事：

- **进模块表。** 和它的 MCP server 一样按步加载（`readInstalledPluginLoad`，
  `packages/harness/src/common/plugins/pluginTrust.ts`）。它的程序和模块
  叫 `<插件名>:<名字>`，和它的 skills、agents 今天的叫法一样；插件不能叫
  `builtIn`（今天已经不能叫 agent source 的名字）。
- **描述和工具从文件里读。** 加载器从文件里的 `export const description`
  和 `export const tools` 两行静态读出，不求值。这是加载器的约定，内核
  拿到的仍是值。加载器不跟符号链接（摘要记的是链接文本）。
- **信任用已有的那一套。** 按内容摘要记在用户的全局状态里：启用时列出它
  带的东西让人审阅，改了任何文件摘要就变，整个插件收回，直到重新审阅。
  程序进这份清单，并写明"它启动的子运行不再逐个问你"。不受信的插件什么
  都不加载，所以 picker 里没有不受信的东西。
- **待遇比原生的少。** 启动和它的 `agent()` 随那次审阅批准；它列的工具
  要看开关（第三方的文本不该越过用户关掉的开关）；它的文件列表照模型脚
  本那样解析。这些差别从"它是哪一种插件的"推出，不另存。

用户自己的程序就是一个从本地文件夹安装的插件。安装式插件今天已经能按路
径原地引用；用户建一个文件夹，放一个 manifest 和几个程序，
`texra plugin install ./my-programs`，审阅一次。今天这条路的代价，照实
说：

- 文件夹要有一个 Claude Code 或 Codex 格式的 manifest；harness 没有自己
  的 manifest。
- 信任是整个插件的：改一个文件、存进第二个程序，所有程序一起收回直到重
  新审阅。
- 记录是全局的、按名字的：一个受信的插件在每个项目里都加载，两个同名的
  撞。

项目里自动发现（`.texra/programs/`，克隆下来就能看到、审阅一次就能用）
不在本提案里。它需要今天没有的东西：一份按 workspace 的记录、按文件的
信任、对工作区的扫描，以及 `.texra/` 不再被 `texra init` 写进
`.gitignore`。它也会触到裁决 D6 的重开条件（"有了受信项目的机制"）。等
用上面这条路的人多到值得，再单独写。

custom 扩展 bundled 的方式是启动它，不是覆盖它。只想换一句 hint 的不需
要程序，hint 写在指令里；值得存成程序的是一段流程：

```js
// my-programs/programs/review-and-fix.js
export const description = 'Annotate, then apply the annotations.';
export const tools = ['program'];
export default async (args) => {
  const annotated = await program('annotate', args);
  return program('apply', { ...args, files: annotated.files });
};
```

上游改了 `annotate`，这段自动跟上。今天的 `customizeCopy`、`basedOn` 和
newer-built-in 提示存在的唯一理由是 built-in 太大、改得太勤，用户复制一份
400 行就漂移；两个条件都消失，机制跟着删。

## 其他 surface

| 面                    | 今天涉及 agent、team、skill、task 的部分                                                                      | 之后                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 设置页                | Agents、Teams、Skills 三个标签页，选择面板，newer-built-in 提示                                               | Agents、Teams 两个标签页和选择面板删，Skills 标签页留；Plugins 页上 `theory` 的卡片列它的程序                   |
| 进度视图的 launch     | `launchTarget`、`selectedTeamId`、`agent`、五个选项字段                                                       | 只有入口 agent，加文件和指令；不列程序                                                                          |
| CLI                   | `agents`、`team`、`skills`、`chat --agent`、`run <agent>` 加选项 flag                                         | `agents`、`team` 和 `--agent` 删，`skills` 留；`run <程序 \| chat>`                                             |
| 设置行                | `workspaceAgents`、`hiddenCustomAgents`、`skills.*`、`codeMode.scriptOnly`、`goal.strategy`                   | 前两组删，`skills.*` 留；`scriptOnly` 的默认值翻成开；`goal.strategy` 不动                                      |
| SDK 导出              | `./host` 上 `AgentCatalog`、`WorkspaceAgents`、`AgentDirectories`、`Skills` 四族，`./plugins` 上 `AgentBlock` | 前三族和 `AgentBlock` 删，`Skills` 一族留。`AgentConfig`、`AgentEvent`、`AgentPlatform` 是 run 的词汇，名字不动 |
| `session.request`     | 无                                                                                                            | 不变；`StartRequest` 改为 `{ system, tools, instruction }` 或 `{ name, args }`                                  |
| 请求                  | `proposal`（子运行的启动审批）显示 agent 名和 persona                                                         | 留；显示程序名，或 label 和 system 文本                                                                         |
| `docs/guide`（32 页） | 16 页提到 `texra run`、`--agent`、`texra team`、`texra agents` 或 `texra skills`                              | `built-in-agents`、`custom-agents`、`multi-agent-workflows`、`agent-architecture`、`texra-cli` 重写，其余改措辞 |
| GitHub action         | `texra-ai/texra-action/review@v2` 调 `texra run`，默认装最新的 CLI                                            | `run` 的参数换义要和 action 一起发                                                                              |
| harness 的打包示例    | `packages/harness/example/` 的 `07-programmed-path.ts`、`10-external-plugin.ts`、`acme-notes` 用 agent 文件   | 改为插件带程序；R9（随包提供 agent 文件）改为随包提供程序                                                       |
| 测试                  | 引用 bundled 名字的套件和 golden store（`golden-1.0.sql` 里有一次 `polish` 的 task run）                      | 套件改写或删除，golden store 随两次存法变更各重生成一次                                                         |

## 删除清单

| 删什么                                                                                                   | 行数（量于 `d173e42`） | 留什么                              |
| -------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------- |
| 35 个 bundled agent 文件、lean4 和 multi-agent 的随包目录、TeXRA 自己的 skill                            | 3524 + 1292 + 593      | 十个程序文件、各插件的 prompt 段    |
| harness：agent 索引、catalog follower、workspace 选择、persona schema、`AgentBlock`                      | 约 2800                | skills 子系统                       |
| team：预设、启动、CLI、标签页、`apply_team`（已删，2026-11-17）                                          | 1647                   | 无                                  |
| agent 设置页（前端和后端）                                                                               | 1353                   | Skills 标签页；Plugins 页多一列程序 |
| documents：`task:` 块、Nunjucks、`files:`/`outputs:`、选项表、`rounds`、`document_task`、recipe 源码生成 | 约 1000 of 2271        | 文档工具本身和 `revise`             |
| CLI：`texra agents`（`team` 已计入上面）                                                                 | 271                    | `texra run`、`texra skills`         |
| `latex-extract` 插件：`extract_figures`、`extract_tikz_figures`、`extract_bib_entries`                   | 514                    | 无                                  |

删掉的代码约 7600 行（"约"的两项是估计），提示词和 TeXRA 自己的 skill
文本 5409 行。
新增没有逐项估：`programs` 和按名启动、`program` 工具、normalizer、
`revise` 和十个程序文件；安装式插件带程序另算。比 11-06 版少建的是工作
区解析器、沙箱的模块入口、task 加载器、Tasks 页和 types 命令。

## 与已有裁决和 PRD 的关系

需要负责人明确改口的六处。负责人 2026-11-14 在决定页上同意了第 1、2、
3、5 处，不同意第 4 处；第 6 处是他当天自己改的：

1. **codemode Q8 "No script files"**（2026-10-02）。原文禁的是 `path`、
   `.texra/scripts/` 下的草稿、`args` 和 `files`。收窄为：这些对模型写的
   脚本仍然成立；插件登记的程序是文件，带 `args`。recipe 今天就带着文件
   和选项启动，所以这是把已有做法说成规则。
2. **PRD "Agent 文件和 imports"，参数化 prompt。** 原文保留"参数化
   prompt"和"脚本模块"两种组合方式；本提案只留脚本。task 块的 Nunjucks 能
   表达的，一段 JS 都能表达，反之不然。原文把工作区 import 和相对路径推
   到 1.0 之后；11-06 版把它提前，本版**不提前**：1.0 里相对 specifier
   一律拒绝，内核只 import 已启用插件注册的模块。
3. **PRD 的 agent 文件、R6、R9 和任务配置块。** "Agent 文件…文件形式本
   身不需要被替换"，R6 的"文件与 inline 定义一致"，R9 的"插件随包提供
   agent 文件"，以及原生插件一行里的"任务配置块"。本提案没有 agent 文件
   也没有 persona；任务配置块换成程序表；R6 因只剩一种形式而平凡成立，
   R9 改为随包提供程序，示例梯子随之改。
4. **skills 和安装式插件的 agents**（PRD "安装式 manifest"一行）。**负责
   人不同意删。** 安装式插件的 skills、commands 和 agents 照旧加载，PRD
   的这一行不动，skills 子系统留着。本提案仍删 TeXRA 自己随应用出货的
   skill（11-06 的"不要 skills"）。两处还没定，见"负责人问题"1：项目和
   用户目录里的 skill 是否照旧；插件带的 agent 和"入口只有一个"怎么并
   存。MCP 的启用方式变了（"入口只有一个 agent"）。
5. **裁决 D10 "Custom teams stay presets"**（2026-09-30）。它的重开条件
   是"一个 team 需要预设装不下的状态"。本提案删 team 不是因为这个，而是
   因为它回答的问题（这个项目看见哪些 agent）随目录一起消失。这是在重开
   条件之外重开。
6. **裁决 "Adaptive document workflows are not planned"**（2026-09-06）。
   负责人 2026-11-14 的"model 应该自由去 generalize"改了这一条：固定的
   工作流留作内置程序，模型可以用同样的积木写自己的（"document task 的
   归宿"末段）。

第七处已由负责人 2026-11-14 选了"用户自己的程序进 1.0"而接受：

7. **安装式插件带程序。** PRD 的能力矩阵写"安装式 manifest…不承诺原生脚
   本模块"，1.0 的 import 范围写的是"已启用原生插件"；裁决 D11 写仓库外
   的插件靠 hooks 和数据扩展，code plugin 等到有一个具名的插件做不成 MCP
   加 hooks 加数据时再建；核心概念写"第三方代码在进程外跑"。沙箱是 host
   进程里的一个 worker 线程。它里面的程序没有环境权限，效果只经过被
   offer 的工具，而同一个受信插件的 hooks 和 MCP server 今天已经能起本地
   进程；但这仍是第三方代码第一次在进程内跑。

还有一处是负责人自己改的：codemode Q10（翻 code mode 的线是五晚的合并
窗口）被 2026-11-14 的"Code mode 可以开了"取代。

与之一致的：

- **D9**（"一个开关应该收回一个插件贡献的一切"）：插件的程序随它的开关
  收回，和它的工具一样。原生程序列出的工具不看开关是今天 task 的规则，
  不是新开的口子。
- **2026-10-24 的裁决**（子运行不受父运行的工具限制）：一个程序的 run 被
  offer 的是它自己的登记所声明的。
- general-package 设计比较过"最小内核，每个内置都是插件"这一案，因 churn
  没选。本提案不搬目录，靠删除让内核变小；`builtins/` 目录那一步仍按原
  裁定等一个具名的 embedder。
- general-package 设计的第 5 条线（deferred tools："`OfferedTool.sent`、
  script-only 的 dispatch 路径和 `searchTools` 已经在了"）和 codemode 的
  Q4（声明的工具内联成类型声明）：本提案不给工具加 `deferred` 标记，而
  是让聊天声明得少，没声明的都是 deferred。
- 无流程引擎、历史一个写者、`agent()` 替代 delegation 工具（Q7）、Q5 的
  一次脚本审批、1.0 的 SQL 只读视图、codemode 的关注点分离表、"code
  mode stays domain-free"、`RUN-trusted-script-launch-grants` 的否决。

### 随 #14773 搁置的三条发现

red-flags 的顺序（`2026-11-07-red-flags-round-2-and-order.md` lane 5 的第
5 条）把 M4、M9、H9 放在顺序之外，"等负责人回到 #14773"。负责人
2026-11-14 回来了，改写后的设计对这三条的影响不一样：

- **M9**（catalog follower 的三个订阅和一个 readiness `Deferred`）由第 5
  期取代，不单独排。三个订阅里，custom agent 目录和 active team 的两个随
  它们的 key 一起删。第三个（停用的工具、安装的插件）只在"负责人问题"1
  的答案是"插件带的 agent 留作子运行"时才留，那时它就是 M9 要的那一个
  feed，`Deferred` 在同一期换掉。
- **M4**（plan 工具从自己过去的 tool result 里找它启动的 goal）不被取
  代。本提案不动 goal：`builtIn:goal`、`launchBackgroundScript` 和
  `kind: 'background'` 都原样，第 1 期只换了 `recipe` 那一个成员。建议它回
  到顺序里；第 1 期已落地，没有先后要排。
- **H9**（插件用六种方式拿 host 的服务，一个能力是裸 flag）不被取代。本
  提案不改 `texraPlugins(host)` 怎么把 host 的服务交给插件。建议它回到顺
  序里。原来要和第 1 期一先一后（两者都改
  `packages/texra/src/tools/registry.ts`）；第 1 期已落地，这条约束没有
  了。

## 更彻底的方案：Unix

比本提案再往前一步就是 Unix：`texra` 是读 stdin 写 stdout 的过滤器，task
是 PATH 上任意语言的可执行文件，工具是 CLI，持久化靠内容寻址的缓存而不是
重放。它撞四面墙：Windows 上没有 shell；1.0 PRD 的 P0 承诺（公开 SDK、故
障点测试、运行所有权、重放）全是进程内契约；沙箱让每个嵌套调用在执行前
过审批并在卡片树里可见，shell 脚本做不到；三个 host 的 UI 全来自 run
history 的行。

"小内核、程序在外面"是从它借来的原则，本提案在 harness 之内兑现它。还可
以单独落的三条：

1. **工具是 CLI，bespoke 工具要有理由。** 一个插件工具只在三种情况下有资
   格存在：需要审批语义、需要写 run history 的行、需要结构化结果供脚本分
   支。其余的（arxiv、Zotero）变成随包的 CLI，模型用 bash 调。
   `latex-extract` 的三个工具负责人已定直接去掉。是负责人问题 2。
2. **headless 走文本流。** `texra run` 已经输出 NDJSON；再让它从 stdin 读
   文件列表、向 stdout 打产物路径，shell 组合就免费了。
3. **缓存是一等机制。** 子运行结果的内容寻址复用今天已经覆盖任何子运行
   的启动（`document_task` 也在内），范围是发出调用的 run。把范围扩到会
   话：改了 `paper.tex` 一行，重跑整条流水线，只有输入变了的步骤真的
   跑。重放仍负责中断续跑。能安全缓存的前提是产物不直接改工作区，而是进
   run 存储再由用户 accept，这正是 documents 今天的设计。

## 权衡

- **确定性对灵活性**：程序钉在 run 上，所以一个程序的行为在运行中不变。
  这是 PRD 要求的。
- **用户的自定义换了形式。** custom agent 删掉之后，用户有 `AGENTS.md`
  和自己装的插件里的程序。后者要在删 agent 文件之前到位（"分期"），代
  价是第三方代码第一次在进程内的沙箱里跑。
- **常用入口多一轮模型调用。** launch form 不再能直接点一个内置程序；
  "把这篇改一下"要先经入口 agent 再启动 `edit`。脚本和 CI 仍可以用
  `texra run <程序>` 直接跑。
- **不会编程的用户**：YAML 从来没有比十几行带模板字符串的 JS 更容易；384
  行的 YAML 没人读得完。模型代写。
- **用户不能换入口，也不能改它**：这是决定，不是疏漏。按会话切换
  persona（`texra chat --agent research`）和 custom agent 都消失；换一
  个口吻由项目的 `AGENTS.md` 承担，它附在基础文本后面，不替换它。
- **按项目的可见范围消失**：今天 workspace 选择决定一个项目看见哪些
  agent。之后到处是同一个 chat 加十个程序；插件开关是全局的。
- **每次启动的开关**：launch form 的五个开关和对应 flag 消失，变成程序里
  的一行。轮数的差别也消失（`correct` 一轮，`polish` 两轮）。
- **MCP 的启用粒度变粗**：今天可以让某个 agent 用某个 server；之后配了
  的 server 每次聊天都能调。
- **模型写的程序没有内置程序的验证器**，除非它自己写一个；每段要过一次
  脚本审批，用户看到的是源码。内置程序仍是默认的那条路，自由是留给它
  们盖不住的情况的。
- **模型要先找到工具才能用**：没声明的工具多一次 `searchTools` 或
  `describeTool`，在脚本里，不多一次模型往返。风险在模型不知道有这个能
  力；各插件 prompt 段里那一两句就是为此。
- **聊天的 system 文本跟着插件开关变**：开关一个插件会改下一步的 system
  文本。插件的 prompt 段今天就是按步钉住、变化时作为一条更新消息发出，
  机制不变，只是它承担的内容变多；段按插件 id 排，不能靠顺序表达轻重。
- **每个带 `script` 的步骤多钉十来个模块**，脚本的描述里多列十来个名
  字。
- **弱模型**：code mode 的数据只覆盖两个模型和全部声明的小工具集；整套
  聊天加搜索要另测。写不好脚本的模型走回退，拿到全部工具的 schema，和今
  天一样。某个便宜模型在某类论文上确实需要一段 rubric，就写在
  `AGENTS.md` 里。
- **可发现性**：35 个名字至少告诉用户 TeXRA 能干什么。之后常用入口里
  没有任何列表，由入口 agent 自己、Plugins 页和程序参考页承担这个角
  色。
- **互操作保留**：安装式插件的 skills、commands 和 agents 照旧加载（负
  责人 2026-11-14）。代价是 skills 子系统、它的设置页和 CLI 命令都留
  着，内核仍认识 skill 这个词。
- **外部消费者**：`texra run` 的参数换义要和 `texra-action` 一起发；上一
  次这类变更就是两边一起动的。
- **破坏范围**：1.0 不保兼容。用户的 custom agent 和 custom team 失效，
  changelog 写迁移路径；不写 YAML 到 JS 的转换器（AGENTS.md 禁止 legacy
  reader）。

## 分期

每一期独立可合，存法只变两次，各自落在需要它的那一期。第 1、2、6 期
已随 #14968 落地，每一期末尾写了核对到什么、还剩什么；第 3、4、5 期未
做，第 7 期等"负责人问题"2。

1. **按名启动和它的存法**（harness 加 documents 的启动路径；用户看不到
   变化）。`Plugin.programs`；`script` 的 `recipe` 成员换成 `program` 成
   员，`documents` 插件改名为 `theory`（第一次存法变更）；`program` 工具
   替掉 `document_task` 和 `launchesTasks`，按名的和模型现写的都由它启
   动；脚本声明里列程序；沙箱的 normalizer 和模块帧。第一个消费者是今天
   的 recipe 本身：它登记成一个程序，15 个 task agent 仍通过它跑，agent
   名和选项在 `args` 里。结果的读法原样挪到程序的登记上。goal 不动，
   `scriptModules` 和 `builtIn:` 不动。
   **已落地（#14968）。** `launchesTasks`、`document_task`、
   `isTaskConfig`、`recipeBlockOf`、`agentBlock` 按整词搜索源码都是 0 处；
   `Plugin.programs` 在 `packages/harness/src/tools/plugins.ts`，
   `script.kind: 'program'` 在
   `packages/harness/src/shared/schemas/agentConfig.ts`，插件 id 是
   `theory`，`run.config` 升了行版本；`script` 的描述列出能启动的程序
   （`ScriptTool.ts`），沙箱按 specifier 原样查表，不再走 QuickJS 的
   normalizer（`packages/harness/src/agent/codeSandbox/worker.ts`）。还剩：`program` 工具
   （`packages/harness/src/agent/runtime/delegation/ProgramTool.ts`）只接受
   登记的名字，模型现写的 `{ code, tools }` 还不能由它启动。
2. **`theory` 的前八个程序**。`revise` 原语和步骤工具的契约变更；15 个
   task 搬成八个程序文件。先移 `edit` 和 `annotate`，journey 跑一次作回
   归；再移其余六个；最后一个移完就删 15 个 task 文件、`task:` 块、
   Nunjucks、选项表、`critic.yaml` 和 `AgentBlock` 剩下的部分。步骤工具
   对模型写的程序开放，`describeTool` 对程序名返回源码。结果的读法在这
   一期对比后决定删不删。程序能由 `texra run` 和入口 agent 启动；launch
   form 这一期不动。
   **已落地（#14968，后续 #14998）。** 八个程序在
   `packages/texra/src/tools/theory/programs.ts`（源码是这个文件里的字符
   串，不是各自的 `.js` 文件）；task 文件、`task:` 块、选项表和
   `critic.yaml` 已删，`packages/extension/resources/agents` 剩 19 个文
   件，`DOCUMENT_TASK_OPTIONS` 整词搜索 0 处；`describeTool` 对程序名返回
   源码；launch form 的 task 开关和 task agent 也在这一期删了。还剩：结
   果的读法没有删（`Program.result` 仍由
   `packages/harness/src/agent/runtime/childDelivery.ts` 读），那次对比没
   有记录；步骤工具对模型写的程序开放，等第 1 期剩下的那一项。
3. **`lean4` 插件的两个程序**。它的 agent 和 skill 留到第 5 期：team 已
   先删，不再有名单指着它们，留着只因为 agent 目录整体在那一期删。
4. **安装式插件带程序**，即"用户自己的程序"一节。要在第 5 期之前，否
   则删掉 custom agent 时用户自己的东西没处放。
5. **删 agent 文件和补偿层，聊天的存法变更**。`run.chat` 去掉 persona 和
   agent 名（第二次存法变更），`agent()` 和 `StartRequest` 改签名；
   agents 目录（含 lean4 的）、agent 索引和 schema、workspace 选
   择（team 删后剩 `all` 和 `custom` 两种）、`AgentConfig` 上已无人写的
   `delegationAgentScope`、TeXRA 自己的 skill、customize、`agents` 这个
   CLI 命令、`latex-extract` 插件、launch form 的 agent 列表；聊天
   的 system 文本改由 app 的基础文本和插件的段拼出，根聊天能调的改为
   "开着的"、声明的改为一张短表，MCP 改为配了就能调；测试套件改写或
   删；文档、迁移说明和 `texra-action`。只有入口 agent 的 launch form 到
   这一期才出现。
6. **code mode 默认打开**。现在就可以开（负责人 2026-11-14），独立于
   以上各期，是单独的一处改动；它由哪四件事组成见"入口只有一个
   agent"。在第 5 期之前翻，`assistant.yaml` 的 37 个工具仍全部声明；
   "只声明小核心"要等第 5 期的短表。
   **已落地（#14968）**，四件事都在源码里（见"入口只有一个 agent"）。翻
   之后要补的三件（glm 和 fan-out journey、靠搜索找工具的整套聊天
   journey、回退名单里的真实模型）还没做。
7. **（可选）工具改 CLI**。先从 `arxiv` 试。

**team 已从第 5 期提前删除（2026-11-17）。** 它不依赖第 4 期：custom
team 只是一张名单，删掉之后没有东西需要新家。删掉的是五个预设和
starter、Teams 分区、`apply_team`、`setup` 里问学科的那一步、launch
form 和 `/agent` 里的 team 行、`texra team`、workspace 选择的 `inherit`
和 `team` 两种 kind、默认 team 的全局键和 `AgentDirectoriesPort.teamMembers`。
留给第 5 期的：`all` 和 `custom` 两种 workspace 选择、hidden custom
agents、agent 设置页，以及 harness 上 `AgentConfig.delegationAgentScope`
这个字段（app 里已经没有写它的地方；它是 `run.config` 的一部分，随第二
次存法变更一起删，不为它单独升一次行版本）。过渡期的代价：一个没有手动
勾选过的 workspace，picker 里是全部 agent。

## 负责人问题

决定页上的十一处都选了。剩下两处：

1. **skills 留到哪一步，插件带的 agent 怎么办。** 你选了不删安装式插件的
   skills、commands 和 agents。本文据此保留 skills 子系统，并仍然删掉
   TeXRA 自己随应用出货的 15 个 skill。还没定的：项目和用户目录里的
   skill（`.texra/skills`、`~/.texra/skills`、`.claude/skills` 这一类）
   是否照旧加载；安装式插件带的 agent 不能是入口，它们是留作入口 agent
   可以按名调用的子运行，还是不加载。
2. **工具改 CLI**（Unix 一节第 1 条）作为第 7 期？你在这一条上没选，只说
   了 `latex-extract` 可以去掉。推荐：接受，先试 `arxiv`。

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

- "core 比较小而美，然后有一些 theorists 的 program plugin。"本文按这
  个方向重写；下面几条是在它之内的细化。
- "搞 30 个 agent 让用户选肯定是不行的。"启动面默认是聊天，picker 不列
  agent（"启动面"一节）。
- 文档要对上最新的 `main`：基线和度量取自 `d173e42`。
- "将来默认打开 code mode，不提供所有的工具。"并确认读法："都能调，不
  全声明"。模型拿到的只有 `script`；开着的工具都能调，声明一个小核心，
  其余靠搜索（"入口只有一个 agent"一节）。
- "就一个 theory。"theorist 的程序插件只有一个，不按能力拆，也不按学科
  拆（"theorist 的程序插件"一节）。
- "logic 和 notation 我感觉 workflow 在了就只是一个 hints 的问题。"程序
  是 workflow，视角是 hint；`logic` 和 `notation` 是给 `enhance` 的一句
  话。
- "这些是内置 program，但 model 应该自由去 generalize。总体是个插件。"
  十个是内置程序；模型可以读它们的源码、写自己的程序并启动。这改了
  2026-09-06 的"Adaptive document workflows are not planned"。
  `documents` 并进 `theory`。
- "lean 也是个单独的插件好了。"Lean 的工具和它的两个程序都在 `lean4`
  插件里，不进 `theory`。
- "不要 --hint，let model free style。"hint 是模型和用户写的自由文本，
  没有参数，没有表。
- "入口 agent 需要只有一个，用户不应该能改这个。"一个入口 agent，基础
  文本和声明的工具是 app 的常量（"入口只有一个 agent"一节）。
- "Code mode 可以开了。"现在就翻默认值，不等 journey；开关留着。
- 在决定页上选的：项目的 `AGENTS.md` 保留；内置程序的直接启动保留，
  "但是最直接的用户常用入口不给调默认的了"（launch form 只有入口
  agent）；用户自己的程序进 1.0；声明的核心是那八个；名字是 program；
  第 1 期现在开；"小"指内核认识的东西少，不做物理拆分；改写稿开一个新
  PR 取代 #14773。
- 改口：同意四处（Q8、参数化 prompt、agent 文件和任务配置块、D10 的
  team）；**不同意删安装式插件的 skills、commands 和 agents**。
- `latex-extract`："extract 那个可以去掉了"。

负责人 2026-11-17：

- "我们这个 team 设计在新的 general skills、more codemode 和 more
  plugins 下比较过时了，也许应该 remove。"team 据此从第 5 期提前，单独
  删除（"分期"末段）。

## 修订记录

**2026-11-17，team 先删。** 第 5 期里 team 的部分单独落地，其余不动；
"分期"第 3、5 条和"删除清单"随之改。存法没有变：`run.config` 的行版本
不升，`delegationAgentScope` 留在 harness 上等第 5 期。

**2026-11-14，按小内核和程序插件重写。** 相对 11-06 版：

- 程序的家从三个目录根改为插件；"三种来源，一个解析器"一节删。
- `author` 字段和"工作区 task 每次启动审批"删。
- "bundled 的两个 chat"改为"入口只有一个 agent"。
- 新增"内核认识什么"和"theorist 的程序插件"；Tasks 页、
  `texra tasks types` 和沙箱的 `type: 'module'` 入口不再需要。
- 工作区 import 不再提前到 1.0。

**同日，无上下文审稿（对照代码约 190 条）后的修正：**

- 每个程序列自己的工具。初稿想从"开着的全部"推出，代价是每个 run 多存
  几十份工具定义、把无关插件的服务拉起来。
- `scriptModules` 和 `builtIn:` 不改。初稿改成按插件 id 的命名空间，会
  动 `goal.strategy` 的取值、模型写的 specifier 和 SDK 的字段名，没有换
  来什么。
- goal 不是登记的程序，它的启动路径不变；编译修复是聊天不是程序；十个
  程序，不是十二个。
- 分期重排：存法变更落在第 1 期和第 5 期，不再推到一个靠后的"格式批"，
  否则前几期合不了。
- "项目目录即插件"撤回为可选的一期，并列出它今天的缺口；项目里的自动
  发现移出本提案。
- 从 11-06 版继承来的四处错：`document_propose` 的结果里并没有 diff 路
  径和编译失败（它们在 fact 里，由要删的那个读法渲染）；子运行的工具并
  不受父运行限制（2026-10-24 已裁决）；`logic` 和 `notation` 会改正文，
  不是只加批注；recipe 里 `self()` 不是错误，只是不能 fork。
- 补上漏掉的代价：MCP 的启用方式、`texra-action`、按项目的可见范围、整
  个插件的信任、模块的钉住成本、模块里错误的定位。
- D10 重新列为一处改口；`requires` 不改含义。

**同日，负责人的后续裁决并入：** code mode 默认打开，开着的工具都能调
但只声明一个小核心；theorist 的东西总体是一个插件 `theory`，Lean 因为
有外部依赖是单独的插件并带自己的两个程序（中间一稿把步骤工具留在
`documents` 里，又一稿把 Lean 的程序放进了 `theory`）；`logic` 和 `notation` 是 hint，不是程序；十个程序是内置的起点，模型
可以写自己的，初稿把步骤工具关在内置程序里。入口 agent 只有一个且用户不能改，
setup 和编译修复不再是另一组 chat 参数；没有 `--hint`；launch form 不
列内置程序；用户自己的程序进 1.0；code mode 现在就翻；安装式插件的
skills、commands 和 agents 不删，所以 skills 子系统留着；`latex-extract`
去掉；第 1 期现在开。这一批没有再过第
二个审稿者。

**同日，量了翻默认值的全部影响：** 直接翻 harness 那一行，crash 重放全
部失败，validation 脚本和桌面 e2e 跑的也是同一个假模型。所以翻默认值由
四件事组成（"入口只有一个 agent"末尾），Q3 的回退随它一起建，不再排在
翻之后。

**2026-11-06，无上下文审稿后的修正**（仍然成立的部分已并入正文）：模块
钉在步骤的 `tools.offered.modules`，不在 `AgentConfig` 上另开一份；
`receive()` 撤回；`revise` 是 documents 工具的契约变更；发现期不求值。

## 不做的事

- 不做流程引擎、不做第二个 run history 写者、不做任务调度器。
- 不做工作区里的程序目录：没有 `.texra/tasks/`，没有 `~/.texra/tasks/`，
  没有对工作区的扫描，内核不读任何程序目录。
- 不做第二个入口 agent，不让用户改入口 agent：没有 customize，没有
  `--agent`，没有可编辑的基础文本或工具表，`Plugin` 上没有"命名的聊
  天"。
- 不做 `--hint` 和具名的 hint 表。
- 不做常驻程序和 `receive()`；事件触发是每事件一次 `start`。
- 不做 npm 包解析、不做远程依赖、不做文件系统路径和相对路径的 import。
- 不做按程序的输入 schema 或选项表。
- 不做 YAML 到 JS 的兼容转换器。
- 不做编排库；goal 是唯一出货的模式，而它已经在了。
- 不做"聊天也是程序"。
- 不做按项目的插件开关。
- 不做学科插件。theorist 的程序在 `theory` 里；只有带外部依赖的 Lean 是
  单独的插件。

## Verified

在 `d173e42` 上：

- `find packages/extension/resources/agents -name '*.yaml' | wc -l` 得 35，
  共 3524 行；`grep -l '^task:'` 得 15；`requests` 的长度是 1（`apply`、
  `correct`、`merge`）或 2。
- 各目录行数如"现状的度量"表（`wc -l`）；`config/api-reports/*.md` 的
  `Exports:` 行为 36、163、48、134、299、74。
- `packages/harness/src/tools/plugins.ts` 的 `Plugin` 有 13 个字段；
  `scriptModules` 只有 `goal` 和 `documents` 两处；`texraPlugins` 列 19
  个插件，共 52 个工具。
- `assistant.yaml` 92 行，`prompt:` 从第 42 行起，列 37 个工具；没列的
  15 个是 setup 的 8 个、`document_context`、`document_extract`、
  `document_compile`、`document_diff`、`document_review`、
  `document_propose` 和 `self`。
- `packages/harness/src/agent/codeSandbox/worker.ts`：`setModuleLoader` 按
  `input.modules` 的键查，没有给 normalizer；脚本以 `type: 'global'` 加
  函数体包装求值。在装着的 quickjs-emscripten-core 上：模块之间的静态
  `import` 能用；默认的 normalizer 会改写相对 specifier。
- `packages/harness/src/tools/sessionTools.ts`：一步的 `modules` 由开着的
  内置插件的 `scriptModules` 拼成 `builtIn:<name>`；安装式插件不进这张
  表。
- `packages/harness/src/shared/schemas/offeredTools.ts`：模块按 specifier
  钉为 `context.blob` 的摘要。
- `packages/harness/src/agent/runtime/loop/step.ts`：一步只为它 offer 了
  工具或有 prompt 段的插件起服务；task 的工具不看开关。
- `packages/harness/src/tools/codemode/ScriptTool.ts`：脚本失败时只留含
  `script.js` 的帧。
- 声明的和能调的：`ScriptTool.ts` 的描述内联声明的工具，并写明"more
  are callable: `searchTools` finds them"；`searchTools` 在这一步钉住的
  目录上做 BM25（`tools/codemode/discovery.ts`）；
  `agentToolResolution.ts` 先 offer 声明的再 offer 注入的（插件的
  `injectedWhen`、安装式插件的全部工具），script-only 打开时只有 `script`
  的 `sent` 为真；`toolUseDispatch.ts` 不执行对一个没发出去的工具的直接
  调用。`codeMode.scriptOnly` 默认关。
- `goalScript.ts`：`goalScript()` 两行，调具名导出 `goal`；`PlanTool.ts`
  用 `launchBackgroundScript` 启动它；`goal.strategy` 只接受
  `builtIn:<name>`。
- recipe 的三个入口：`documentTaskPatch`（`MainViewRunLaunchController.ts`、
  `packages/cli/src/commands/run.ts`、`DocumentTaskTool.ts`）和
  `documentTaskConfig`（`hostRunActions.ts` 的 merge）。
- `PromptBuilder.ts`：`buildOpeningSystemPrompt` 把 persona prompt 排在最
  前，其后是 `AGENTS.md`、memories 和工具说明；没有 harness 自己的身份文
  本。带 `prompt` 段的插件是 `memory-workflow`、`core`、`documents`。
- `documents` 插件没有 `toggle` 和 `card`；`lean4` 有探测，没有
  `toggle`。插件开关 `tools.disabled` 在全局状态，没有按 workspace 的开
  关。
- `~/.texra/mcp.json` 的 server 由 agent 的 `tools:` 点名
  （`mcp__<server>__*`）才进 run。
- 安装式插件：`PluginManifestSchema` 没有脚本或模块字段；信任是
  `PluginTrust { version, digest }`，摘要盖住目录下每个文件，
  `readInstalledPluginLoad` 只加载启用且摘要匹配的；记录在全局状态、按
  名字；本地路径原地引用；只有 agent source 的名字被保留。
- `isTaskConfig` 和 `recipeBlockOf` 在 `runRecords.ts`，都读
  `script.kind === 'recipe'`；`readRecipeResult` 有三个调用者；
  `document_propose` 的结果是 `{ files }` 加一个 fact。
- 步骤工具在 task 之外拒绝执行（`documentState.ts`）；模型写的脚本作为
  自己的 run 今天只能送后台，工具取父步骤 offer 的
  （`backgroundScript.ts`）。
- `compileFixer.ts` 的 `planCompileFixer` 以 `script: null` 启动
  `latexFixer`；`merge.yaml` 的描述说它要 merge 动作给的 edited file。
- `docs/guide` 有 32 页，16 页提到 `texra run`、`--agent`、`texra team`、
  `texra agents` 或 `texra skills`。
- `texra init` 把 `.texra/` 写进 `.gitignore`；
  `installGithubAction.ts` 生成的 workflow 用
  `texra-ai/texra-action/review@v2`，它调 `texra run`。
- 把 harness 上 `codeMode.scriptOnly` 那一行的默认值改成开，跑
  `vitest run --project '!crash'`：248 个文件 4 个失败，585 个测试 5 个
  失败；跑 `--project crash`：7 个文件全部失败，9 个测试 8 个失败（基线
  全过）；改动已还原，没有提交。
- 按"入口只有一个 agent"末尾的四件事在 `d173e42` 上实现了一遍（没有合
  并）：`npm run gate` 和 `npm test`（255 个文件、593 个测试）全过，没有
  改任何测试。真实的 `texra run assistant` 对着本地假的模型端点，新装的
  home 里请求只带 `script` 一个工具，把开关关掉后带 20 个。桌面版
  Settings → Agents → Advanced 里这一行默认是开，关掉后重启仍是关。
- codemode 文档的裁决 Q3、Q5、Q7、Q8、Q10 和 "code mode stays
  domain-free"；"Still open" 第二轮的评测表；Q3 的回退没有建。
- 裁决台账的 D6、D9、D10、D11、2026-10-24 的子运行工具裁决和 "Adaptive
  document workflows are not planned"；`refuted-candidates.json` 的
  `RUN-trusted-script-launch-grants`；核心概念的十三个名词和"第三方代码
  在进程外跑"。
