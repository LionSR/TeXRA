# Plugins, Tools & Codemode

File operations, shell execution, web search, memory, goal loops, multi-agent delegation, and QuickJS orchestration are implemented as plugins in [`@texra-ai/harness/plugins`](./harness/plugins).

## Built-in plugins (`harnessBuiltins`)

Pass [`harnessBuiltins`](./harness/plugins#harnessbuiltins) (or a subset) plus your own plugins to `Sessions.layer({ platform, plugins })`:

| Export                                               | Plugin ID           | Contributions                                                                                                                           |
| ---------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`codemode`](./harness/plugins#codemode)             | `'codemode'`        | `script` (sandboxed QuickJS execution) and `self()` (running the current agent for another round), plus `searchTools` / `describeTool`. |
| [`fileOps`](./harness/plugins#fileops)               | `'file-ops'`        | `read_file`, `edit_file`, `write_file` (configurable with `WriteFilter`), `glob`, `grep`, and `bash`.                                   |
| [`multiAgent`](./harness/plugins#multiagent)         | `'multi-agent'`     | `agent` ([`AGENT_TOOL_NAME`](./harness/plugins#agent_tool_name)) for launching awaited or background specialist child runs.             |
| [`web`](./harness/plugins#web)                       | `'web'`             | Local `web_search` and `web_fetch` tools.                                                                                               |
| [`memoryWorkflow`](./harness/plugins#memoryworkflow) | `'memory-workflow'` | Persistent `memory` tool ([`MemoryStore`](./harness/plugins#memorystore)), `executions` history tool, and memory prompt section.        |
| [`goal`](./harness/plugins#goal)                     | `'goal'`            | `plan` tool and goal execution recipe over `codemode`.                                                                                  |

## Writing custom tools (`defineTool`)

Use [`defineTool`](./harness/#definetool) to declare a tool's Effect Schema, concurrency lane, replay contract, and execution body (see [`03-custom-tools-and-plugins.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/03-custom-tools-and-plugins.ts)):

```ts
import { Effect, Schema } from 'effect';
import { defineTool } from '@texra-ai/harness';
import { executed, nullishWithDefault } from '@texra-ai/harness/plugins';

export const countEquationsTool = defineTool({
  name: 'count_equations',
  description: 'Count display equations in a LaTeX snippet.',
  lane: 'parallel',
  replay: 'safe',
  schema: Schema.Struct({
    tex: Schema.String.annotate({ description: 'LaTeX source snippet.' }),
    includeUnnumbered: nullishWithDefault(
      Schema.Boolean,
      true,
      'Whether to count $$...$$ and \\[...\\] blocks.',
    ),
  }),
  execute: ({ tex, includeUnnumbered }) =>
    Effect.sync(() => {
      const numbered = [...tex.matchAll(/\\begin\{(equation|align|gather)\}/g)]
        .length;
      const unnumbered = includeUnnumbered
        ? [...tex.matchAll(/(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])/g)].length
        : 0;
      const total = numbered + unnumbered;
      return executed(
        JSON.stringify({ numbered, unnumbered, total }),
        `Counted ${total} equation(s)`,
      );
    }),
});
```

### Tool options

- **Optional parameters (`nullishWithDefault`)**: OpenAI-compatible structured output APIs require optional tool fields to accept `null` as well as `undefined`. Use [`nullishWithDefault(schema, fallback, description)`](./harness/plugins#nullishwithdefault) or `Schema.optional(Schema.NullOr(S))`.
- **`lane`**:
  - `'parallel'`: side-effect-free and approval-free; calls in the same turn or script batch run concurrently and identical duplicate calls collapse onto one execution.
  - `'barrier'` (default): waits for earlier calls in the batch to finish and blocks subsequent calls until it finishes.
  - `'own'`: used inside `script` by tools that manage their own concurrency budget (`agent`).
- **`replay`**:
  - `'safe'`: read-only or idempotent tools that recovery re-executes automatically if the process crashed after `tool.intent` and before `tool.result`.
  - `'unsafe'` (default): side-effecting tools that recovery never re-runs automatically after an unclean crash.
- **`guard` and `requiresApproval`**: declaring `guard: { writes, bash, cwd }` or `requiresApproval: true` checks writable workspace paths and prompts for human approval before `tool.intent` commits and before `execute` runs.

Pass run-scoped tools directly to `session.start({ tools: [countEquationsTool], ... })` (and pass the same `tools` array to `session.resume`), or register them process-wide in a plugin with [`definePlugin`](./harness/plugins#defineplugin).

## Packaging plugins (`definePlugin`)

```ts
import { ALWAYS_AVAILABLE, definePlugin } from '@texra-ai/harness/plugins';

export const latexMetricsPlugin = definePlugin({
  id: 'latex-metrics',
  toggle: 'on',
  availability: ALWAYS_AVAILABLE,
  tools: {
    count_equations: countEquationsTool,
  },
});
```

A [`PluginDefinition`](./harness/plugins#plugindefinition) can declare:

- **`id`**: stable lowercase identifier (`[a-z0-9-]+`), persisted in settings and `tools.offered` rows.
- **`tools`**: map of tool name to `ITool`. Every tool name is unique across the process's [`ToolRegistry`](./harness/plugins#toolregistry).
- **`availability` and `toggle`**: `availability` probes external dependencies ([`ALWAYS_AVAILABLE`](./harness/plugins#always_available) or [`probeTool`](./harness/node#probetool)); missing dependencies withhold the plugin's tools. `toggle: 'on' | 'off'` creates a user setting switch seeded on first install.
- **`injectedWhen`**: maps tool names to a boolean setting key (or `true`) to inject those tools into every tool-using agent while the plugin is enabled.
- **`processLayer` and `sessionLayer`**: lazy Effect `Layer`s ([`ProcessPluginLayer`](./harness/plugins#processpluginlayer), [`SessionPluginLayer`](./harness/plugins#sessionpluginlayer)) built when a step first pins the plugin. Work that outlives a step keeps the session layer alive with [`PluginHold`](./harness/plugins#pluginhold).
- **`prompt`**: [`PromptSection`](./harness/plugins#promptsection) appended to the system prompt while active.
- **`decision`**: [`RequestDecisionHook`](./harness/plugins#requestdecisionhook) run when a request of the plugin's kind is decided.
- **`arms`**: [`PluginArm`](./harness/plugins#pluginarm) schemas and upcasters for versioned `plugin.fact` rows committed by the plugin (latest values appear on `RunView.facts`).
- **`agentBlock`**: [`AgentBlock`](./harness/plugins#agentblock) claiming a top-level YAML key in agent definitions (read via [`agentBlockOf`](./harness/plugins#agentblockof)) to run a structured recipe script.

### Runtime services inside a tool body

Inside `execute`, yield services from [`@texra-ai/harness`](./harness/) and [`@texra-ai/harness/plugins`](./harness/plugins):

- **[`ToolContext`](./harness/#toolcontext)** (`requireRun`, `callerRun`): the calling run's identity, workspace roots (`env.roots`), working directory, and `CallRequests`.
- **[`ChildRuns`](./harness/plugins#childruns)**: launch awaited or detached child runs (`ChildRuns.launch`, `ChildRuns.launchProcess`).
- **[`resolveToolPath`](./harness/plugins#resolvetoolpath)**: resolve a path against the call's workspace root and reject parent-traversal escapes.
- **[`requestToolEditApproval`](./harness/plugins#requesttooleditapproval)** and **[`approvedWriteConflict`](./harness/plugins#approvedwriteconflict)**: open a `toolEdit` diff-approval request, await the user's decision (including manual edits in the diff view), and detect three-way write conflicts.

## Step-pinned catalog generations

When a step starts, it pins the current [`ToolRegistry`](./harness/plugins#toolregistry) generation and computes the offered tool set. If the offered tools, system prompt, or hooks changed since the previous step, the run commits a `tools.offered` row before calling the model. Toggling a plugin in settings creates a new generation for subsequent steps without disturbing in-flight calls.

## Codemode (`script`) and tool discovery

The [`codemode`](./harness/plugins#codemode) plugin exposes the `script` tool, which executes an `async` JavaScript body inside a QuickJS worker thread:

```js
const matches = await tools.grep({ pattern: 'Theorem 3', path: 'sections/' });
const [proofCheck, proseReview] = await Promise.all([
  agent('Check the proof of Theorem 3.', { agentName: 'review' }),
  agent('Tighten the exposition around Theorem 3.', { agentName: 'polish' }),
]);
return { matches: matches.output, proofCheck, proseReview };
```

- **Standard tool pipeline per nested call**: every `await tools.<name>(...)` or `await agent(...)` inside `script` goes through the same schema validation, workspace path guard, approval prompt, `tool.intent`, and `tool.result` rows as a direct model tool call.
- **Deterministic crash replay**: QuickJS runs with non-deterministic globals (`Date.now()`, `Math.random()`) removed, and the host delivers tool results into the worker one at a time in SQLite `commit` order, draining microtasks after each delivery. On `session.resume(runId)`, QuickJS re-enters the script from the top: calls with committed `tool.result` rows resolve immediately from storage in commit order, and in-flight calls reattach or re-run according to their `replay` contract.
- **On-demand tool discovery**: scripts can search the pinned tool catalog with `searchTools(query)` and inspect a tool's parameter schema with `describeTool(name)`.
