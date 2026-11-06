---
created: 2026-11-06
status: proposed
---

# 程序，不是 agent：目录、codemode 和长期的单位模型

基线：`main` 的 `c4c843a`（2026-11-06）。路径相对仓库根。度量用
`wc -l` 和 `grep`，在"现状的度量"一节逐条给出命令可复核的数字。本文是
设计的当前状态，不是讨论的记录；负责人当天的裁决集中在"决定记录"一节。

## 摘要

TeXRA 今天只有一种用户可创造的单位：agent 文件。于是审稿视角是 agent，
Wolfram 用法是 agent，一条 `latexdiff` 命令也是 agent。bundled 目录到了
34 个（加 lean4 插件 5 个），随后长出了一整层让 39 个"可用"的补偿机制：
team、workspace 级 agent 选择、排序和黑名单、customize 副本和漂移提示、
launch form 的选项表。负责人的判断是"available 的 agent 太多，补偿太多"。
本提案的结论是：**数量是症状，单位是病因。**

设计只剩三种单位：程序模块（沙箱里的 JS）、工具、项目约定（`AGENTS.md`）。
agent 文件和 persona 这个名词都不再存在：一次子运行需要的只是 system 文
本、工具列表和模型，那是模型调用的参数。编排是程序，document task 是同一
个 `revise` 原语的几组参数，team 是一个目录里的几个文件。补偿层整层消失，
新能力长在用户的项目里而不是 bundled 目录里。

这不是一个新方向。仓库里已经有三处"run 是一段程序"：goal 策略是一个脚本
模块（`packages/harness/src/tools/plan/goalScript.ts`，由设置
`goal.strategy` 指名，默认 `builtIn:goal`），document task 的 recipe 是一段
内联 JS（`packages/texra/src/agent/output/documentRecipe.ts`），后台脚本是
`AgentConfig.script.kind: 'background'`。它们各自特例化了同一个东西。提案
把它们合成一个 `program` 类的 run，再让用户的 task 成为第四个实例。

## 现状的度量（`c4c843a`）

| 事实                                                          | 数字                        | 来源                                                                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bundled agent 文件                                            | 34                          | `ls packages/extension/resources/agents/*.yaml`                                                                                                                                           |
| 其中 document task（带 `task:` 块）                           | 15                          | `grep -l '^task:'`，含 `write/` 下两个                                                                                                                                                    |
| lean4 插件的 agent 加同名 skill                               | 5+5                         | `packages/extension/resources/plugins/lean4/`，共 780 行；每个 skill 旁有一个 agent 包装它                                                                                                |
| bundled agent 提示词总行数；最大单文件                        | 3616；402（`enhance.yaml`） | `wc -l`                                                                                                                                                                                   |
| document task 的轮廓                                          | 工具全 0；轮数 1 或 2       | 15 个文件的 `tools:`、`requests:`；两个带 `files:` 模板绑定                                                                                                                               |
| team 预设（加一个不进 UI 的 starter）                         | 5+1                         | `packages/texra/src/shared/agentTeams.ts`                                                                                                                                                 |
| team 相关代码                                                 | 1264 行                     | `agentTeams.ts`、`teamLaunch.ts`、`packages/cli/src/commands/team.ts`、Teams 标签页和 `apply_team`                                                                                        |
| workspace 选择、hidden keys、delegation scope、agent 设置页   | 2930 行                     | `packages/harness/src/agent/workspaceAgents/`、`packages/harness/src/shared/schemas/workspaceAgents.ts`、`packages/extension/src/settingsView/frontend/tabs/AgentsTab.ts` 及 profile 组件 |
| agent 索引（扫描、customize 副本、`basedOn`、newer-built-in） | 1410 行                     | `packages/harness/src/agent/index/`                                                                                                                                                       |
| skills 子系统                                                 | 1521 行                     | `packages/harness/src/skills/`、`packages/cli/src/commands/skills.ts`                                                                                                                     |
| documents 插件（工具、recipe、task 块、选项表）               | 2305 行                     | `packages/texra/src/tools/documents/`、`documentRecipe.ts`、`packages/texra/src/shared/plugins/documents.ts`                                                                              |
| 工具定义；工具代码                                            | 44；约 33000 行             | `packages/texra/src/tools` 20787 行，`packages/harness/src/tools` 12472 行                                                                                                                |
| 审稿簇：读 LaTeX 写批注，只有视角不同                         | 10 个                       | `critic`、`criticize`、`firstread`、`review`、`logic`、`notation`、`enhance`、`devise`、`codeReviewer`、`progressCheck`                                                                   |
| 改稿簇                                                        | 7 个                        | `correct`、`polish`、`generic`、`apply`、`merge`、`simplifier`、`codeSimplifier`                                                                                                          |
| 研究簇，共享同一段"Mathematical Communication"样板            | 6 个                        | `assistant`、`research`、`numerics`、`search`、`prover`、`review`                                                                                                                         |
| 编排簇，前两者工具列表完全相同                                | 3 个                        | `orchestrator`、`engineer`、`leanOrchestrator`                                                                                                                                            |

补偿层的清单，每一条都只为"39 个可用"而存在：

- `WorkspaceAgentsSelectionSchema` 的四种 kind（`inherit`、`all`、`team`、
  `custom`）、`HiddenCustomAgentKeysSchema`、`AgentDelegationScopeSchema`。
- 五个 team、starter、Teams 标签页、`apply_team` 工具、`setup` 里问学科
  的那段对话、`DEFAULT_TEAM` 设置、`cli.teamId`。
- `PREFERRED_TOOL_USE_AGENTS`、`NON_DEFAULT_TOOL_USE_AGENTS`
  （`packages/texra/src/shared/constants/agents.ts`）、composer 里的
  "Browse all agents…"、agent 选项上的 `isOrchestrator` 和 `rounds`。
- `customizeCopy`、`basedOn`、newer-built-in 提示。
- `DOCUMENT_TASK_OPTIONS` 这张表和它在四个面上的渲染（2026-11-03 刚把它收
  成一张表，见 `fewer-processing-options.md` §5；收成一张表是对的，但表
  本身还是"代码拒绝做的决定"）。

## 诊断

Ousterhout 的说法：当一个热点太复杂，找它背后的数据结构、重复的事实或放错
的所有者。这里放错的是"可创造的单位"。

agent 文件把三种不同的东西压进一个形状：

1. **模型调用的参数**：prompt、tools、temperature。`InlinePersonaSchema` 已
   经是它的精确定义，`agent()` 工具也已经接受内联的一份
   （`packages/harness/src/agent/runtime/delegation/AgentTool.ts`）。
2. **知识**：rubric、格式约定、领域用法。402 行的 `enhance.yaml` 几乎全是
   这个。
3. **流程**：几轮、每轮读什么、何时停。`task:` 块用 Nunjucks 写它，recipe
   用 JS 跑它。

把 2 和 3 塞进 1，目录就必然按"视角 × 流程"的积膨胀。四种审稿视角乘一种
批注流程是四个文件；再来一种流程就是八个。

"谁在跑什么"这个事实今天有五个表示：agent 文件、team、workspace 选择、
内联 persona、两种 script kind。设计的第一步是把它收成一个。

反过来看仓库已经做对的部分：codemode 文档
（`.agents/docs/implemented/architecture/2026-10-01-codemode-everywhere.md`）
把 `script` 做成了一个完整的运行时：QuickJS、按 settle 顺序的确定重放、
`agent()` 和 `self()` 是普通调用、模块源码按 specifier 钉在
`modules` 表里（`packages/harness/src/agent/codeSandbox/worker.ts` 的
`setModuleLoader`）。goal 插件已经把"策略"做成一个可替换的脚本模块。
documents 的 recipe 已经是 25 行 JS。缺的只是：**把这条路当主路，并让人
也能走。**

## 长期判断

前提（负责人裁决，见"决定记录"）：模型会变强。由此，价值从"对模型说什么"
转到四件事：验证器（编译、diff、测试、texcount、文献 API）、持久的编排（长
goal、恢复、预算、并行）、用户自己积累的程序和项目约定、以及可观测和可审批
的执行。提示词趋近于零；凡是提示词里教模型"按步骤做"的部分，都应该是一段
步骤被验证过的程序。

因此 3 年后的 TeXRA 应该是：一个持久执行 JS 程序的 harness，程序的操作是
模型调用和工具调用，历史是真相；TeXRA 产品本身是一组程序和一组工具。1.0
PRD 的第一句已经这么说了（"允许模型编写策略、能够可靠保存和恢复调用的
agent runtime"）。本提案是把这句话落到用户可创造的单位上。

三年尺度上要守住的不变量：

- **历史一个写者，run loop 一个程序**（AGENTS.md "Agent system"）。程序模块
  是 `script` 调用的 guest，不是第二个引擎。
- **持久化不随代码变**：钉住的源码和摘要是 run 的一部分；改 task 文件不改
  正在跑的 run，恢复用原源码。
- **一个 fact 一个 owner**：谁写了这段程序是一个字段，审批和重放从它推导。

## 设计

### 三种单位

| 单位     | 是什么                                          | 谁写             | 落在哪                                                                      |
| -------- | ----------------------------------------------- | ---------------- | --------------------------------------------------------------------------- |
| 程序模块 | 一个 ES 模块，默认导出 `async (args) => result` | 插件、用户、模型 | 插件：`builtIn:<name>`；用户：`.texra/tasks/`；模型：内联在 `script` 调用里 |
| 工具     | 带审批和重放语义的能力                          | 插件             | `Plugin.tools`，不变                                                        |
| 项目约定 | 这个项目的记号、引用、风格                      | 用户             | `AGENTS.md`，PromptBuilder 已经读它                                         |

不是单位的东西：

- **persona。** 一次子运行需要的只是 `{ system, tools, model }`，那是模型
  调用的参数，不是"角色"。persona 是 agent 文件时代的名词：把参数打包成可
  按名字引用的东西，是为了复用；代码里复用就是 import 一个对象或一段文本。
  harness 不为它设名词、不设文件格式、不设目录。
- **skill。** 可复用的文本是导出字符串的模块，
  `import { rubric } from './rubrics/logic.js'`。通用知识（Wolfram 怎么用、
  LaTeX 引号风格、Zotero 查重）删，模型会；TeXRA 特有的约定（`\criticize{}`
  的格式、输出文档的格式）进对应的程序模块。
- **team。** 一个目录里的几个 task 文件（"multi-agent 编排"一节）。

### run 的两类，三个全局

`AgentConfigSchema`（`packages/harness/src/shared/schemas/agentConfig.ts`）
今天是"persona 可选，script 可选，两种 script kind"。改成一个联合：

```
run.chat    { system, tools, model, instruction, files… }   内核的模型循环
run.program { source, modules, digest, author, title, tools, timeoutMs, args }   沙箱里的程序

agent(prompt, { system, tools, model, … })   启动一个 chat 子运行
task(name, args)                             启动一个 program 子运行
self(prompt, { fork })                       同 system、同 tools 的 chat 子运行
receive()                                    等自己收件箱的下一条消息（"大一统"一节）
```

- `background`、`recipe` 和用户 task 合为 `program`；`author`
  （`'model' | 'plugin' | 'workspace'`）是它们唯一的差别，决定两件事：
  `agent()` 是启动时随 launch 批准（`plugin`、`workspace`，用户刚刚点了启
  动，源码在文件里）还是开一次脚本请求（`model`，今天的 Q5）；以及 picker
  和 history 怎么标它。`recipe.block` 和 `recipe.options` 随 `task:` 块删。
- `chat` 的字段就是今天 `InlinePersonaSchema` 的字段换个名字，直接放在
  config 上，没有 `persona` 子对象、没有 `agent` 名、没有 `agentSource`。
  `run.config` 本来就把 inline persona 整个存下，持久化不变。
- `agent()` 的输入去掉 `agentName` 和 `persona`，直接取 `system`、`tools`、
  `model`；`self()` 的 `asCaller` 变成"复制父运行的 system 和 tools"。
- goal 策略成为第一个 `program` 消费者（它今天就是两行脚本 import 一个
  模块），documents 的 recipe 是第二个；两者都只用 `builtIn:` 来源，所以
  这一步不改任何用户可见的东西。
- 聊天本身仍是内核原生的模型轮次。"一切都是程序"（聊天循环也是 guest 脚
  本）与 run loop 唯一写者的契约冲突，不做；联合类型给它留门。

SDK 入口随之变直：`session.start({ system, tools, instruction })` 或
`session.start({ program, args })`；嵌入者给的是 system 文本和工具，不用先
学"agent 定义"。`nodePlatform({ agentsDir })` 变为 `tasksDir`。

### 程序模块的契约

```js
// .texra/tasks/annotate.js
import { rubric } from './rubrics/logic.js';
import { ANNOTATE_FORMAT } from 'builtIn:documents';

export const description = 'Inline \\criticize{} comments; never rewrites.';

export default async ({ files, context, media, instruction }) => {
  const ctx = await tools.document_context({ files, context, media });
  const reply = await agent(
    `${ANNOTATE_FORMAT}\n${rubric}\n${instruction}\n${ctx.prompt}`,
    {
      system: 'You annotate. You never rewrite.',
      tools: [],
      label: 'Annotate',
    },
  );
  await tools.document_extract({ run: reply.runId });
  const out = await tools.document_compile();
  if (!out.ok) {
    await agent(`Fix the build:\n${out.log}`, {
      tools: ['read_file', 'edit_file', 'bash'],
    });
    return tools.document_compile();
  }
  return out;
};
```

- `args` 是 launch form 已有的四组文件加指令（`LaunchSurfaceSchema`，
  `packages/texra/src/shared/session/surface.ts`），没有按 task 的输入
  schema。merge 这种双角色任务用 `context` 承担第二角色。
- 返回值是结果卡片；改好的文件走 `document_extract` 进 run 存储，
  `accept_run_files` 收回工作区，都是现成的。`phase()` 替代 "Pass 2 of 3"
  的 `rounds` 角标。
- `description` 供 picker 和 `task()` 的声明。发现时在无工具、带确定性前
  奏的沙箱里求值模块读它；模块顶层按规则必须是纯的。
- 没有按 task 的选项。`reflect`、`attachTeXCount` 这类开关是程序里的一行
  `if`；想要不同行为的用户改这 25 行，或者让 assistant 改。真需要一个开关
  的地方，是第二个文件。

### 三种来源，一个解析器

PRD 把工作区 import 推后，并要求到时"同时交付相对路径、越界和循环处理规
则，不提前建立无人消费的 resolver"。这里是那套规则，消费者就是 task：

1. `builtIn:<name>`：插件的 `scriptModules`，不变。
2. 相对路径：只在 task 所在根（`.texra/tasks/`、`~/.texra/tasks/`，或插件
   随包的 `tasks/`）内解析；`..` 越出根、绝对路径、`node_modules`、npm 包
   名一律拒绝，错误说明允许的形式。相对 import 一个非 `.js` 文件得到它的
   文本（模板、system 文本、rubric），和模块一样钉住。
3. 循环：解析整张图时检测，拒绝并列出环。
4. 钉住：启动时把图里每个模块的源码和一个内容摘要写进
   `AgentConfig.script.modules`；恢复用钉住的源码；文件改了下次启动才生效。
5. 形式：task 文件是 ES 模块，静态 `import` 语句（QuickJS 的模块加载器
   走 `setModuleLoader`）；模型的内联脚本是函数体，保留动态 `import()`。
   两者用同一个解析器。

导入不扩大调用者的工具或文件权限（PRD 原话）：一个 task 能调的工具是它
的 run 被 offered 的那些。

### built-in 与 custom 的边界

一句话：built-in 是产品承诺能跑的东西，custom 是用户积累的东西；两者的
关系是 import，不是覆盖。

一个东西是 built-in 要同时满足三条：零配置能跑（不依赖 Lean、Zotero、
Wolfram 这类外部件；需要外部件的归插件，带 `<plugin>:` 命名空间）；我们
测它（有 journey 或 E2E）；它编码的是 TeXRA 自己的契约（`\criticize{}`
的格式、输出文档的格式、`document_*` 的调用顺序），不是领域知识。rubric、
口味、学科约定是知识，归 custom 或 `AGENTS.md`。按这三条，built-in 只剩
两份 `(system, tools)` 常量（下节）和 documents 插件自己的八个 task 模块，
后者是 built-in 只因为插件得演示自己的工具怎么用。

custom 扩展 built-in 的方式是 import。bundled 的 task 把内部函数和参数一
起导出，用户包一层：

```js
// .texra/tasks/logic-review.js
import { annotate } from 'builtIn:documents';
import { rubric } from './rubrics/logic.js';
export const description = 'Annotate for argument structure only.';
export default (args) => annotate({ ...args, rubric });
```

上游改了 `annotate`，包装自动跟上；要完全不同的行为就复制那 25 行。今天
的 `customizeCopy`、`basedOn` 和 newer-built-in 提示存在的唯一理由是
built-in 太大、改得太勤，用户复制一份 400 行就漂移；两个条件都随本提案
消失，机制跟着删。

同名不覆盖。built-in 带 `builtIn:` 命名空间，永远不与用户文件撞名；项目
的 `.texra/tasks/` 和用户的 `~/.texra/tasks/` 之间撞名是扫描期错误，指出
两个路径。沉默的 shadowing 是 silent degradation。

一个棘轮：built-in 的数量只降不升。新增一个 built-in 要同时交一个 journey
测试，并写明它为什么不能是 custom 或插件。

### bundled 的两个 chat

没有 agents 目录之后，bundled 的"agent"是 `packages/texra` 里两份
`(system, tools)` 常量，由 host 的命令启动：

- **assistant**：chat 的默认参数。`system.md` 40 行以内：你在哪、工具怎么
  用、什么时候写脚本、什么时候 `task()`、怎么把跑通的脚本存成 task。工具
  是 offered 的全部。script-only。审稿、搜索、写代码不是目录项，是它在脚
  本里用不同的 `system` 字面量调 `agent()`；"只读审稿"是一个 `tools` 列
  表，不是一个文件。
- **setup**：首次运行的对话，带 `probe_environment`、`update_config`、
  `install_vscode_extension` 这组工具，由 setup 命令启动。删掉问学科选
  team 的一段。

`creator` 不保留：写一个 task 就是写一个文件，assistant 在 `system.md` 里
知道怎么做，`texra tasks types` 给它和用户同一份 `.texra/tasks/texra.d.ts`。
`prover`、`numerics` 不保留：它们的差别是工作方式的描述，不是工具集。

script-only 翻为默认：两个模型的评测通过率持平、每次成功的成本低 18% 到
66%（codemode 文档 "Still open"），按 Q10 补 glm 和 fan-out journey 后翻；
Q3 的按模型回退标志留给过不了线的模型。

### multi-agent 编排

编排不是被删掉，是回到它本来的形态：一段程序。codemode 文档已经写了
"`agent()` 是普通工具，所以 fan-out 工作流就是一个脚本"，并以此替掉了
`delegate_multi_agents` 和五种 `workflow.*` 行。今天的 `orchestrator` 和
`engineer` 是两段提示词，工具列表完全相同，只是告诉模型"拆任务然后调
`agent()`"。

留下的是机器：子运行带父边、一次脚本审批覆盖它的所有 `agent()`（Q5）、
会话级子运行并发预算（`CHILD_RUN_CONCURRENCY_BUDGET`）、goal 的花费上限、
`executions` 的运行间消息、子报告走 follow-up 收件箱、后台程序、Q2 的结果
复用、SQL 的 `run_tree` 和 `tool_calls` 视图。没有一个依赖 agent 文件或
team。

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
const annotated = await task('annotate', { files });
const applied = await task('apply', from(annotated));

// supervisor loop：builtIn:goal 已经是它，verdict 和花费上限的语义在里面
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

// 长期后台 + 消息
const worker = await agent('Watch CI and fix red builds.', {
  background: true,
  tools,
});
await tools.executions({
  action: 'send',
  run: worker.runId,
  message: 'PR #42 opened.',
});
```

team 给过的是一张"编排者可以挑的专家名单"。替代有两层：模型为当下需要的
专家当场写一段 system 文本（"模型会变强"的直接推论）；需要跨会话复用或带
专属工具的专家，是一个五行的 task 文件，`task()` 的声明列表就是名单。
Physicist 团队变成一个目录里的几个 task 文件，放在插件或模板仓库里；
lean4 的 `leanOrchestrator` 就是一个带 lean 工具的 task。

真正要补的只有发现：编排者今天从"available agents"里挑名字，之后要在脚本
声明里看到 task 的名字和 `description`，与工具声明并列。这是
`packages/harness/src/tools/codemode/declarations.ts` 加一段，不是新机制；
`searchTools` 已经覆盖工具。

不出 `builtIn:orchestration` 库（`fanOut`、`pipeline`、`supervise`）：
`Promise.all` 就是 fan-out，`task` 加 `from` 就是 pipeline。唯一值得作为库
出货的模式是 goal，因为它编码了 verdict、暂停原因和花费上限这些 harness
语义，而它已经在了。

`agent()` 与 `task()`、`self()` 一起作为 `script` 的全局始终提供；
`multi-agent` 插件的开关保留作为用户的一次同意。
`docs/guide/multi-agent-workflows.md` 改写成上面五个模式。

### document task 的归宿

15 个带 `task:` 块的文件（含 `write/` 两个和 `critic`）是同一个函数的 15
组参数，那个函数今天就是 25 行 JS 的 recipe。`builtIn:documents` 导出一个
原语，现在的 recipe 泛化后的样子：

```js
revise({
  files,
  context,
  media,
  instruction,
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

按参数去重后 15 个文件是 8 个，每个十几行：

| 今天                                  | 之后            | 差别只在                           |
| ------------------------------------- | --------------- | ---------------------------------- |
| correct, polish, generic              | `edit.js`       | requests 文字，由 instruction 区分 |
| criticize, firstread, logic, notation | `annotate.js`   | 无；它们独有的句子不保留           |
| enhance, devise                       | `enhance.js`    | 两段 requests                      |
| apply                                 | `apply.js`      |                                    |
| merge                                 | `merge.js`      |                                    |
| ocr, transcribe_audio                 | `transcribe.js` | 由媒体文件后缀决定                 |
| paper2slide                           | `slides.js`     | 模板 import                        |
| paper2poster                          | `poster.js`     | 三个模板 import                    |
| critic                                | `review` 参数   |                                    |

代码赢过 YAML 的地方是 `verify`：YAML 只能要求模型"别改别的"，代码可以
检查。`annotate` 断言 diff 只新增 `\criticize{` 行；`merge` 断言输出含原文
的每个 `\section`；`edit` 断言 texcount 没有掉一半；`slides` 和 `poster`
断言带模板能编译。每个几行，失败就是下一轮的输入。

模板不再用 `files:` 绑定变量，而是
`import template from './template_poster.tex'`（解析器规则 2）。

模型自己用同一个原语。用户说"把这篇校对一下"，assistant 不需要目录里有
`edit`：`const { revise } = await import('builtIn:documents')` 然后一行
调用。八个 bundled 文件只为两件事存在：picker 里的一次点击，和
`texra run edit paper.tex`。模型写的临时版本跑通了，`write_file` 进
`.texra/tasks/` 就是第九个。

### 启动面

picker 列 chat 和 task，仅此。`launchTarget: 'agent' | 'team'`、
`selectedTeamId`、`agent` 字段删。`texra run <task>` 一个命令，`texra chat`
照旧，`texra team`、`texra agents`、`texra skills` 删。`document_task` 工
具和 `builtIn:documents` 的 `revise()` 包装删，`from()` 留给串联。

`codemode/declarations.ts` 已经把每个工具渲染成 TS 声明给模型；同一份声明
由 `texra tasks types` 写成 `.texra/tasks/texra.d.ts`，编辑器里写 task 有
补全和类型检查。一个命令，不新增声明来源。

### 审批、重放与信任

- 审批不加新东西。`program` 的嵌套调用走和今天完全相同的 per-call 程序
  （hooks、guard、approval、settle）。
- 重放：源码和模块钉在行上，`ScriptDiverged` 照旧。
- 信任：工作区 task 是用户代码，在沙箱里以 run 的工具在审批下执行，和模型
  的脚本等价。它不会在用户没启动时跑；发现期的求值在零工具沙箱里，CPU 和
  内存受现有限制。一个不受信任的仓库的 `.texra/tasks/` 和它的
  `package.json` scripts 是同一种风险，由"用户启动"这一动作承担。

### 插件

`Plugin` 接口（`packages/harness/src/tools/plugins.ts`）去掉 `agentBlock`
（PRD 也说它"不应被写成 agent 模板发布接口"），`scriptModules` 不变，新增
插件随包的 `tasks/` 目录作为程序模块的第二来源；插件的 `agents/` 目录和
skills 一起删。documents 插件 = 它的工具加 `builtIn:documents`（`revise`、
常量和 `from()`）加 bundled 的八个 task 文件。lean4 插件 = 它的工具加几个
task 模块；5 个 agent 和 5 个 skill 一起删。

### 用户创造的闭环

这是选这条路最强的理由。模型在聊天里写了一段脚本，跑通了，用户说"存下
来"，assistant 把它写进 `.texra/tasks/x.js`（一次普通的 `write_file`，走
审批 diff）。下次 picker 里就有它，`texra run x` 能跑，进 git 能分享。目录
从使用中长出来，而不是从 vendor 的仓库里长出来；一年后 bundled 目录还是
那几个文件。

重放的确定性还给了一个后手：一次记录下来的 run 就是 task 的一份 fixture，
`texra run` 对着记录的调用重放一遍，就是不花模型钱的回归测试。本提案不
建它，但这条路只有程序模块才走得通。

## 接缝：run 怎么开始、怎么结束、结果去哪

在动单位之前把今天每一条"接起来"的路径列出来，看哪些是统一的、哪些不是。
结论先说：**结束的一侧已经是一个机制，开始的一侧有五种叫法，结果的读法
有一处插件特例。** 本提案改的只是后两者。

### 开始：谁启动一个 run，用什么命名它

| 入口                                        | 命名方式                                                                                                                                                                                                                | 代码                                                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| host 的 launch form                         | `agent` 名、`launchTarget: agent \| team`、`selectedTeamId`、选项表                                                                                                                                                     | `LaunchSurfaceSchema` → `session.start({ config })`                                                                                |
| `texra run <agent>`、`texra team run`       | agent 名、team id                                                                                                                                                                                                       | `packages/cli/src/commands/workflow.ts`、`team.ts`                                                                                 |
| SDK                                         | `agent: name \| InlinePersona` 或整份 `config`                                                                                                                                                                          | `StartRequestSchema`（`runtimeRequest.ts`）                                                                                        |
| host 自己按名字启动                         | `'latexFixer'`（编译失败后的修复，`script: null` 表示"聊天不是 recipe"）、`'merge'`（合并动作）、`'setup'`（onboarding）、`'polish'`（文本润色的 helper 调用标签）、schema 默认 `'correct'`、form 默认 `'orchestrator'` | `compileFixer.ts:130`、`hostRunActions.ts:437`、`setupLaunch.ts:53`、`textEnhancement.ts:50`、`agentConfig.ts:11`、`surface.ts:78` |
| 模型：`agent()`                             | `agentName` 或内联 `persona`；`requireAgent` 在"可启动的 agent"里按 scope 和 shadowing 解析                                                                                                                             | `AgentTool.ts`、`proposalFlow.ts:50`                                                                                               |
| 模型：`document_task()`                     | agent 名，子 run 开在 recipe 上，`script.kind: 'recipe'` 加 `block` 和 `options`                                                                                                                                        | `DocumentTaskTool.ts`                                                                                                              |
| 模型：`self()`                              | 同一个 agent；fork 用 `forkSeed` 的 cut，或 fresh                                                                                                                                                                       | `SelfTool.ts`、`forkRun.ts`                                                                                                        |
| 模型：`script` 后台、plan 的 "Run as Goal"  | 父 run 的 agent 和工具，`script.kind: 'background'`                                                                                                                                                                     | `backgroundScript.ts`、`PlanTool.ts`、`goalScript.ts`                                                                              |
| 进程子运行（后台 bash、claude_code、codex） | 工具自己供给那一轮                                                                                                                                                                                                      | `processRun.ts`                                                                                                                    |
| 恢复、fork、聊天续轮                        | 同一份 rows；`run.fork` 带 provenance；`continues` 继承上一轮的人工授权；`interactive` 让 run 等后续消息                                                                                                                | `resumeRun.ts`、`forkRun.ts`、`rootLaunch.ts:111`、`FollowUps.ts`                                                                  |

一个 run 要跑什么，今天有五种表示：agent 名、team、内联 persona、recipe
块、script kind。它们在同一张 `AgentConfig` 上共存，靠 `agentSource`、
`persona`、`script`、`delegationAgentScope`、`cli.teamId` 五个字段互相排
斥。本提案收成两种（`chat`、`program`），上表每一行的"命名方式"变成：
host 和 CLI 启动 `chat`（默认）或一个 task；SDK 给 `{ system, tools }` 或
`{ program, args }`；模型用 `agent()`、`task()`、`self()`；host 自己启动的
六处变成对 bundled 常量或 bundled task 的调用（`fix-build` 是一个 task，
`merge` 是一个 task，setup 是一份 chat 常量，`polish` 标签随目录消失，两
个默认值删）。`requireAgent` 的 scope 和 shadowing 解析删。

### 结束：一个终点，一种投递

这一侧已经统一，本提案不动它：

- **一个终点。** 每个 run 的 fiber 不管怎么退出都到 `endRun`
  （`AgentRunLifecycle.ts`），一次事务写 `run.end`
  `{ outcome, error, output: { response, files, structured } }`，同一事
  务把子 run 的报告（`run.report`）排进父 run 的收件箱（`runLifecycle.ts`
  "endRunRows"），除非父调用在等它。
- **等与不等。** 脚本里的 `agent()` 默认等（`childLaunch.ts`，直接读子 run
  的 end，解析成 `{ response, files, structured?, runId, outcome, cost, spent }`）；
  `background: true`、直接调用、后台脚本、进程子运行走收件箱，父 run 下
  一轮把整批排队项合成一条 user 消息（`FollowUps.ts`）；one-shot 父 run
  在带内等。投递的信封只有一个构造器（`deliveryEnvelope.ts`），子 agent、
  后台 bash、后台脚本、agent CLI 共用。
- **停止与遗留。** `run.stop` 行加 fiber 中断；被停的子 agent 不投递，被停
  的脚本投递一条"要恢复的 run"的通知；进程死掉留下的子 run 在父 run 恢复
  时按自己的 id 恢复，不能恢复的报一次"结果未知"（`leftoverChildren.ts`）。
- **goal。** 结果是 `completed` 或 `paused`（`needs_user`、`round_failed`、
  `no_verdict`、`spend_cap`）；"暂停是一个结果，不是一个在等的 run"，继续
  是新的 goal 或新的一轮。

### 结果怎么被读：唯一的插件特例

`output.structured` 有三种来源：`submit_output` 终端工具（带
`outputSchema` 的 run）、recipe 脚本的返回值、后台脚本的返回值。前者和后
者的读法是通用的：后台脚本投递"它的调用、调用写的文件、子 run 花了多少"
（`scriptRun.ts` 的 `scriptEndDelivery`，文件由 `scriptRunCalls` 从调用结
果折出来）。recipe 是特例：`recipeResult.ts` 按 `script.block` 找到插件的
`AgentBlock.result`，用它的 `schema` 校验、`delivery()` 生成投递正文、
`changes()` 列出写了哪些文件（`DOCUMENT_TASK_RESULT`，
`documentResult.ts`）。这是 harness 里唯一一处"读一个结果要问插件"。

本提案删掉它：一个 program 的结束就是一个脚本的结束。投递是通用的调用摘
要加文件列表加返回值（JSON，有界），`document_propose` 的结果行本来就含
"提议的文件和 diff"，摘要把它带上。`AgentBlockResult`、`recipeResult.ts`、
`DOCUMENT_TASK_RESULT.delivery/changes` 删；documents 的 fact（UI 读 diff
和 accept 用的）照旧由 `document_propose` 写。

### 两个要注意的细节

- **文件字段两类 run 都要。** `document_context` 从 `run.config` 读启动
  时的 inputFiles、contextFiles、mediaFiles、outputFiles，launch form 和卡
  片也显示它们。`NullableFileFieldsSchema` 留在联合的两个分支上；
  `program.args` 就是这四组加 `instruction`。
- **`self()` 只在 chat 的脚本里有意义。** 今天 "A task's script has no
  conversation to fork" 已经拒绝 recipe 里的 fork；program 里没有
  system 和 tools 可"再跑一次自己"，`self()` 在 program 里是错误，用
  `agent()`。Q2 复用的 key 对 program 子 run 是源码摘要加 args 的文件指纹
  加模型，替代今天的 `agent.name`、`persona`、`task.options`。

## 大一统：程序加收件箱

goal mode 之所以看起来 codemode native，是因为它把三件事分开了：触发是
一次按钮（批准 plan），启动是一段两行脚本（`goalScript()`），策略是一个可
替换的模块（`goal.strategy`）。把这三件事推到每一个入口上，就是统一。

两条公理，仓库里各有一半：

1. **凡是在跑的东西都是程序。** 叶子是模型循环（chat），其余都是调
   `agent()` 的程序。goal、document recipe、后台脚本、用户 task 是同一类
   （"run 的两类"）。
2. **凡是发生在一个程序身上的事都是它收件箱里的一条消息。** 收件箱已经通
   用：用户文本、子 run 的报告、同级消息、订阅通知（PR webhook）都走它
   （`agent/followUp/`，"runs talk as a graph: any run may message any run"）。

于是触发就是发消息，所有入口归成一种：

| 触发                          | 今天怎么接                                       | 统一后                                                                       |
| ----------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| 批准 plan，"Run as Goal"      | `goalScript()` 生成两行脚本，`PlanTool` 特殊启动 | `start({ program: goal, args })`，不特殊                                     |
| launch form 点 Run            | 按 agent 还是 task 拼不同的 `AgentConfig`        | `start({ program: edit, args })`                                             |
| `texra run`                   | 同上                                             | 同上                                                                         |
| 编译失败后修复                | `compileFixer.ts` 手拼 config 启 `latexFixer`    | `start({ program: fix-build, args: { run } })`，或 task 自己在 `verify` 里修 |
| 模型要 fan-out                | 脚本里 `Promise.all(agent…)`                     | 不变，这本来就是统一后的样子                                                 |
| PR 开了、CI 红了              | 订阅通知投进某个 run 的收件箱                    | 投给一个在 `receive()` 上等的程序                                            |
| 用户在聊天里回话              | chat 叶子的下一轮                                | 不变                                                                         |
| 一个程序要等另一个            | `executions wait`                                | 不变                                                                         |
| host 的其他事件（保存、定时） | 无                                               | host 的 `followUp.send`（`session.request` 已有这扇门）                      |

### 缺的那一个原语：`receive()`

今天脚本不能读自己的收件箱（codemode 文档："a script never reads its
inbox; a result it awaits is an `agent()` value"）。程序只能"启动、等子
run、结束"，不能"等事件"。goal 的 `needs_user` 因此必须结束 run，用户回话
是父聊天的新一轮，再开一个新 goal。

加一个全局 `receive()`：等自己收件箱的下一条消息。它是一次普通调用：结果
是那条消息，记在行上，重放时交回；等待是 `run.position waiting`，叶子已
经有这个位置。有了它：

```js
// .texra/tasks/ci-watch.js
await tools.github_subscription({ repo, events: ['check_run'] });
for (;;) {
  const event = await receive();
  if (event.kind === 'check_run' && event.conclusion === 'failure')
    await agent(`Fix the red build:\n${event.log}`, {
      tools: ['bash', 'read_file', 'edit_file'],
    });
}
```

这就是 dispatch multi agent flow、goal、document task、CI 看守变成同一种
东西的那一步：一个有收件箱的程序。触发器不需要一张事件表，程序自己订
阅、自己等；host 的事件全是 `followUp.send`。

### 边界

- **chat 叶子是唯一不是程序的东西。** 把它也包成
  `return agent(msg, { interactive })` 可以做到一切皆程序，但每个对话多一
  个 run 层，卡片多一层，没有收益。goal 已经付了这层代价（后台脚本加
  `self()` 子 run），它值；聊天不值。
- **PRD "暂停是一个结果，不是一个在等的 run"不被推翻。** 一个策略可以选择
  结束并返回 `paused`，也可以选择 `receive()`。哪个是默认由 `builtIn:goal`
  这段代码决定，内核两样都给。这正是"策略是代码"的意思。
- **沙箱的"没有定时器"不变。** 定时触发是 host 往收件箱发消息，程序只是
  `receive()`。
- **脚本 24 小时的墙钟上限**要为长期程序放开，或让 `receive()` 的等待不
  计入；否则 CI 看守一天一断。

## 其他 surface：目录概念今天伸到哪里

逐个面清点"agent、team、skill、document task、编排者"这些概念的触点
（只读清点于 `c4c843a`；计数为该面的总条目数与其中涉及这些概念的条目数）。

| 面                       | 总数            | 涉及概念                                                                                                                                                                                                                                                 | 本提案之后                                                                                                                                                |
| ------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 设置页                   | 6 页，12 个 tab | `agents` 页的四个 section（library、teams、skills、advanced）；`AgentsTab`、`TeamsTab`、`SkillsTab`、`AgentSelectionPanel`、newer-built-in 提示（`settingsTarget.ts:37`）                                                                                | 一个 `tasks` 页：列文件、显示源码、打开编辑器；advanced 里留"Agents at once"（子运行并发预算）                                                            |
| 设置页 IPC               | 约 63 种        | 19 种：15 入站（openAgentYaml、setAgentEnabled、createAgent、customizeAgent、applyAgentModePreset、setSkillEnabled…）、4 出站（`packages/texra/src/shared/ipc.ts:47-106`）                                                                               | 约 3 种：列 task、打开 task 文件、打开 tasks 目录                                                                                                         |
| 进度视图的 host 请求     | 36 种           | `launch`（`launchTarget`、`selectedTeamId`、`agent`、选项表字段）、`agentConfigBanner`、`onboarding.runSetup`、`runCompileFixer`、`polish`（`hostRequest.ts:36-238`）                                                                                    | `launch` 只带 chat 或 task 名加四组文件和指令；`agentConfigBanner` 删；`runCompileFixer` 变 `task('fix-build')`；setup 和 polish 照旧                     |
| VS Code 命令             | 38 个 id        | `texra.execute`（"Execute Agent"）、`texra.showAgents`、`texra.showTeamSettings`、`texra.runSetupAssistant`、`texra.createSampleProject`                                                                                                                 | `showTeamSettings` 删，`showAgents` 变 `showTasks`，其余保留                                                                                              |
| 设置目录行               | 约 70 行        | `workspaceAgents`、`hiddenCustomAgents`（repo state，无 UI 行）、`skills.enabled/disabled/disabledSources`、`chat` 的 agent 部分、`codeMode.scriptOnly`、`goal.strategy`、`childRunConcurrencyBudget`                                                    | 前五项删；`scriptOnly` 随 K5-c 删；`goal.strategy` 留（它是程序模块的先例）；并发预算留                                                                   |
| CLI                      | 23 个命令       | `agents`（list/show/customize/reset/keep）、`team`（list/show/run）、`skills`、`config agents`、`chat --agent`、`run <agent>` 加选项表 flag、`setup`                                                                                                     | `agents`、`team`、`skills`、`config agents`、`--agent` 删；`run <task>` 不带选项 flag；`setup` 留                                                         |
| SDK 导出                 | 约 515 个名     | 约 40 个概念命名的导出：`AgentCatalog` 一族 6、`WorkspaceAgents` 一族 4、`AgentDirectories` 一族 9、`Skills` 一族 8、`AgentBlock` 2、`Persona`/`InlinePersona`/`AgentSource`/`isTaskConfig`/`AgentScanIssue` 等（`host.ts`、`schemas.ts`、`plugins.ts`） | 全删。`AgentConfig`、`AgentProposal`、`AgentEvent`、`AgentPlatform`、`AgentTrace` 是 run 的词汇，名字不动。这正是 general-package 设计要缩的 `host.ts` 面 |
| `session.request` 的请求 | 13 种           | 无                                                                                                                                                                                                                                                       | 不变；`StartRequest` 改为 `{ system, tools, instruction }` 或 `{ program, args }`                                                                         |
| 模型或 host 打开的请求   | 7 种            | `proposal`（`AgentProposalPermission`，子运行的启动审批）                                                                                                                                                                                                | 留；字段从 agentName 和 persona 改为 system 文本和工具列表，审批界面显示它们                                                                              |
| `docs/guide`             | 32 页           | 16 页超过 20 次提到 agent；重写量最大的是 `built-in-agents`、`custom-agents`、`multi-agent-workflows`、`agent-architecture`、`texra-cli`；`open-source` 和 `configuration` 讲 skills                                                                     | 前四页分别改成 task 参考、写 task、五个编排模式、两类 run；skills 段删                                                                                    |
| 引用 bundled 名字的代码  | 61 个源文件     | `orchestrator` 32 个文件、`workspaceAgents` 18、`agentTeams` 12、`criticize` 10                                                                                                                                                                          | 随删除消失                                                                                                                                                |
| 引用 bundled 名字的测试  | 1 个            | `CriticismParser.vitest.ts`，用的是 `\criticize` 宏不是 agent                                                                                                                                                                                            | 无 fixture 要改                                                                                                                                           |

两点值得单独说：

- **测试没有绑在目录上。** 122 个包内测试文件和 197 个根 `src/` 文件里，没
  有一个 fixture 引用 bundled agent 名或 team。删目录不带来测试搬家。
- **SDK 的 `host.ts` 面缩一小半。** general-package 设计想把根导出从 246
  缩到 59，并点名 team 词汇和 `AgentDirectoriesPort.teams` 是留在 harness
  里的应用词汇；本提案删的约 40 个导出正是那一块，不用另开一条线。

## 删除账

| 删什么                                                                                      | 行数（量于 `c4c843a`） | 留什么                                        |
| ------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------- |
| 34 个 bundled agent 文件、lean4 的 5 个 agent 和 5 个 skill                                 | ~4400                  | 两份 `(system, tools)` 常量，约 200 行        |
| agent 索引、`AgentSource`、插件 agent 加载、`InlinePersona` 和 `AgentDefinition` schema     | 1410 + ~200            | 无                                            |
| team：预设、启动、CLI、标签页、`apply_team`、设置                                           | 1264                   | 无                                            |
| workspace 选择、hidden keys、delegation scope、agent 设置页                                 | ~2400 of 2930          | 一个 Tasks 页（列文件、显示源码、打开编辑器） |
| skills 子系统                                                                               | 1521                   | 无                                            |
| `task:` 块、Nunjucks、`files:`/`outputs:`、选项表、`rounds`、`critic.yaml`、`document_task` | ~900 of 2305           | 文档工具本身和 `revise`                       |
| CLI：`texra agents`、`texra team`、`texra skills`                                           | 734                    | `texra run`、`texra tasks types`              |
| 新增：模块解析器、`program` kind、task 加载器、`task()` 和声明、Tasks 页、types 命令        | 约 +1200               |                                               |

净减约 1.1 万行，其中约 4400 行是提示词。

## 与已有裁决和 PRD 的关系

四处需要负责人明确改口，本提案不假装它们不存在：

1. **codemode Q8 "No script files"**（2026-10-02）。收窄为：模型写的脚本
   仍不落文件；人和插件写的程序是文件，源码和摘要钉在 run 上。recipe 今天
   就是这样，所以这是把已有做法说成规则，不是新路径。
2. **PRD "Agent 文件和 imports"，两种组合方式**：原文保留"参数化 prompt"和
   "脚本模块"，并把工作区 import 推后。本提案只留一种（脚本），并把工作区
   import 连同它的规则提前到 1.0。理由：两种组合方式就是两个解析器、两套
   文档、两种心智模型；task 块的 Nunjucks 能表达的，25 行 JS 都能表达，反
   之不然。
3. **PRD "Agent 文件和 imports"，agent 文件本身**："Agent 文件是可复用的
   persona 和能力配置… 文件形式本身不需要被替换"，以及 R6 的"文件与 inline
   定义一致"验收。本提案没有 agent 文件也没有 persona，只有 chat 的参数；
   R6 因只剩一种形式而平凡成立。
4. **skills**（Claude Code / Codex 互操作的一部分，PRD "安装式 manifest"
   一行）。删掉它失去导入第三方 skill 包；模型仍能 `read_file` 用户指给它
   的任何 Markdown，程序能 import 任何文本。安装式插件的 commands、MCP 和
   hooks 不受影响。

不与之冲突的：无流程引擎、历史一个写者、`agent()` 替代 delegation 工具
（Q7）、Q2 的结果复用、Q5 的一次脚本审批、1.0 的 SQL 只读视图。

## 更彻底的方案：Unix

比本提案再往前一步就是 Unix。记录它，是为了说明本提案停在哪里、为什么，
以及从它借走什么。

### E：texra 是一个过滤器，shell 是编排器

Unix 的四条原则逐一套上去：

- **模型是过滤器。** `cat paper.tex | texra ask -s proofread.md > out.tex`。
  `texra` 是读 stdin 写 stdout 的命令，背后一个 daemon 存历史。没有 agent，
  system 文本是 `-s` 后面的文件。
- **task 是可执行文件。** `.texra/bin/annotate` 是任意语言的脚本，里面调
  `texra ask`、`latexmk`、`latexdiff`。流水线是管道：
  `texra annotate paper.tex | texra apply paper.tex`。bundled 和 custom 的区
  别只是在 PATH 上的位置。
- **工具是 PATH 上的 CLI，不是插件。** 今天有 44 个工具定义，约 33000 行工
  具代码。Wolfram 已经是"在 bash 里跑 wolframscript"，latexdiff、texcount、
  pdftotext、arxiv、Zotero 本质上都是一个 CLI 加一段 `--help`。模型本来就
  会用 CLI；bash 工具加命令守卫就是整个集成机制，MCP 通过一个桥变成 CLI。
  `Plugin` 接口缩成"PATH 上的一个目录加 `AGENTS.md` 的一段"。
- **持久化靠内容寻址，不靠重放。** 下一小节。

删掉的东西：agent 目录、插件系统、QuickJS 沙箱、模块解析、task 契约、
skills、teams，和三个 host 里渲染嵌套卡片树的大部分。剩下：一个 CLI、一个
daemon、按目录分层的 `AGENTS.md`、`.texra/bin`、make。

### make 是什么意思：缓存对重放

`make` 是 Unix 的构建工具：Makefile 写明每个目标文件依赖哪些输入、用什么
命令生成；make 只重做输入比目标新的步骤。构建中途失败再跑一次，做完的目
标直接跳过。现代变体（nix、bazel）不看时间戳看内容哈希：输入内容没变，
产物直接复用。这是 Unix 对"流水线中断了怎么续"和"改了一行要不要全重跑"
的回答：不记录执行过程，只缓存产物。

套到 TeXRA：目标是 task 的产物（run 存储里 `r0/` 的文件）；输入是输入文
件的内容、task 源码的摘要、指令和模型；命令是跑这个 task。Q2 的结果复用
（codemode 文档 "Cross-script reuse"）今天就是它的雏形：`agent()` 的结果按
prompt、每个影响运行的选项和每个引用文件的指纹哈希，范围是发出 `script`
调用的 run 和它的后台脚本。扩到 `task()`、跨 run 生效，就是"改了 `paper.tex`
一行，重跑整条流水线，只有输入变了的步骤真的跑"。

它和重放的区别：

|        | 重放                                           | 缓存                                 |
| ------ | ---------------------------------------------- | ------------------------------------ |
| 范围   | 一个 run 内                                    | 跨 run                               |
| 做什么 | 按记录顺序把结果交回程序，精确续跑被中断的程序 | 按输入匹配复用产物                   |
| 性质   | 正确性需要它                                   | 优化，也是 Unix 式的持久化           |
| 钥匙   | 调用序号加 `(toolName, input)` 一致            | 输入内容、源码摘要、指令、模型的哈希 |

完整的 E 用缓存替代重放，这是它最大的代价：一个跑了三小时的 goal 进程死
了，能续的前提是每一步都幂等且已缓存，脚本本身可以重跑。E-lite 两者都留。
能安全缓存的前提是产物不直接改工作区，而是进 run 存储再由用户 accept；这
正是 documents 今天的设计，也是 `task()` 比 `agent()` 更适合缓存的原因。
两套机制是否能收成一个按内容寻址的调用结果表（幂等调用按内容取结果，不幂
等的按序号；`replay: 'safe'` 已经是那个声明），是本提案之外值得单独想的
问题。

### 它撞的四面墙

- **Windows。** 学术用户相当一部分在 Windows 上用 VS Code 扩展，"shell 是
  编排器"在那里没有 shell。这一条单独就否决 E 的字面版本。
- **1.0 PRD 的 P0 承诺。** 公开 SDK 入口、调用持久化的故障点测试、运行所有
  权、codemode 的重放，全是进程内契约。E 把 SDK 变成 "spawn texra"，是另一
  个产品。
- **审批粒度。** 沙箱让每个嵌套调用在执行前过 hooks、守卫、审批，并在卡片
  树里可见；shell 脚本要调什么，跑到那一行才知道。
- **三个 host 的 UI。** 嵌套卡片、diff 视图、accept files、Pass N of M 全来
  自 run history 的行，进程只有 stdout。

### E-lite：把原则搬进来，不搬掉 harness

本提案已经是"everything is a file"：task、system 文本、rubric 是文件，run
是目录，memory 是文件。还差四条，每条都能单独落：

1. **工具是 CLI，bespoke 工具要有理由。** 一个插件工具只在三种情况下有资
   格存在：需要审批语义（write、edit 的 diff 审批）、需要写 run history 的
   行（`document_*`、`agent()`）、需要结构化结果供脚本分支。其余的
   （extract_figures、extract_bib_entries、arxiv、Zotero、latex preview）变
   成 `.texra/bin` 或随包的 CLI，模型用 bash 调，`--help` 是文档。这一刀砍
   的是三万三千行里最大的一块，也让 `Plugin` 接口瘦一半。它把插件作者的扩
   展方式从"写一个 Plugin"改成"写一个 CLI"，是负责人问题 6。
2. **发现靠文件系统，不靠目录。** picker 和模型都读 `.texra/tasks/` 和
   `.texra/bin/`，`description` 和 `--help` 就是元数据。没有注册、没有设置页
   里的 catalog。
3. **headless 走文本流。** `texra run` 已经输出 NDJSON；再让它从 stdin 读
   文件列表、向 stdout 打产物路径，shell 组合就免费了：
   `texra run annotate paper.tex | texra run apply`。
4. **缓存是一等机制。** 把 Q2 的内容寻址复用从 `agent()` 扩到 `task()`，
   范围从一个 run 扩到会话。重放仍负责中断续跑，缓存负责"改了一行重跑整
   条流水线"。

`.texra/tasks/*.js` 仍是 JS 而不是 bash，只因为 Windows 和重放；它已经是
"小程序、文本进出、靠文件组合"的东西。本提案的推荐是上文的设计加这四条；
第 1 条收益最大、争议也最大。

## 权衡

- **确定性对灵活性**：程序钉在 run 上，所以一个 task 的行为在运行中不变；
  代价是改了文件要重新启动才生效。这是 PRD 要求的，不是代价。
- **不会编程的用户**：YAML 从来没有比 25 行带模板字符串的 JS 更容易；402
  行的 YAML 没人读得完。assistant 代写，`texra.d.ts` 给补全。
- **换一个口吻聊天**：由 `AGENTS.md` 承担，它是项目级的。按会话切换
  system 文本是弱模型时代的需求；要它的人写一个三行 task 调 `agent()`。
- **弱模型**：script-only 对 DeepSeek 和 Gemini flash 已验证；更弱的模型
  走 Q3 回退，它们本来也跑不动 400 行 rubric。前提的下行有界：某个便宜模
  型在某类论文上确实需要一段 rubric，用户写三行 task import 一段文本就有
  了，不需要为所有人预留 400 行。
- **可发现性**：34 个名字至少告诉用户 TeXRA 能干什么。缩到 9 项后，Tasks
  页和 `docs/guide/built-in-agents.md` 改写成 task 参考页承担这个角色。
- **破坏范围**：1.0 不保兼容。用户的 custom agent 和 custom team 失效，
  changelog 写迁移路径：team 变插件开关或一个目录的 task，agent 变 task
  或 `AGENTS.md`；不写 YAML 到 JS 的转换器（AGENTS.md 禁止 legacy reader），
  由 assistant 对话完成。

## 分期

每一期独立可合，前一期不依赖后一期的决定；每期拆成能单独 review 的小 PR。

1. **`program` kind 和解析器**（harness，无用户可见变化）：`AgentConfig`
   联合（`chat` 的字段先与今天的 `persona` 并存，第 4 期删后者）；三种来源
   一个解析器，先只开 `builtIn:`；goal 策略和 documents recipe 改走它。同
   时在 codemode 文档记录 Q8 的收窄。
2. **工作区 task 和脚本面**：`.texra/tasks/` 来源、ES 模块、文本 import、
   `task()` 全局和它在声明里的 task 列表、`agent()` 改取 `system`/`tools`、
   `texra run <task>`、Tasks 页、`texra tasks types`。先做 `revise` 原语
   和 `edit.js`、`annotate.js`，journeys 跑一次作回归检查；再移剩下六个；
   最后一个 bundled task 移完就删 `task:` 块、Nunjucks、选项表、
   `document_task`、`critic.yaml`。
3. **script-only 翻默认**：补 Q10 两项，翻；回退标志留。
4. **删补偿层和 agent 文件**：agents 目录、agent 索引和 schema、team、
   workspace 选择、skills、customize、三个 CLI 命令；`assistant` 和 `setup`
   成为两份常量；SDK 的 `start` 改取 `system`/`tools`（在 1.0 API 冻结前）；
   文档和迁移说明。
5. **（可选，负责人问题 6）工具改 CLI**：先从 `latex-extract` 和 `arxiv`
   两个插件试。

## 负责人问题

1. 接受四处改口（Q8 收窄、PRD 的一种组合方式、PRD 的 agent 文件、删
   skills）？
2. 发现期对 task 模块求值（零工具沙箱）还是静态提取 `description`？推荐：
   求值，一个解析器；顶层必须纯是规则，违反时错误指出来。
3. 第 1 期先做，还是等 1.0 PRD 的在途线（线 7、9、11）合完？推荐：第 1
   期只碰 `agentConfig.ts`、`goalScript.ts`、`documentRecipe.ts` 和沙箱的
   模块加载，和在途线不重叠，可以并行。
4. E-lite 第 1 条：把只包装一个 CLI 的插件工具改成 `.texra/bin` 或随包的
   CLI，bespoke 工具只留需要审批语义、写行或结构化结果的？推荐：接受，
   作为第 5 期，先从 `latex-extract` 和 `arxiv` 两个插件试。
5. **名字。** 本文用"task"称程序模块，但 `texra tasks` 今天已经是服务里的
   运行（列出、附着、停止），"document task"也是旧词。候选：`recipe`（代码
   里已经用它指这个东西：`script.kind: 'recipe'`，`documentRecipe.ts`）、
   `program`、`workflow`（AGENTS.md 禁的是流程引擎，不是这个词，但容易误
   读）。推荐 `recipe`：`.texra/recipes/`、`recipe('annotate', args)`、
   `texra run <recipe>`、`texra recipes types`。定了之后本文一次 grep 改名。
6. **`receive()`。** 加这个全局，让程序能等自己收件箱的下一条消息（"大一
   统"一节）？它让触发器统一成发消息，代价是脚本的墙钟上限要为等待放
   开。推荐：加，放在第 2 期之后作为第 3 期的一部分，先用 CI 看守一个
   bundled task 验证。

## 决定记录

负责人 2026-11-06：

- 模型会变强是设计前提，不是待验证的假设。rubric 和通用领域知识现在就删，
  评测只作回归检查。
- persona 不是单位："import code 更 end to end"。`prover`、`numerics` 随之
  直接变成 `agent()` 的一行参数。
- 不要 skills。
- 要 fully embrace codemode；document task 是有用的，保留其能力。
- multi-agent 编排要考虑在内（"multi-agent 编排"一节）。

## 不做的事

- 不做流程引擎、不做第二个 run history 写者、不做任务调度器。
- 不做 npm 包解析、不做远程依赖、不做 `..` 越根。
- 不做按 task 的输入 schema 或选项表。
- 不做 YAML 到 JS 的兼容转换器。
- 不做编排库；goal 是唯一出货的模式，而它已经在了。
- 不在本提案里做"聊天也是程序"。

## Verified

- `ls packages/extension/resources/agents/*.yaml | wc -l` 得 34；
  `grep -l '^task:'` 得 15（含 `write/` 两个）；15 个的 `tools:` 为空，
  `requests:` 长度 1 或 2，`write/paper2slide.yaml` 和
  `write/paper2poster.yaml` 带 `files:`。
- `wc -l` 的各项行数如"现状的度量"表。
- `packages/harness/src/agent/codeSandbox/worker.ts` 的 `setModuleLoader`
  按 `input.modules` 解析 specifier，相对路径今天被拒绝，错误信息列出可
  import 的名字。
- `packages/harness/src/tools/plan/goalScript.ts` 的 `goalScript()` 生成两
  行脚本：`import` 设置指名的策略模块，调用其 `goal`。
- `AgentTool.ts` 的输入含 `persona` 字段；`InlinePersonaSchema` 在
  `packages/harness/src/shared/schemas/agent.ts`。
- `LaunchSurfaceSchema` 含 `launchTarget`、`selectedTeamId` 和
  `DocumentTaskOptionsSchema` 的字段。
- `packages/cli/src/commands/tasks.ts` 的 `texra tasks` 指服务里的运行。
- codemode 文档 "Still open" 的两轮评测表：`only` 对 `direct`，DeepSeek
  每次成功 $0.0017 对 $0.0020，Gemini $0.0155 对 $0.0463。
