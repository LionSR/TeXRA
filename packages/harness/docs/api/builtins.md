# `@texra-ai/worldline/builtins`

<!-- Generated from `packages/harness/src/builtins.ts` by `npm run docgen`; do not edit. -->

The harness's built-in plugins for `@texra-ai/worldline`: what a process
lists in `Sessions.layer({ platform, plugins, client })` beside its own.

> **Guide:** Read [Plugins, Tools & Codemode](/api/plugins-and-codemode) for
> what each built-in registers and how the `script` (Codemode) sandbox
> replays across crashes.

### Key exports by role

- **Every built-in**: [`harnessBuiltins`](#harnessbuiltins), each with no
  app options.
- **One by one**: [`codemode`](#codemode), [`fileOps`](#fileops) (with the
  [`WriteFilter`](#writefilter) an app applies to what `write_file`
  writes), [`goal`](#goal), [`memoryWorkflow`](#memoryworkflow),
  [`multiAgent`](#multiagent) (the `agent` tool,
  [`AGENT_TOOL_NAME`](#agent_tool_name), and the `program` tool), and
  [`web`](#web).

A plugin or tool of your own is written with
[`@texra-ai/worldline/plugins`](./plugins), which imports none of these.

## AGENT_TOOL_NAME

The tool that runs a named agent as a child of the calling run.

```ts
const AGENT_TOOL_NAME: "agent"
```

## codemode

Code mode: the `script` tool, a program that calls the run's other tools,
`self()`, the function a script runs this agent again with, and
`context`, which reads and edits the run's own model view. An agent gets
`script` and `context` if its configuration names them, or as every run
that takes injected tools does (not a script's run or a text-only
run). A step that offers `script`
sends it and the run's own tools alone, so `context` is called from a
script there and directly elsewhere; its session layer is the code
sandbox the scripts run in.

```ts
const codemode: Plugin
```

## fileOps

Files and the shell: every agent needs them. An app passes the filter
`write_file` applies to what it writes (its own content replacements).

```ts
const fileOps: (options?: { readonly writeFilter?: WriteFilter | undefined; }) => Plugin
```

## goal

Plans and goals: the `plan` tool proposes a plan, which the user may run
as a goal: a background script of the conversation that runs its agent
in rounds through `self()` (`goalScript`), on the default strategy, its
module `builtIn:goal`, unless `goal.strategy` names another.

```ts
const goal: Plugin
```

## harnessBuiltins

Every built-in, with no app options.

```ts
const harnessBuiltins: readonly Plugin[]
```

## memoryWorkflow

Past runs and later ones, and the run's own equipment: `executions`;
`wake`, with which a run arranges to be continued at a later time;
`plugin_manager`, with which it installs and enables the plugins it
loads, each change approved by the person; and `resources`, which reads
the time, the models, the plans' quotas and the run's spend. The last
three are offered to every agent with tools. An agent's memory is no
tool: its notes are files its file tools read and write
(`agent/memory/memoryLayout.ts`).

```ts
const memoryWorkflow: Plugin
```

## multiAgent

Child runs: the `agent` tool, and `program` for a registered program.

```ts
const multiAgent: Plugin
```

## web

The web: `web_search` and `web_fetch`.

```ts
const web: Plugin
```

## WriteFilter

What an app does to the content `write_file` is given before it proposes
it, by path, under the call's workspace configuration (text replacements
for a file type, say). The harness's `write_file` writes what it is given.

```ts
type WriteFilter = (
  path: string,
  content: string,
  config: ConfigProvider,
) => Effect.Effect<string>;
```
