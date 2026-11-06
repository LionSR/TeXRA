---
created: 2026-11-06
status: proposed
---

# 程序，不是 agent：目录、codemode 和长期的单位模型

基线：`main` 的 `c4c843a`（2026-11-06）。路径相对仓库根。度量用
`wc -l` 和 `grep`，在"现状的度量"一节逐条给出命令可复核的数字。

## 摘要

TeXRA 今天只有一种用户可创造的单位：agent 文件。于是审稿视角是 agent，
Wolfram 用法是 agent，一条 `latexdiff` 命令也是 agent。bundled 目录到了
34 个（加 lean4 插件 5 个），随后长出了一整层让 39 个"可用"的补偿机制：
team、workspace 级 agent 选择、排序和黑名单、customize 副本和漂移提示、
launch form 的选项表。负责人的判断是"available 的 agent 太多，补偿太多"。
这份提案的结论是：**数量是症状，单位是病因。** 把组合单位换成程序模块
（沙箱里的 JS），persona 退回成程序的一个参数，补偿层整层消失，而且新能力
长在用户的项目里而不是 bundled 目录里。

这不是一个新方向。仓库里已经有三处"run 是一段程序"：goal 策略是一个
脚本模块（`packages/harness/src/tools/plan/goalScript.ts`，由设置
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
| team 预设（加一个不进 UI 的 starter）                         | 5+1                         | `packages/texra/src/shared/agentTeams.ts`                                                                                                                                                 |
| team 相关代码                                                 | 1264 行                     | `agentTeams.ts`、`teamLaunch.ts`、`packages/cli/src/commands/team.ts`、Teams 标签页和 `apply_team`                                                                                        |
| workspace 选择、hidden keys、delegation scope、agent 设置页   | 2930 行                     | `packages/harness/src/agent/workspaceAgents/`、`packages/harness/src/shared/schemas/workspaceAgents.ts`、`packages/extension/src/settingsView/frontend/tabs/AgentsTab.ts` 及 profile 组件 |
| agent 索引（扫描、customize 副本、`basedOn`、newer-built-in） | 1410 行                     | `packages/harness/src/agent/index/`                                                                                                                                                       |
| skills 子系统                                                 | 1521 行                     | `packages/harness/src/skills/`、`packages/cli/src/commands/skills.ts`                                                                                                                     |
| documents 插件（工具、recipe、task 块、选项表）               | 2305 行                     | `packages/texra/src/tools/documents/`、`documentRecipe.ts`、`packages/texra/src/shared/plugins/documents.ts`                                                                              |
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
  "Browse all agents…"。
- `customizeCopy`、`basedOn`、newer-built-in 提示。
- `DOCUMENT_TASK_OPTIONS` 这张表和它在四个面上的渲染（2026-11-03 刚把它收
  成一张表，见 `fewer-processing-options.md` §5；收成一张表是对的，但表
  本身还是"代码拒绝做的决定"）。

## 诊断

Ousterhout 的说法：当一个热点太复杂，找它背后的数据结构、重复的事实或放错
的所有者。这里放错的是"可创造的单位"。

agent 文件把三种不同的东西压进一个形状：

1. **persona**：prompt、tools、temperature。`InlinePersonaSchema` 已经是它
   的精确定义，`agent()` 工具也已经接受内联 persona
   （`packages/harness/src/agent/runtime/delegation/AgentTool.ts`）。
2. **知识**：rubric、格式约定、领域用法。402 行的 `enhance.yaml` 几乎全是
   这个。
3. **流程**：几轮、每轮读什么、何时停。`task:` 块用 Nunjucks 写它，recipe
   用 JS 跑它。

把 2 和 3 塞进 1，目录就必然按"视角 × 流程"的积膨胀。四种审稿视角乘一种
批注流程是四个文件；再来一种流程就是八个。

反过来看仓库已经做对的部分：codemode 文档
（`.agents/docs/implemented/architecture/2026-10-01-codemode-everywhere.md`）
把 `script` 做成了一个完整的运行时：QuickJS、按 settle 顺序的确定重放、
`agent()` 和 `self()` 是普通调用、模块源码按 specifier 钉在
`modules` 表里（`packages/harness/src/agent/codeSandbox/worker.ts` 的
`setModuleLoader`）。goal 插件已经把"策略"做成一个可替换的脚本模块。
documents 的 recipe 已经是 25 行 JS。缺的只是：**把这条路当主路，并让人
也能走。**

## 长期判断

模型变强，价值从"对模型说什么"转到四件事：验证器（编译、diff、测试、
texcount、文献 API）、持久的编排（长 goal、恢复、预算、并行）、用户自己
积累的程序和项目约定、以及可观测和可审批的执行。提示词会越来越短；凡是
提示词里教模型"按步骤做"的部分，都更应该是一段步骤被验证过的程序。

因此 3 年后的 TeXRA 应该是：一个持久执行 JS 程序的 harness，程序的操作是
模型调用和工具调用，历史是真相；TeXRA 产品本身是一组程序和一组工具。1.0
PRD 的第一句已经这么说了（"允许模型编写策略、能够可靠保存和恢复调用的
agent runtime"）。本提案是把这句话落到用户可创造的单位上。

三年尺度上要守住的不变量：

- **历史一个写者，run loop 一个程序**（AGENTS.md "Agent system"）。程序模块
  是 `script` 调用的 guest，不是第二个引擎。
- **持久化不随代码变**：钉住的源码和摘要是 run 的一部分；改 task 文件不改
  正在跑的 run，恢复用原源码（PRD "Agent 文件和 imports"）。
- **一个 fact 一个 owner**：谁写了这段程序是一个字段，审批和重放从它推导。

## 设计

### 四种单位

| 单位     | 是什么                                          | 谁写             | 落在哪                                                                      |
| -------- | ----------------------------------------------- | ---------------- | --------------------------------------------------------------------------- |
| 程序模块 | 一个 ES 模块，默认导出 `async (args) => result` | 插件、用户、模型 | 插件：`builtIn:<name>`；用户：`.texra/tasks/`；模型：内联在 `script` 调用里 |
| persona  | `{ prompt, tools, temperature }`                | 程序的作者       | 程序里的字面量；bundled 的 `assistant`、`setup`、`creator` 三个文件         |
| 工具     | 带审批和重放语义的能力                          | 插件             | `Plugin.tools`，不变                                                        |
| 项目约定 | 这个项目的记号、引用、风格                      | 用户             | `AGENTS.md`，PromptBuilder 已经读它                                         |

没有 skill，没有 team，没有 custom agents 目录。可复用的文本是导出字符串的
模块，`import { rubric } from './rubrics/logic.js'`。通用知识（Wolfram 怎么
用、LaTeX 引号风格、Zotero 查重）删，模型会；TeXRA 特有的约定（`\criticize{}`
的格式、输出文档的格式）进对应的程序模块。

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
      persona: { prompt: 'You annotate. You never rewrite.', tools: [] },
      label: 'Annotate',
    },
  );
  await tools.document_extract({ run: reply.runId });
  const out = await tools.document_compile();
  if (!out.ok) {
    await agent(`Fix the build:\n${out.log}`, {
      persona: { tools: ['read_file', 'edit_file', 'bash'] },
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
2. 相对路径：只在 task 所在根（`.texra/tasks/`，或插件随包的 `tasks/`）内
   解析；`..` 越出根、绝对路径、`node_modules`、npm 包名一律拒绝，错误说明
   允许的形式。
3. 循环：解析整张图时检测，拒绝并列出环。
4. 钉住：启动时把图里每个模块的源码和一个内容摘要写进
   `AgentConfig.script.modules`；恢复用钉住的源码；文件改了下次启动才生效。
5. 形式：task 文件是 ES 模块，静态 `import` 语句（QuickJS 的模块加载器
   走 `setModuleLoader`）；模型的内联脚本是函数体，保留动态 `import()`。
   两者用同一个解析器。

导入不扩大调用者的工具或文件权限（PRD 原话）：一个 task 能调的工具是它
的 run 被 offered 的那些。

### run 的两类

`AgentConfigSchema`（`packages/harness/src/shared/schemas/agentConfig.ts`）
今天是"persona 可选，script 可选，两种 script kind"。改成一个联合：

```
chat:    { persona 或 agent 名, instruction, model, files… }
program: { source, modules, digest, author: 'model' | 'plugin' | 'workspace', title, tools, timeoutMs, args }
```

- `background`、`recipe` 和用户 task 合为 `program`；`author` 是它们唯一的
  差别，决定两件事：`agent()` 是启动时随 launch 批准（`plugin`、
  `workspace`，用户刚刚点了启动，源码在文件里）还是开一次脚本请求
  （`model`，今天的 Q5）；以及 picker 和 history 怎么标它。
- `recipe.block` 和 `recipe.options` 随 `task:` 块一起删。
- goal 策略成为第一个 `program` 消费者（它今天就是两行脚本 import 一个
  模块），documents 的 recipe 是第二个；两者都只用 `builtIn:` 来源，所以
  这一步不改任何用户可见的东西。
- 聊天本身仍是内核原生的模型轮次。"一切都是程序"（聊天循环也是 guest 脚
  本）与 run loop 唯一写者的契约冲突，不做；联合类型给它留门。

### 启动面

picker 列 `assistant` 和 task，仅此。`launchTarget: 'agent' | 'team'` 删，
`selectedTeamId` 删。`texra run <task | agent>` 一个命令，`texra team`、
`texra agents` 删。`task()` 成为脚本的一个全局（和 `agent()` 平级）：
`task('annotate', { files, instruction })` 启动一个 `program` 子 run；
`document_task` 工具和 `builtIn:documents` 的 `revise()` 删，`from()` 留
给串联。`agent()` 的 `agentName` 改为可选；内联 persona 是主路。

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

### assistant

唯一进 picker 的 agent，script-only，persona 40 行以内：你在哪、工具怎么
用、什么时候写脚本、什么时候 `task()`。审稿、搜索、写代码不是目录项，是它
在脚本里用不同 persona 字面量调 `agent()`。`review` 这种"只读工具集"是
persona 的一个 `tools` 列表，不是一个文件。

`setup` 和 `creator` 留作命令触发的 persona，不进 picker。`setup` 删掉问学
科选 team 的一段。`creator` 改为写 task 模块：读 `.texra/tasks/texra.d.ts`
和 bundled 的 task 源码，写一个新文件，跑一次，交付。

script-only 翻为默认：两个模型的评测通过率持平、每次成功的成本低 18% 到
66%（codemode 文档 "Still open"），按 Q10 补 glm 和 fan-out journey 后翻；
Q3 的按模型回退标志留给过不了线的模型。

### 插件

`Plugin` 接口（`packages/harness/src/tools/plugins.ts`）去掉 `agentBlock`
（PRD 也说它"不应被写成 agent 模板发布接口"），`scriptModules` 不变，新增
插件随包的 `tasks/` 目录作为程序模块的第二来源。documents 插件 = 它的工具
加 `builtIn:documents`（常量和 `from()`）加 bundled 的 task 文件
（`edit`、`annotate`、`enhance`、`apply`、`merge`、`transcribe`、
`paper2slide`、`paper2poster`）。lean4 插件 = 它的工具加几个 task 模块；
5 个 agent 和 5 个 skill 一起删。

### 用户创造的闭环

这是选这条路最强的理由。模型在聊天里写了一段脚本，跑通了，用户说"存下
来"，assistant 把它写进 `.texra/tasks/x.js`（一次普通的 `write_file`，走
审批 diff）。下次 picker 里就有它，`texra run x` 能跑，进 git 能分享。目录
从使用中长出来，而不是从 vendor 的仓库里长出来；一年后 bundled 目录还是
那几个文件。

重放的确定性还给了一个后手：一次记录下来的 run 就是 task 的一份 fixture，
`texra run` 对着记录的调用重放一遍，就是不花模型钱的回归测试。本提案不
建它，但这条路只有程序模块才走得通。

### built-in 与 custom 的边界

一句话：built-in 是产品承诺能跑的东西，custom 是用户积累的东西；两者的
关系是 import，不是覆盖。

一个东西是 built-in 要同时满足三条：零配置能跑（不依赖 Lean、Zotero、
Wolfram 这类外部件；需要外部件的归插件，带 `<plugin>:` 命名空间）；我们
测它（有 journey 或 E2E）；它编码的是 TeXRA 自己的契约（`\criticize{}`
的格式、输出文档的格式、`document_*` 的调用顺序），不是领域知识。rubric、
口味、学科约定是知识，归 custom 或 `AGENTS.md`。按这三条，built-in 只剩
三个 persona 和 documents 插件自己的八个 task 模块，后者是 built-in 只因
为插件得演示自己的工具怎么用。

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

## 删除账

| 删什么                                                                        | 行数（量于 `c4c843a`） | 留什么                                        |
| ----------------------------------------------------------------------------- | ---------------------- | --------------------------------------------- |
| 31 个 bundled agent 文件和 lean4 的 5 个                                      | ~3900                  | `assistant`、`setup`、`creator`，共 ~120 行   |
| team：预设、启动、CLI、标签页、`apply_team`、设置                             | 1264                   | 无                                            |
| workspace 选择、hidden keys、delegation scope、agent 设置页                   | ~2400 of 2930          | 一个 Tasks 页（列文件、显示源码、打开编辑器） |
| agent 索引：customize 副本、`basedOn`、newer、custom 目录                     | ~900 of 1410           | bundled 三个文件的扫描                        |
| skills 子系统                                                                 | 1521                   | 无                                            |
| `task:` 块、Nunjucks、`files:`/`outputs:`、选项表、`rounds`                   | ~900 of 2305           | 文档工具本身                                  |
| CLI：`texra agents`、`texra team`、`texra skills`                             | 734                    | `texra run`、`texra tasks types`              |
| 新增：模块解析器、`program` kind、task 加载器、`task()`、Tasks 页、types 命令 | 约 +1200               |                                               |

净减约 1 万行，其中 3900 行是提示词。

## 与已有裁决和 PRD 的关系

三处需要负责人明确改口，本提案不假装它们不存在：

1. **codemode Q8 "No script files"**（2026-10-02）。收窄为：模型写的脚本
   仍不落文件；人和插件写的程序是文件，源码和摘要钉在 run 上。recipe 今天
   就是这样，所以这是把已有做法说成规则，不是新路径。
2. **PRD "Agent 文件和 imports"**：原文保留"参数化 prompt"和"脚本模块"两种
   组合方式，并把工作区 import 推后。本提案只留一种（脚本），并把工作区
   import 连同它的规则提前到 1.0。理由：两种组合方式就是两个解析器、两套
   文档、两种心智模型；task 块的 Nunjucks 能表达的，25 行 JS 都能表达，反
   之不然。
3. **skills**（Claude Code / Codex 互操作的一部分，PRD "安装式 manifest"
   一行）。删掉它失去导入第三方 skill 包；模型仍能 `read_file` 用户指给它
   的任何 Markdown，程序能 import 任何文本。安装式插件的 commands、MCP 和
   hooks 不受影响。

不与之冲突的：无流程引擎、历史一个写者、一个 persona 解析路径（R6）、
`agent()` 替代 delegation 工具（Q7）、Q2 的结果复用、Q5 的一次脚本审批。

## 更彻底的方案：Unix

比本提案再往前一步就是 Unix。记录它，是为了说明本提案停在哪里、为什么，
以及从它借走什么。

### E：texra 是一个过滤器，shell 是编排器

Unix 的四条原则逐一套上去：

- **模型是过滤器。** `cat paper.tex | texra ask -s proofread.md > out.tex`。
  `texra` 是读 stdin 写 stdout 的命令，背后一个 daemon 存历史。没有 agent，
  persona 是 `-s` 后面的文件。
- **task 是可执行文件。** `.texra/bin/annotate` 是任意语言的脚本，里面调
  `texra ask`、`latexmk`、`latexdiff`。流水线是管道：
  `texra annotate paper.tex | texra apply paper.tex`。bundled 和 custom 的区
  别只是在 PATH 上的位置。
- **工具是 PATH 上的 CLI，不是插件。** 今天有 44 个工具定义，
  `packages/texra/src/tools` 约 20800 行、`packages/harness/src/tools` 约
  12500 行。Wolfram 已经是"在 bash 里跑 wolframscript"，latexdiff、texcount、
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

本提案已经是"everything is a file"：task、persona、rubric 是文件，run 是目
录，memory 是文件。还差四条，每条都能单独落：

1. **工具是 CLI，bespoke 工具要有理由。** 一个插件工具只在三种情况下有资
   格存在：需要审批语义（write、edit 的 diff 审批）、需要写 run history 的
   行（`document_*`、`agent()`）、需要结构化结果供脚本分支。其余的
   （extract_figures、extract_bib_entries、arxiv、Zotero、latex preview）变
   成 `.texra/bin` 或随包的 CLI，模型用 bash 调，`--help` 是文档。这一刀砍
   的是三万两千行里最大的一块，也让 `Plugin` 接口瘦一半。它把插件作者的扩
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
"小程序、文本进出、靠文件组合"的东西。本提案的推荐是 D 加这四条；第 1
条收益最大、争议也最大。

## 权衡

- **确定性对灵活性**：程序钉在 run 上，所以一个 task 的行为在运行中不变；
  代价是改了文件要重新启动才生效。这是 PRD 要求的，不是代价。
- **不会编程的用户**：YAML 从来没有比 25 行带模板字符串的 JS 更容易；402
  行的 YAML 没人读得完。`creator` 代写，`texra.d.ts` 给补全。
- **按会话换 persona**："换个口吻聊天"由 `AGENTS.md` 承担，它是项目级的。
  保留一个可选的 persona YAML 的成本很小（`InlinePersona + name` 的文件
  扫描本来就有），负责人问题 2。
- **弱模型**：script-only 对 DeepSeek 和 Gemini flash 已验证；更弱的模型
  走 Q3 回退，它们本来也跑不动 400 行 rubric。
- **可发现性**：34 个名字至少告诉用户 TeXRA 能干什么。缩到 9 项后，Tasks
  页和 `docs/guide/built-in-agents.md` 改写成 task 参考页承担这个角色。
- **破坏范围**：1.0 不保兼容。用户的 custom agent 和 custom team 失效，
  changelog 写迁移路径：team 变插件开关，agent 变 task 或 `AGENTS.md`；
  不写 YAML 到 JS 的转换器（AGENTS.md 禁止 legacy reader），由 `creator`
  对话完成。

## 分期

每一期独立可合，前一期不依赖后一期的决定。

1. **`program` kind 和解析器**（harness，无用户可见变化）：`AgentConfig`
   联合；三种来源一个解析器，先只开 `builtIn:`；goal 策略和 documents
   recipe 改走它。同时在 codemode 文档记录 Q8 的收窄。
2. **工作区 task**：`.texra/tasks/` 来源、ES 模块、`task()` 全局、
   `texra run <task>`、Tasks 页、`texra tasks types`。先移植 `correct`
   和合并后的 `annotate`；最后一个 bundled task 移完就删 `task:` 块、
   Nunjucks、选项表、`document_task`、`revise()`。
3. **script-only 翻默认**：补 Q10 两项，翻；回退标志留。
4. **删补偿层**：一个 PR 删 agent 目录到三个文件、team、workspace 选择、
   skills、customize；`assistant` 成唯一 agent；文档和迁移说明。

## 负责人问题

1. 接受三处改口（Q8 收窄、PRD 的一种组合方式、删 skills）？
2. 保留可选的 persona YAML（文件扫描已有，成本极小），还是只留 bundled 三
   个？推荐：先保留，看一个版本后谁在用。
3. `prover` 和 `numerics`：先留作独立 agent 文件，还是直接变成 assistant
   脚本里的 persona 字面量？推荐：直接变，它们的差别是工作方式的描述，
   不是工具集。
4. 发现期对 task 模块求值（零工具沙箱）还是静态提取 `description`？推荐：
   求值，一个解析器；顶层必须纯是规则，违反时错误指出来。
5. 第 1 期先做，还是等 1.0 PRD 的在途线（线 7、9、11）合完？推荐：第 1
   期只碰 `agentConfig.ts`、`goalScript.ts`、`documentRecipe.ts` 和沙箱的
   模块加载，和在途线不重叠，可以并行。
6. E-lite 第 1 条：把只包装一个 CLI 的插件工具改成 `.texra/bin` 或随包的
   CLI，bespoke 工具只留需要审批语义、写行或结构化结果的？推荐：接受，
   作为第 4 期之后的第 5 期，先从 `latex-extract` 和 `arxiv` 两个插件试。

## 不做的事

- 不做流程引擎、不做第二个 run history 写者、不做任务调度器。
- 不做 npm 包解析、不做远程依赖、不做 `..` 越根。
- 不做按 task 的输入 schema 或选项表。
- 不做 YAML 到 JS 的兼容转换器。
- 不在本提案里做"聊天也是程序"。

## Verified

- `ls packages/extension/resources/agents/*.yaml | wc -l` 得 34；
  `grep -l '^task:'` 得 15（含 `write/` 两个）。
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
- codemode 文档 "Still open" 的两轮评测表：`only` 对 `direct`，DeepSeek
  每次成功 $0.0017 对 $0.0020，Gemini $0.0155 对 $0.0463。
