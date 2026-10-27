# Philosophy & Architecture

[`@texra-ai/harness`](./harness/) and [`@texra-ai/llm`](./llm/) are TeXRA's runtime packages, written in [Effect](https://effect.website). The VS Code extension, desktop app, and CLI are hosts over these two packages.

> **0.x:** Both packages are versioned independently of the TeXRA app and may change in any `0.x` minor release.

## Design rules

### 1. The SQLite log is the execution state

A session's runs do not live in an in-memory conversation array or a sidecar checkpoint file. Every model call, tool execution, human approval, context edit, and child delegation commits append-only rows to the project database (`texra.db`, or an in-memory SQLite database when opened without `{ persistent: true }`):

- **One writer per storage root.** Every durable write goes through the session publisher in enqueue order. Each stateful stream—a run (`run:<runId>`) or a plugin's durable state (`plugin:<id>:<key>`)—carries an ownership claim stamped with the writer's [`ProcessIdentity`](./harness/node#processidentity) (`[hostname, pid, processStart]`).
- **One reducer for live steps and recovery.** Appending a batch of rows updates the run's state through the run reducer, and the loop reads its next action from that returned state. Resuming an interrupted run in a later process replays the committed rows through the same reducer.
- **Three authorities, kept separate:**
  1. **History rows** hold resumable execution facts (messages, tool intents and results, model bindings, context edits, human requests, and terminal outcomes).
  2. **Current values** ([`Settings`](./harness/#settings), [`CurrentValues`](./harness/#currentvalues)) hold mutable configuration and feature switches.
  3. **Live trace events** ([`run.events`](./harness/#run)) carry transient streaming chunks (`stream.chunk`) that are never stored as rows.

### 2. Core decides; hosts present

Every decision whose outcome is recorded—starting or rejecting a run, granting or denying an approval request, retrying a model failure, or finishing a run—is made in the harness and committed as a row.

A host supplies [`AgentPlatform`](./harness/#agentplatform) ports at startup ([`nodePlatform`](./harness/node#nodeplatform) builds the Node.js defaults), renders [`SessionView`](./harness/schemas#sessionview) and [`TranscriptView`](./harness/schemas#transcriptview), and sends [`RuntimeRequest`](./harness/schemas#runtimerequest) commands through [`session.request(...)`](./harness/#session) (`request.decide`, `followUp.send`, `run.stop`, `run.fork`, `run.model`, `run.compact`, `policy.set`).

### 3. Nested Effect scopes

Neither package calls `Effect.runPromise`, `runSync`, or `runFork`; the host or embedding program runs the Effect at its entry point. Resources belong to five nested scopes:

1. **Process** ([`Sessions.layer`](./harness/#sessions) / [`processLayer`](./harness/#processlayer)): platform ports, [`AgentCatalog`](./harness/#agentcatalog), [`ToolRegistry`](./harness/plugins#toolregistry), route-scoped model retry gates, and open sessions.
2. **Session** ([`sessions.open`](./harness/#sessions)): one SQLite store, the single-writer publisher, [`SessionView`](./harness/schemas#sessionview), [`session.request`](./harness/#session), and the run registry.
3. **Run** ([`session.start`](./harness/#session) / [`session.resume`](./harness/#session)): one run's fiber, its ownership claim, and its trace stream. Top-level runs and delegated child runs alike start on the session scope; parentage is row data (`run.start.parent`), not fiber nesting.
4. **Step**: pins the current tool catalog generation and approval policy for one model round.
5. **Call**: one model attempt or one tool execution, scoped so its stream, file uploads, and request waits close when the call ends.

Service tags hold capabilities fixed for their scope; per-run values (`runId`, a run's inbox, a request's wait handle) pass as arguments.

### 4. One loop, one `script` tool, everything else a plugin

Every run executes on the same loop. [`codemode`](./plugins-and-codemode#codemode-script-and-tool-discovery) provides the `script` tool—a QuickJS worker that calls the run's tools (`await tools.read_file(...)`, `await agent(...)`, `await self(...)`) with deterministic replay across crashes—and [`Plugin`](./harness/#plugin)s contribute tools, prompt sections, Effect layers, versioned durable rows (`PluginArm`), and custom YAML blocks (`AgentBlock`).

## Handles: `Sessions`, `Session`, and `Run`

| Handle                                                                          | Scope                  | Operations                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[`Sessions`](./harness/#sessions)**                                           | Process                | `open(roots, options?)`, `close(roots)`, `closeAll`, `list`. Provided by `Sessions.layer({ platform, plugins })`.                                                                                                                            |
| **[`Session`](./harness/#session) / [`LocalSession`](./harness/#localsession)** | Project storage root   | `start(input)`, `resume(runId, input?)`, `request(runtimeRequest)`, `attach({ approve })`, `view.current()`, `view.changes`, `view.watch(set, from)`, `view.subscribe(set)`, `view.read(runIds)`, `listRuns()`, `records(runId)`, `settled`. |
| **[`Run`](./harness/#run)**                                                     | Single agent execution | `runId`, `events` (`Stream<AgentEvent, RunFailure \| TraceUnavailable>`), `view` (`Stream<SessionView>`), `result` (`Effect<RunEndResult, RunFailure>`), `redirectedFrom`, `interrupt`.                                                      |

## Package entries

Exports are split by runtime environment so browser and webview bundles never pull in Node.js built-ins or vendor SDKs:

| Entry                                                  | Environment  | Contents                                                                                                                                             | Guide & Reference                                                                  |
| ------------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`@texra-ai/harness`](./harness/)                      | Any (Effect) | `Sessions`, `Session`, `LocalSession`, `Run`, `defineTool`, `Settings`, `AgentCatalog`, and tagged errors                                            | [Durable Protocol](./durable-protocol) · [Reference](./harness/)                   |
| [`@texra-ai/harness/schemas`](./harness/schemas)       | Browser-safe | Effect Schemas, `SessionView` / `RunView` / `TranscriptView` types, view queries, `RuntimeRequestSchema`, approval policies, `TraceDocumentSchema`   | [Views & Transcripts](./views-and-transcripts) · [Reference](./harness/schemas)    |
| [`@texra-ai/harness/transcript`](./harness/transcript) | Browser-safe | `RemoteSessionView`, `SessionInputs`, `TranscriptRow`, `ToolRowModel` sections, `rowHeadline`, `transcriptText`, `elideText`                         | [Views & Transcripts](./views-and-transcripts) · [Reference](./harness/transcript) |
| [`@texra-ai/harness/plugins`](./harness/plugins)       | Any (Effect) | `harnessBuiltins` (`codemode`, `fileOps`, `goal`, `memoryWorkflow`, `multiAgent`, `web`), `definePlugin`, `ToolContext`, `ChildRuns`, edit approvals | [Plugins & Codemode](./plugins-and-codemode) · [Reference](./harness/plugins)      |
| [`@texra-ai/harness/node`](./harness/node)             | Node.js      | `nodePlatform(options)`, workspace roots, SQLite database handles, command execution, binary probing, atomic file writes                             | [Reference](./harness/node)                                                        |
| [`@texra-ai/llm`](./llm/)                              | Browser-safe | `Model` (`prepareTurn`, `streamTurn`), `completedTurn`, `ModelError`, `selectModel`, `decideModelRoute`, `resolveRouteEndpoint`, `turnCost`          | [Model Layer](./model-layer) · [Reference](./llm/)                                 |
| [`@texra-ai/llm/node`](./llm/node)                     | Node.js      | `bindModel(spec)` and subscription OAuth flows (`codex`, `xai`)                                                                                      | [Model Layer](./model-layer) · [Reference](./llm/node)                             |

## Install and minimal example

Requires Node.js `>=22.19.0` (in 22.x) or `>=24.0.0`, ESM only. `effect`, `@effect/platform-node`, and `@effect/sql-sqlite-node` are peer dependencies (`^4.0.6`) so the process shares one copy of `effect` and `@texra-ai/llm`:

```bash
npm install @texra-ai/harness @texra-ai/llm effect @effect/platform-node @effect/sql-sqlite-node
```

```ts
import { Effect, Stream } from 'effect';
import { Sessions } from '@texra-ai/harness';
import { nodePlatform } from '@texra-ai/harness/node';
import { harnessBuiltins } from '@texra-ai/harness/plugins';

const platform = nodePlatform({
  agentsDir: './agents',
  storageDir: './.agent-storage',
  workspaceDir: process.cwd(),
});

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open(platform.roots, { persistent: true });

  const run = yield* session.start({
    agent: {
      name: 'summary_editor',
      description: 'Reviews notes for concision.',
      prompt: 'Tighten technical notes while preserving every claim.',
      tools: ['read_file', 'grep'],
    },
    instruction: 'Summarize the findings in notes.md.',
  });

  yield* Stream.runForEach(run.events, (event) =>
    Effect.sync(() => {
      if (event.type === 'stream.chunk') process.stdout.write(event.text);
    }),
  );

  return yield* run.result;
}).pipe(
  Effect.scoped,
  Effect.provide(Sessions.layer({ platform, plugins: harnessBuiltins })),
);

const end = await Effect.runPromise(program);
console.log(end.outcome, end.output.response);
```

## Runnable examples (`packages/harness/example/`)

The repository includes six self-contained programs in [`packages/harness/example/`](https://github.com/LionSR/TeXRA/tree/main/packages/harness/example) that pack `@texra-ai/llm` and `@texra-ai/harness` into tarballs, install them into a fresh temporary directory with `npm install`, type-check them with `skipLibCheck: false`, and execute them without an API key:

```bash
corepack pnpm --filter @texra-ai/harness run example:packed
```

| Example                                                                                                                               | What it exercises                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`01-llm-turn.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/01-llm-turn.ts)                                 | `@texra-ai/llm` standalone: `selectModel`, `decideModelRoute`, `resolveRouteEndpoint`, `bindModel`, `prepareTurn`, `streamTurn`, and `ModelError`. |
| [`02-session-and-events.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/02-session-and-events.ts)             | `Sessions.layer`, `sessions.open`, `InlinePersonaSchema`, `AgentNotFound`, `run.events` (`stream.chunk`), and `run.result`.                        |
| [`03-custom-tools-and-plugins.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/03-custom-tools-and-plugins.ts) | `defineTool`, `nullishWithDefault`, `executed`, `definePlugin`, and a multi-turn tool call loop.                                                   |
| [`04-approvals-and-requests.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/04-approvals-and-requests.ts)     | `requiresApproval: true`, `session.attach({ approve })`, interactive `waiting` state, `followUp.send`, and `run.stop`.                             |
| [`05-durable-resume-and-fork.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/05-durable-resume-and-fork.ts)   | Persistent SQLite store (`{ persistent: true }`), `run.fork`, resuming a forked conversation via `followUp.send`, `listRuns()`, and `records()`.   |
| [`06-views-and-transcript.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/06-views-and-transcript.ts)         | `session.view.subscribe`, `sessionActivity`, `attentionOf`, `acceptsFollowUp`, `TranscriptRow`, `ToolRowModel` sections, and `elideText`.          |
