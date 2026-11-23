<div align="center">

# Worldline

**A durable, forkable agent runtime in Effect.**<br />
SQLite-backed sessions, crash recovery, sandboxed multi-agent scripts,
approvals, and plugins. The runtime behind [TeXRA](https://texra.ai).

[![npm](https://img.shields.io/badge/npm-%40texra--ai%2Fworldline_0.1.0-6F387A?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@texra-ai/worldline)
[![Effect](https://img.shields.io/badge/Effect-%5E4.1.3-270939?style=flat)](https://effect.website)
[![Node.js](https://img.shields.io/badge/Node.js-22.22%2B_%7C_24.15%2B-339933?style=flat&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/Store-SQLite-003B57?style=flat&logo=sqlite&logoColor=white)](#durable-invariants)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-191919?style=flat)](#the-platform)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-6F387A?style=flat)](./LICENSE.txt)

[Why Worldline](#why-worldline) · [Quick Start](#quick-start) · [Recipes](#recipes) · [14 Examples](#examples) · [Entry Points](#entry-points) · [Invariants](#durable-invariants) · [Protocol Spec](./docs/spec.md) · [API Reference](./docs/api/index.md)

</div>

---

> **0.x notice:** `@texra-ai/worldline` is versioned on its own, separate from
> the TeXRA app. Every example and entry point is type-checked against packed
> tarballs, but the API and stored row versions may change in minor 0.x
> releases. See [Current limits](#current-limits).

## Why Worldline

Worldline is the embeddable agent runtime that drives TeXRA across VS Code,
Electron Desktop, and an Ink terminal CLI. It is built around five design
choices:

- **A run is data, not a flow graph.** There are no agent YAML files and no
  node/edge DSL. `session.start` takes `{ label, system, tools, instruction,
  model }`, commits it to SQLite, and executes one Effect loop. Resuming runs
  the exact same function over the committed rows.
- **Multi-agent workflows are JavaScript.** With the `codemode` plugin, an agent
  writes plain JS (`Promise.all`, `try`/`catch`, loops) in a QuickJS worker
  thread calling `agent()`, `self()`, `program()`, and tools. Every call is
  journaled in SQLite: kill the process with `SIGKILL` mid-script and resume
  replays completed calls without re-running or re-billing them.
- **History is a forkable worldline.** Every settled turn records a `forkPoint`.
  Fork any run into a new independent branch (`run.fork`) while leaving the
  original untouched, steer live runs with follow-ups (`followUp.send`), and let
  agents rewrite their own context window (`context`) while keeping the full
  transcript.
- **Crash durability is tested at every commit point.** A crash-conformance
  suite cuts real SQLite stores back to every commit point of a run, reopens the
  store, and checks 9 invariants ([I1–I9](#durable-invariants)) across tools,
  approvals, child runs, forks, and stops.
- **Native Effect 4, browser-safe UI views.** Scoped layers, structured
  concurrency, typed tagged errors, and zero `Effect.runPromise` inside the
  library. `SessionView`, `RunView`, and `TranscriptView` publish immutable
  copy-on-touch snapshots, with browser-safe `./schemas` and `./transcript`
  entries for any UI host.

## Quick start

Requires Node.js 22.22.2+ (22.x) or 24.15+. ESM only.

```bash
npm install @texra-ai/worldline @texra-ai/llm effect @effect/platform-node @effect/sql-sqlite-node
```

Run an agent in ~30 lines:

```ts
import { Effect, Stream } from 'effect';
import { responseText, Sessions } from '@texra-ai/worldline';
import { nodePlatform } from '@texra-ai/worldline/node';
import { harnessBuiltins } from '@texra-ai/worldline/builtins';

const platform = nodePlatform({ storageDir: './.agent-storage' });

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open(platform.roots);
  const run = yield* session.start({
    label: 'polish',
    system: 'You edit prose for concision. Keep every claim.',
    tools: ['read_file', 'edit_file'],
    instruction: 'Tighten the summary in notes.md.',
    model: 'anthropic/claude-sonnet-5-5',
  });

  yield* Stream.runForEach(run.events.pipe(responseText), (text) =>
    Effect.sync(() => process.stdout.write(text)),
  );
  return yield* run.result;
}).pipe(
  Effect.scoped,
  Effect.provide(
    Sessions.layer({
      platform,
      plugins: harnessBuiltins,
      client: { name: 'Example App', id: 'example-app' },
    }),
  ),
);

const result = await Effect.runPromise(program);
console.log(result.outcome);
```

Nothing in `@texra-ai/worldline` calls `Effect.runPromise`: your entry point
owns execution and scope shutdown.

<details>
<summary>Peer dependency ranges and provider credentials</summary>

`effect`, `@effect/platform-node`, `@effect/sql-sqlite-node`, and
[`@texra-ai/llm`](https://www.npmjs.com/package/@texra-ai/llm) are peer
dependencies so the host resolves a single copy of Effect (duplicate copies
break `Context.Service`, `Context.Reference`, and `Stream` identity) and shares
one `ModelError` class with `@texra-ai/llm`. Match their caret ranges instead of
pinning `effect` to an exact patch while `@effect/*` floats:

```jsonc
{
  "dependencies": {
    "@effect/platform-node": "^4.1.3",
    "@effect/sql-sqlite-node": "^4.1.3",
    "@texra-ai/worldline": "^0.1.0",
    "@texra-ai/llm": "^0.1.0",
    "effect": "^4.1.3",
  },
}
```

Provider API keys come from the environment (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GOOGLE_API_KEY`, …). Paid Claude Max/Team plans include
[monthly API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)
once linked to a Console org, and ChatGPT Pro/Business plans include
[monthly API credits](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions)
once claimed for an API org.

</details>

## Recipes

### 1. Define typed tools and plugins

Tools are Effect programs validated with Effect Schema. Package tools, JS
`scriptModules`, and named `programs` into a `Plugin` with `definePlugin`:

```ts
import { Effect, Schema } from 'effect';
import {
  definePlugin,
  defineTool,
  executed,
  nullishWithDefault,
} from '@texra-ai/worldline/plugins';

const countEquations = defineTool({
  name: 'count_equations',
  description: 'Count display equations in a LaTeX snippet.',
  lane: 'parallel', // 'parallel' | 'barrier' | 'own'
  replay: 'safe', // safe to re-run automatically after a crash
  schema: Schema.Struct({
    tex: Schema.String.annotate({ description: 'LaTeX source snippet.' }),
    includeUnnumbered: nullishWithDefault(
      Schema.Boolean,
      true,
      'Count $$...$$ and \\[...\\] blocks.',
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

export const latexMetricsPlugin = definePlugin({
  id: 'latex-metrics',
  tools: [countEquations],
});
```

Pass plugins in `Sessions.layer({ platform, plugins: [...harnessBuiltins, latexMetricsPlugin], client })`, or attach per-run tools via `runTools` on `session.start` (and pass the same `runTools` again on `session.resume`). Failing an `execute` effect with an `Error` returns its message to the model as a tool error.

### 2. Persist, fork, and resume across processes

Open with `{ persistent: true }` to write session history to SQLite under
`storageDir`. Fork at any settled `forkPoint` or resume after a stop or crash:

```ts
const session =
  yield *
  (yield * Sessions).open(platform.roots, {
    persistent: true,
  });

// Fork a settled run into an independent branch (original stays untouched)
const { runId: branchId } =
  yield *
  session.request({
    kind: 'run.fork',
    runId,
  });

// Send a follow-up to the branch (auto-resumes if stopped)
yield *
  session.request({
    kind: 'followUp.send',
    runId: branchId,
    text: 'Replace the proof sketch with a formal proof.',
  });

// Resume any interrupted run in a later process
const resumed = yield * session.resume(runId, { runTools });
const end = yield * resumed.result;
```

- **Unresumable runs:** `session.resume` fails with typed `ResumeRefused`
  (`kind`: `finished`, `unusableCheckpoint`, `earlierBuild`,
  `pluginUnavailable`, or `notResumable`).
- **Owned child runs:** Resuming a child owned by an active parent resumes the
  parent and sets `run.redirectedFrom` to the requested child id.
- **Already active runs:** Calling `resume` on a live run returns its existing
  `Run` handle without restarting it (`session.run(runId, activation)` recovers
  the same handle across a process boundary).

### 3. Sandboxed multi-agent scripts (`codemode`)

When `codemode` and `multiAgent` are loaded (both are in `harnessBuiltins`), the
model can write JavaScript inside a QuickJS worker thread to fan out parallel
subagents, request structured JSON outputs, import plugin modules, or query its
own run history with read-only SQL:

```js
const { outline } = await import('builtIn:latex');
const { titles } = await outline(draftTex);

const schema = {
  type: 'object',
  properties: { verdict: { type: 'string' } },
  required: ['verdict'],
};

const [setup, bound] = await Promise.all([
  self('Round 1: check the setup.', { schema }),
  self('Round 2: check the main bound.', { schema }),
]);

return {
  titles,
  verdicts: [setup.structured.verdict, bound.structured.verdict],
};
```

Worldline records every guest call in commit order (`script.call` rows) and pins
imported module sources at launch. If the process dies mid-script, resuming
replays completed calls from SQLite and continues from the first unfinished call
(see [`example/08-crash-and-resume.ts`](./example/08-crash-and-resume.ts)).

### 4. Approvals and human-in-the-loop

By default the approval policy (`APPROVAL_POLICY_SETTING`) is `yolo`, meaning
commands and file edits run without prompting. Narrow it per workspace via
`Settings.set(platform.roots, …)` (`ask` or `never`), per run via
`approval: 'ask' | 'never'`, or by omitting plugins from `plugins`.

Under `ask`, attach an approval handler for the caller's scope with
`session.attach({ approve })`. Pending requests are durable SQLite rows and
survive restarts:

```ts
yield *
  session.attach({
    approve: (request) =>
      Effect.succeed(
        request.payload.kind === 'bash'
          ? { action: 'approve' }
          : {
              action: 'deny',
              reason: 'Only shell commands are approved here.',
            },
      ),
  });

const run =
  yield *
  session.start({
    label: 'editor',
    system: 'Edit the requested file.',
    tools: ['read_file', 'edit_file', 'bash'],
    instruction: 'Run tests and fix the typo in notes.md.',
    model: 'anthropic/claude-sonnet-5-5',
    approval: 'ask',
  });
```

Request payload kinds are `bash`, `toolEdit`, `planApproval`, proposals,
`pluginTrust`, retries, and `userQuestion`. Questions and post-retry prompts are
never auto-answered under any policy. Without an attached handler under `ask`,
requests are denied and custom tools with `requiresApproval: true` fail launch
with `ToolsRefused`. Embedders can also answer listed requests directly from
`SessionView.requests` via `session.request({ kind: 'request.decide', … })`.

### 5. Deterministic offline testing with `ModelFetch`

Every model call reads `ModelFetch` from the Effect context. Merge a scripted
`fetch` with `Layer.provideMerge` to test complete multi-turn, tool-calling,
and crash-recovery loops with zero API keys and zero network access:

```ts
import { Effect, Layer } from 'effect';
import { ModelFetch, Sessions } from '@texra-ai/worldline';
import { harnessBuiltins } from '@texra-ai/worldline/builtins';

const scripted: typeof fetch = async () =>
  new Response(/* provider SSE wire reply */);

program.pipe(
  Effect.provide(
    Sessions.layer({
      platform,
      plugins: harnessBuiltins,
      client: { name: 'Test App', id: 'test-app' },
    }).pipe(Layer.provideMerge(Layer.succeed(ModelFetch)(scripted))),
  ),
);
```

[`example/_support.ts`](./example/_support.ts) drives all 14 examples offline
this way.

## Examples

[`example/`](./example/README.md) is a 14-step runnable suite tested against
packed `.tgz` tarballs with `strict: true` and `skipLibCheck: false`, with no
API key or network needed (set `TEXRA_EXAMPLE_MODEL=provider/model` to run
against a real provider):

```bash
corepack pnpm --filter @texra-ai/worldline run example:packed
```

| Example                                                                        | What it demonstrates                                                                                              |
| :----------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| [`01-llm-turn.ts`](./example/01-llm-turn.ts)                                   | Standalone `@texra-ai/llm`: route selection, `bindModel`, `prepareTurn`, `streamTurn`, `turnCost`, `ModelError`   |
| [`02-session-and-events.ts`](./example/02-session-and-events.ts)               | `Sessions.layer`, `LaunchRefused` on unknown model, `run.events.pipe(responseText)`, `run.result`                 |
| [`03-custom-tools-and-plugins.ts`](./example/03-custom-tools-and-plugins.ts)   | `defineTool`, `nullishWithDefault`, `definePlugin`, two-turn script tool call                                     |
| [`04-approvals-and-requests.ts`](./example/04-approvals-and-requests.ts)       | `requiresApproval`, `session.attach({ approve })`, `interactive` waits, `followUp.send`, `run.stop`               |
| [`05-durable-resume-and-fork.ts`](./example/05-durable-resume-and-fork.ts)     | Persistent SQLite store, `run.fork`, resuming a forked branch, re-reading prior activations                       |
| [`06-views-and-transcript.ts`](./example/06-views-and-transcript.ts)           | `session.view`, `sessionActivity`, `attentionOf`, `TranscriptRow` formatting                                      |
| [`07-programmed-path.ts`](./example/07-programmed-path.ts)                     | Plugin `scriptModules`, `self()` with structured JSON Schema, read-only SQL over `executions`                     |
| [`08-crash-and-resume.ts`](./example/08-crash-and-resume.ts)                   | Real `SIGKILL` of a child Node process mid-script, cross-process resume, cached child reuse, pinned module source |
| [`09-goal-strategies.ts`](./example/09-goal-strategies.ts)                     | Multi-round goals (`builtIn:goal`), custom `goal.strategy`, fresh-context `judge`, `spend_cap` pauses             |
| [`10-external-plugin.ts`](./example/10-external-plugin.ts)                     | External npm plugin package (`acme-notes/`), versioned plugin facts, `pluginUnavailable`, packaged `program()`    |
| [`11-resume-ownership.ts`](./example/11-resume-ownership.ts)                   | Concurrent resume deduplication, reader cancellation vs `session.held`, clean close vs `run.stop`                 |
| [`12-controls-on-a-resumed-run.ts`](./example/12-controls-on-a-resumed-run.ts) | Queuing `run.model` and `run.compact` across a resume boundary                                                    |
| [`13-failed-turn.ts`](./example/13-failed-turn.ts)                             | Provider 400 refusal, classified `error.kind: 'model'`, preserving queued follow-ups                              |
| [`14-context-edit.ts`](./example/14-context-edit.ts)                           | Agent self-editing its own context window via `tools.context`, persisting across restart                          |

Real-model acceptance tests (`codemode`, `plugin`, `crash-resume` with `SIGKILL`)
run via `TEXRA_EXAMPLE_MODEL=… corepack pnpm --filter @texra-ai/worldline run example:acceptance`.

## Entry points

| Entry                            | Contents                                                                                                                                                                                                                                                                                                                          |
| :------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@texra-ai/worldline`            | Core embedding surface (~50 names): `Sessions`, `Session`, `Run`, launch inputs, `AgentEvent`, `HostInteractions`, `ModelFetch`, and every tagged error. Start here.                                                                                                                                                              |
| `@texra-ai/worldline/schemas`    | Browser-safe: Effect schemas and derived types for configs and results; read-only `SessionView`, `RunView`, `TranscriptView`; approval policy; error messages.                                                                                                                                                                    |
| `@texra-ai/worldline/transcript` | Browser-safe: `RemoteSessionView` built over transport `SessionInputs`; transcript rows and renderer projections.                                                                                                                                                                                                                 |
| `@texra-ai/worldline/builtins`   | Built-in plugins: `harnessBuiltins`, or individually (`codemode`, `fileOps`, `goal`, `memoryWorkflow`, `multiAgent`, `web`).                                                                                                                                                                                                      |
| `@texra-ai/worldline/plugins`    | Plugin and tool authoring: `defineTool`, `definePlugin`, `ToolContext`, `Settings`, `WorkspaceFs`, `Secrets`, `withLogChannel`, `executed`/`errorResult`, `nullishWithDefault`, `resolveToolPath`, `ToolRegistry`; store ports (`ConfigProvider`, `StateStore`) and process services (`AppState`, `GlobalValues`, `ToolCatalog`). |
| `@texra-ai/worldline/node`       | `nodePlatform(options)`, a ready-made Node `AgentPlatform` with workspace roots; `setLogSink`, `LogSink`, `effectDiagnosticsLayer`.                                                                                                                                                                                               |
| `@texra-ai/worldline/host`       | Full application host composition: `processLayer`, skills, installed plugins, model options, shared file/error/log helpers. No signature on another entry names a type only this one exports, except `RunServices` and `PlatformServices` on `./plugins`. Consumed by TeXRA's hosts; no stability promise.                        |

Generated API docs with full TSDoc and declarations live in
[`docs/api/`](./docs/api/index.md).

## Core services and semantics

| Service    | Role                                                                                                                                                                                                                                                                                                                         |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sessions` | Process-wide session manager: `open(roots, options?)`, `close(roots)`, `list`. One session per workspace storage root. Served by `Sessions.layer({ platform, plugins, client })` (or `processLayer` from `./host`). Build once per process.                                                                                  |
| `Session`  | One workspace's runs: `start` and `resume` return a `Run`; `request` handles follow-ups, approvals, stop, fork, model switches, and compaction; `attach(host)` handles approvals for the caller's scope; `view.current()` and `view.changes` expose immutable snapshots.                                                     |
| `Run`      | `runId`; `events` (`Stream<AgentEvent>`, pipe through `responseText` for final answer text); `result` (terminal `RunEnd`); `view` (`Stream<SessionView>` through the final outcome). Stop with `session.request({ kind: 'run.stop', runId, reason: 'user' })`. `start` returns once registered, before the first model call. |

### What a run is

Each `session.start` call describes the run directly (`StartRequestSchema` from
`@texra-ai/worldline/schemas`):

- `system`: the run's own system text, placed before what the harness appends
  (user and project `AGENTS.md`, tool-use instructions, memory indexes, and
  active plugin sections). `system` is a
  [Nunjucks](https://mozilla.github.io/nunjucks/) template rendered once at
  launch with `CWD` among its variables. Because expressions execute in your
  process, treat `system` as author-owned code: pass end-user input in
  `instruction`, never inside `system`. Nothing else in the system prompt
  (workspace paths, git branch, `AGENTS.md`, memory indexes) is template-rendered.
- `tools`: declared tool names (`mcp__<server>__*` expands all tools of a
  configured MCP server; omit or leave empty for text-only replies). Naming a
  tool no plugin provides fails launch before any model call.
- `label`: display label shown on cards, listings, and the run directory.
- `runTools`: per-run custom tools built with `defineTool` (re-pass on
  `session.resume`).

A plugin can also register named programs (`Plugin.programs`): script modules
invoked with `program` or a `script` of kind `program`, calling the module's
default export with the launch arguments, instruction, and files.
`@texra-ai/worldline` ships no built-in programs. Passing `agentName`
(`<plugin>:<name>`) to `agent` reads an installed Claude Code or Codex plugin's
agent once at call time and writes it into the child's stored configuration.

### Events, views, failures, and lifecycle

- **`run.events`:** Any number of readers can consume `run.events` at any time.
  Each read replays the activation from its start and follows until it ends,
  failing as `result` does. Ending a reader stops only that reader, not the run.
  Every event except `stream.chunk` is a stored row; streams that ended before a
  reader attached arrive as a single chunk of final text, so chunks always sum
  to the final text.
- **Typed failures:** Refusals before any model call fail `session.start` with
  `LaunchRefused` (unknown model, schema error, duplicate run id; carries a
  user-facing `notice`) or `ToolsRefused`. Other pre-entry launch failures fail
  with `RunFailure` (`cause` is the thrown error). Once entered, a failed run
  stores a terminal failed end returned by `run.result`.
- **Immutable `run.view`:** Yields the current `SessionView` first, then updates
  through the first view holding the run's durable outcome (even if subscribed
  after `result` resolves). Views use copy-on-touch structural sharing and are
  read-only all the way down (`ReadonlyMap`, readonly arrays); never mutate
  through a cast. Transcript rows (`RunView.transcript`) stay subscribed for the
  run and its descendants while `run.view` is read; watch them directly with
  `view.watch` otherwise.
- **Session shutdown and single-layer rule:** Reopening an open workspace root
  returns the same session (`SessionOptionsConflict` if `persistent` differs).
  `sessions.close(roots)` refuses new runs, interrupts live runs within the
  shutdown budget, flushes artifacts, and returns `{ abandoned }` (empty when
  all ended in time). Releasing `Sessions.layer` closes all sessions
  automatically. Build `Sessions.layer` once per process
  (`ManagedRuntime.make(Sessions.layer(...))` or one top-level `Effect.provide`);
  a second live build opening the same root is refused ("already open in this
  process").
- **Messages to a run:** `session.request({ kind: 'followUp.send', runId, text })`
  returns `{ kind: 'followUp', status: 'sent' | 'queued' }` (`sent` delivers at
  the next model request, or end of turn with `holdUntil: 'turn'`; `queued`
  stores and resumes when possible; `Unavailable` if refused). Each send queues
  one message; when the turn finishes, the view returns to `waiting` with a new
  `forkPoint`.

### Run results

Every activation resolves to one shape, `RunEnd`: `{ outcome, usage?, output,
error? }`. On failure, `error` is either `kind: 'model'` with the provider's
`failure` or a local `kind` with `message` (`runEndErrorMessage` from
`./schemas` formats either). `output` is always `{ response, files, structured? }`:
reply text, workspace-relative edited files, and `submit_output` or program
script return value (`ProgramResult` on `@texra-ai/worldline/plugins` shapes
registered program outputs). `run.result` waits for a terminal outcome, pausing
while pending requests are open. `usage.cost` totals the run and all subagents.
Diffing is left to plugins or the embedder.

## The platform

Every run needs an `AgentPlatform` (secret store, optional `resourcesRoot`) and
`WorkspaceRoots` (workspace path, storage path, config, workspace state, global
state).

- **MCP servers and `AGENTS.md`:** Reads stdio MCP servers from `mcp.json` at
  `roots.storageRoot` / `storageDir` (not `globalStorage`; servers must speak
  MCP `2025-11-25`). Each system prompt loads the storage root's `AGENTS.md`
  (user-wide) followed by the workspace's `AGENTS.md`.
- **File-based memory:** While `memory.enabled` is on (default), runs with file
  tools get two writable Markdown note folders: `<storageDir>/memories`
  (cross-workspace) and `<workspaceStorage>/memories`. The system prompt names
  both folders and embeds each folder's `MEMORY.md` index (first 16,000 chars)
  at every request. There is no memory tool; notes open on demand.
  `memoryFolders(platform.roots)` from `./plugins` returns both paths; disable
  via `Settings.set(platform.roots, MEMORY_ENABLED_SETTING, false)`.
- **`nodePlatform(options)`:** Supplies process-local config/state, a `v1`
  storage layout under the required `storageDir` (never falling back to a home
  directory), `mcp.json`, `AGENTS.md`, and environment-variable secrets. At
  launch, provider keys and proxy vars are read from workspace `.env` over
  `process.env`; shell commands inherit `.env` over `process.env` with provider
  keys stripped. Point `workspaceDir` only at workspaces whose `.env` you trust.
- **Custom settings:** Pass plugin settings via `nodePlatform({ settings })`
  with `settingsCatalog({ namespace, rows })` from `@texra-ai/worldline/schemas`
  (or attach as `ConfigProvider.catalog`), accessed via `Settings` (`get`,
  `set`, `reset`).
- **Transport and logging:** Model requests use per-model HTTP transport with
  `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` and a 30-minute stream inactivity
  timeout (override via `ModelFetch`). Logs use `Effect.log*` through your
  provided Effect logger (`Logger.layer([...])`), or route through the redacting
  sink via `effectDiagnosticsLayer(level)` and `setLogSink({ write(entry) { … } })`
  from `./node` (formatted with `entryLine` / `entryDetail` from `./schemas`;
  pass `{ trusted: true }` to skip redaction; `setLogSink(null)` restores
  console).

When implementing `AgentPlatform` and `WorkspaceRoots` yourself, supply a fresh
application-owned storage directory; do not reuse a pre-1.0 directory.

## Durable invariants

The full protocol, with what each commit point guarantees, is specified in
[`docs/spec.md`](./docs/spec.md).

A run's next step comes from its committed history. The session publishes each
batch through one inbox, and the run reducer validates the batch before SQLite
commits it. Live trace chunks are transient and never recovery input.

The repository's crash-conformance suite slices a real SQLite store back to each
commit point of a run (as a process killed there would leave it), reopens the
store, and resumes under both `harnessBuiltins` and full app plugins:

- **I1** Recovery reaches the clean run's outcome: its committed answers, tool
  results, owned children, and context edits are preserved.
- **I2** A tool call finishes once. A result committed before a crash is reused,
  and a finished call is not executed again.
- **I3** A model invocation has at most one committed response. Recovery does not
  append another answer for an invocation already answered.
- **I4** A command subject to approval runs only after approval. An unfinished
  command whose outcome is unknown is retried only after a person chooses to
  retry that call. Recovery does not assume that an absent result means no
  effect occurred.
- **I5** An owned child that ended cleanly answers its awaiting call on
  recovery. Relaunching a child for the same call requires a retry decision, and
  owned children are left with terminal rows.
- **I6** A child's result delivery commits with the turn that produced it.
  Recovery queues and consumes that delivery once, including results from
  detached agents, scripts, and commands.
- **I7** Compaction and fork preserve the context they committed. A fork is
  recovered with the history it was registered with.
- **I8** A stopped run's halt and terminal outcome commit together. Recovery
  cannot treat an acknowledged stop as an interrupted run to continue.
- **I9** Turning off a run's shell approval bypass is acknowledged only after
  the policy row is durable, so recovery cannot restore the old bypass.

These are committed-state contracts. An external effect that finished before its
result was committed can remain uncertain; **I4** governs that uncertainty
without promising exactly-once execution of arbitrary external effects.

## Storage failures

Every session-store error ends in one of six documented outcomes (full table
kept beside the session store's source):

- **S1** The store does not open (`DatabaseOpenFailed`): the session does not
  open, and the error says why. A store an earlier build wrote is refused
  unchanged, and the error says to move it away. A store SQLite reports damaged
  is moved aside instead (`storeMovedAside`), never read again.
- **S2** A store a newer build wrote (`DatabaseStoreNewer`, the cause of an
  open, read, or write failure) is refused whole: nothing is read in part or
  written beside it.
- **S3** A read fails (`DatabaseReadFailed`): the call that read fails. A run
  whose own rows do not decode (`DatabaseRowCorrupt`, or `DatabaseRowEarlier`
  from an earlier build) cannot open; it is listed as unreadable and is never
  resumed. A listing or a tail leaves such a row out with one warning instead.
- **S4** A write fails (`DatabaseWriteFailed`): the batch rolled back and the
  call fails. Inside a run, the run ends, whatever the tool or model call that
  met it did with it.
- **S5** The aggregate is closed (`DatabaseAggregateClosed`, typed): nothing was
  written. A run whose aggregate closed under it stops, with no retry. A project
  store another process holds does not open at all: the open fails with
  `STORE_HELD_MESSAGE`.
- **S6** A run's deletion was asked against a lifetime that has since ended
  (`RunChanged`, typed): nothing was written, and the request says the run
  started again. A row that breaks the store's own rules (a second `run.start`)
  is the writer's defect: it fails the writing fiber, never as a failed write.

## Generated files and deletion

The first row-format baseline starts a new project history beside the
development database. The older database stays at `<namespace>.db`; an earlier
build can still open it. The global settings database keeps its existing
filename.

Under its storage root a session owns the store (`<namespace>.project-v1.db`,
named for the settings catalog's namespace: `harness.project-v1.db` unless
`nodePlatform` is given a catalog of your own) and one directory per run,
`executions/<runId>/`, holding the files the run generated. A deletion removes
nothing else: the project's own files are never touched, and a store moved aside
(`<namespace>.project-v1.db.corrupt-<ms>`) is never read again and goes only
when a person deletes it (`deleteStorageInventory`, which
`texra doctor --prune-storage` runs after asking).

- Deleting a run (the `run.delete` request) commits a deletion marker, the
  `run.removed` row that closes the run and every run it owns. Nothing on disk
  is removed before that row commits, and a deletion removes only the
  directories of the runs its marker closed.
- The session collects committed markers when it opens and after each deletion:
  it removes the closed runs' directories, then their rows and the blobs no
  other row uses. Each step may run twice, in one process or two, with the same
  result.
- A removal that fails leaves its marker pending, with a warning, and the next
  collection retries it. The deleted run stays deleted meanwhile.
- The only runs the harness deletes on its own are ended background shells an
  earlier process left, at session open, through the same marker.
- Before removing anything, the collector resolves the storage root and its
  `executions` directory, which must resolve to itself. If it was replaced by a
  link elsewhere, collection is refused and stays pending; each target must also
  fall inside it. This is resolve-then-check: a directory replaced between the
  check and removal is not detected.
- The `run.files` request copies a stopped run's directory into the project, or
  removes the directory without deleting the run.

## Current limits

Enforced explicitly rather than failing silently:

- **Under `ask` without a handler, requests are denied.** A session whose policy
  asks and that has no attached host denies every request its runs raise, and
  fails launches whose custom tools require approval with `ToolsRefused`. A
  question or retry is denied under any policy when nobody can answer it.
- **Runs are one cycle long** unless `interactive: true`: `start` and `resume`
  end after one cycle rather than waiting for follow-up messages.
- **Persistent stores may not carry across 0.x releases.** Row schemas are not
  frozen before 1.0, so a release can bump a row kind's version without an
  upcaster. A run holding an older row version is listed as unreadable and is
  not resumed (S3); runs whose row kinds kept their versions still resume. A
  store whose schema stamp differs from this release is refused whole (S1, S2).

## License

Licensed under the [Apache License, Version 2.0](./LICENSE.txt).
