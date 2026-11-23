<div align="center">

# Worldline (`@texra-ai/worldline`)

**Durable, crash-tested agent runtime in Effect.**<br />
Embeddable sessions, SQLite history, resume, fork, approvals, sandboxed scripts,
and plugins. The runtime behind [TeXRA](https://texra.ai).

[![npm](https://img.shields.io/badge/npm-%40texra--ai%2Fworldline_0.1.0-6F387A?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@texra-ai/worldline)
[![Effect](https://img.shields.io/badge/Effect-%5E4.1.3-270939?style=flat)](https://effect.website)
[![Node.js](https://img.shields.io/badge/Node.js-22.22%2B_%7C_24.15%2B-339933?style=flat&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![ESM Only](https://img.shields.io/badge/module-ESM-191919?style=flat)](./package.json)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-6F387A?style=flat)](https://github.com/LionSR/TeXRA/blob/main/LICENSE)

[Quick Start](#usage) · [Durable Invariants](#durable-invariants) · [Storage Failures](#storage-failures) · [Entry Points](#entry-points) · [Custom Tools](#custom-tools) · [Protocol Spec](./docs/spec.md) · [API Reference](./docs/api/index.md)

</div>

---

Run agents from any Node program on the same runtime that powers TeXRA across VS
Code, Desktop, and CLI.

- **Crash-tested SQLite sessions:** Every turn, tool result, approval, child
  run, and fork commits to SQLite and is tested against 9 formal invariants
  ([I1–I9](#durable-invariants)) by cutting real databases back to every commit
  point and resuming.
- **Native Effect 4:** Scoped layers (`Sessions.layer`), structured concurrency,
  typed tagged errors (`LaunchRefused`, `ToolsRefused`, `ResumeRefused`,
  `RunFailure`), and `Stream<AgentEvent>` traces, with zero `Effect.runPromise`
  inside the package.
- **Immutable views for UIs:** `SessionView`, `RunView`, and `TranscriptView`
  publish structurally shared snapshots, with browser-safe `./schemas` and
  `./transcript` entry points.
- **Built-in plugins and sandboxed scripting:** Ships `fileOps`, `multiAgent`,
  `codemode` (QuickJS sandbox with cached replay), `goal`, `memoryWorkflow`, and
  `web`, plus `defineTool` / `definePlugin` and stdio MCP `2025-11-25`.
- **Self-contained run history:** Each run records its own `system`, `tools`,
  and `label` at launch so resuming reads nothing else from disk.

> **0.x: the API may change in any minor release.** This package is versioned on
> its own, not with the TeXRA app. The surface below is real and type-checked
> against the packed tarball, but it is not yet a stability promise; expect the
> items in [Current limits](#current-limits) to move.

## Install

Requires Node.js 22.22.2 or later in 22.x, or Node.js 24.15 or later. ESM only.

```bash
npm install @texra-ai/worldline @texra-ai/llm effect @effect/platform-node @effect/sql-sqlite-node
```

[`@texra-ai/llm`](https://www.npmjs.com/package/@texra-ai/llm), the model
package, is a peer dependency: the harness checks model failures with
`instanceof ModelError`, so a model your program binds and the harness must
share one copy of the package.

`effect`, `@effect/platform-node`, and `@effect/sql-sqlite-node` are also peers
so the host process resolves a single copy of Effect (duplicate copies break
`Context.Service`, `Context.Reference`, and `Stream` identity). Install them in
the host package with matching caret ranges; do not pin `effect` to an exact
patch while `@effect/*` packages float.

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

A provider API key can come from the environment (`ANTHROPIC_API_KEY`, …). A
Claude Max or Team plan includes
[monthly API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)
that an Anthropic API key can spend once you link a Console organization to the
plan. A ChatGPT Pro or Business plan includes
[monthly API credits](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions)
that an OpenAI API key can spend once you claim them for an API organization you
own.

## Usage

`Sessions.layer({ platform, plugins, client })` composes the process and
provides the session owner for one `Scope`, and the embedder runs the program at
its own entry point. `plugins` lists what runs can use: the built-ins
(`harnessBuiltins`) plus any plugins of your own. `session.start` runs a
conversation with its system text, declared tools, and instruction. A plugin can
also register a program (`Plugin.programs`): a script module started by name
with the `program` tool or a `script` of kind `program`, whose run calls that
module's default export with the launch's arguments, instruction, and files.
`@texra-ai/worldline` ships no built-in programs.

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
  // The events end when the run does; `responseText` keeps the answer's
  // text and drops the model's thinking and tool output.
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

### What a run is

There are no agent files. Each `session.start` call describes the run directly
(`StartRequestSchema` from `@texra-ai/worldline/schemas`):

- `system`: the run's own system text, placed before what the harness appends
  (the user's and project's `AGENTS.md`, tool-use instructions, memory indexes,
  and active plugin sections). `system` is a
  [Nunjucks](https://mozilla.github.io/nunjucks/) template rendered once at
  launch with `CWD` (the run's working directory) among its variables. Because
  its expressions are evaluated in your process, treat `system` as author-owned
  code: pass end-user text as `instruction`, never inside `system`. Nothing else
  the system prompt carries (workspace paths and git branch, `AGENTS.md`, memory
  indexes) is rendered as a template.
- `tools`: the tool names the run declares (`mcp__<server>__*` expands to every
  tool of a configured MCP server; omit or leave empty for text-only replies).
  Naming a tool that no plugin provides fails the run before any model call.
- `label`: the display label shown on cards, listings, and the run directory.
- `runTools`: custom tools built with `defineTool` for this run alone (pass the
  same `runTools` again when calling `session.resume`).

The run stores its configuration in history, so resuming it reads nothing else
from disk. When a run spawns a child via `agent`, it records the child's
`system`, `tools`, and `label` the same way. Passing `agentName`
(`<plugin>:<name>`) reads an installed Claude Code or Codex plugin's agent once
at call time and writes it into the child's configuration.

Nothing in the package calls `Effect.runPromise` itself: the `Effect.runPromise`
call above belongs to the embedder's entry point, just as it does in any host.

### A persistent session, and resume

`sessions.open(roots, { persistent: true })` keeps session history in the root's
SQLite store under the platform's `storageDir`. Without `persistent: true`, the
store is in memory and ends with the session. Reopening an already-open
workspace root returns the existing session; passing a different `persistent`
option fails with `SessionOptionsConflict` until the session is closed.

A later process can open the same root and call `session.resume(runId)` to
continue a run from its committed history, returning the same `Run` handle as
`start` (pass the same `runTools` that were given to `start`):

- **Unresumable runs:** Fails with `ResumeRefused`, whose `reason` is a
  `ResumeRefusal` with `kind` set to `finished`, `unusableCheckpoint`,
  `earlierBuild` (with its `cause`), `pluginUnavailable` (naming the missing
  `plugin` whose facts the run holds), or `notResumable` (the run was deleted).
- **Owned child runs:** If `runId` belongs to a child owned by an active parent
  call, `session.resume` resumes the parent instead and sets
  `run.redirectedFrom` to the requested child `runId`.
- **Already active runs:** Calling `resume` on a run already active in this
  process starts nothing: it returns the live activation's `Run` handle and
  reads no input. `run.activation` identifies that activation's commit, and
  `session.run(runId, activation)` recovers the same handle across a process
  boundary.

```ts
const program = Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(platform.roots, {
    persistent: true,
  });
  const run = yield* session.resume(runId, { runTools });
  return yield* run.result;
});
```

### Approvals

By default a run's commands and file edits run without asking anyone: the
approval policy (`APPROVAL_POLICY_SETTING` from `./schemas`, set with
`Settings.set(platform.roots, …)`) defaults to `yolo`. With `harnessBuiltins`
that means a run can execute shell commands in the workspace, write files, fetch
URLs, and search the web, with or without a handler attached. Narrow it for a
workspace by setting the policy to `ask` or `never`, or for one run by starting
it with `approval: 'ask'` or `'never'`; leave a plugin out of `plugins` for a
run that must not have its tools at all.

Under `ask`, a run asks before a command, an edit, or a custom tool with
`requiresApproval`, and a session with no attached approval handler denies every
such request and offers no tool that would raise one. A question to the user and
a retry after automatic attempts are never answered on a user's behalf, whatever
the policy. `session.attach({ approve })` attaches a host handler for the
caller's scope: an Effect function from a `PendingRequest` (which run asks, the
request id, and its `payload`, whose `kind` is `bash`, `toolEdit`,
`planApproval`, a proposal, `pluginTrust`, a retry, or `userQuestion`) to the
`RequestDecision` it records. The handler is called once for each request a run
waits on (also listed in `SessionView.requests`), or an embedder can answer a
listed request directly with `session.request({ kind: 'request.decide', ... })`;
whichever answer lands first wins. A handler that fails, throws, or returns a
decision the request's kind does not take denies the request and logs a warning;
it may take as long as it needs, so a human prompt carries its own deadline or
none.

A request is a stored row and survives restarts. On a persistent session, a run
interrupted while waiting for approval still waits after a restart: reopen the
session, attach a handler, and call `resume` to receive the same request under
the same id.

```ts
const program = Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(platform.roots, {
    persistent: true,
  });
  yield* session.attach({
    approve: (request) =>
      Effect.succeed(
        request.payload.kind === 'bash'
          ? { action: 'approve' }
          : { action: 'deny', reason: 'Only commands are approved here.' },
      ),
  });
  const run = yield* session.start({
    label: 'polish',
    system: 'You edit prose for concision. Keep every claim.',
    tools: ['read_file', 'edit_file'],
    instruction: 'Tighten the summary in notes.md.',
    model: 'anthropic/claude-sonnet-5-5',
  });
  return yield* run.result;
});
```

### Core services and streams

| Service    | What it is                                                                                                                                                                                                                                                                                                                    |
| :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sessions` | The process's sessions: `open(roots, options?)`, `close(roots)`, `list`. One session per workspace storage root. `processLayer` (`./host`) serves it; `Sessions.layer({ platform, plugins, client })` composes that process for the layer's lifetime. Build it once per process.                                              |
| `Session`  | One workspace's runs: `start` and `resume` give a `Run`; `request` sends everything else (follow-ups, approvals, stop, fork); `attach(host)` answers approvals until the caller's scope closes; `view.current()` and `view.changes` read the session's state as immutable snapshots. `roots` names the workspace.             |
| `Run`      | `runId`; `events`, what the run does as it does it (`events.pipe(responseText)` for the answer's text); `result`, how it ended; `view`, the session's state while it lasts. Stop a run with `session.request({ kind: 'run.stop', runId, reason: 'user' })`. `start` returns once the run exists, before its first model call. |

`run.events` is the run's trace as a `Stream`, and any number of readers can
read it at any time. Each read replays the run's events from the start of the
activation the handle is for and follows the run until that activation ends; it
fails as `result` does. A `Run` is a view of one activation in its session and
holds no resources: ending a read stops that reader, not the run. Every event
except `stream.chunk` is a stored row, and streamed text arrives as the session
holds it: a stream that ended before the read reached it arrives as one chunk of
its final text, so a reader's chunks always add up to each stream's final text.

Every failure is a typed error on the effect that owns it. A refusal before any
model work fails `session.start` with `LaunchRefused` (an unknown model, a
config its schema rejects, a run id already in use) or `ToolsRefused`. A launch
that fails for any other reason before its run enters the session fails `start`
with `RunFailure`, whose `cause` is what the launch path threw. No host is shown
such a failure: an unknown model's `LaunchRefused` carries the `notice` to show
for it. A run that fails after entering stores a failed end, which `run.result`
returns.

`run.view` is the derived session state every host renders, so run status,
transcript rows, and pending approvals are read from it rather than rebuilt from
the trace. It yields the current view first, then subsequent changes through the
first view containing the run's durable outcome. That final view is included
even when consumption starts after `result` completes, and the first view
yielded always holds the run's row. `result` completes only once the final view
is applied, whether or not the caller reads it; if the session's state reducer
dies first, `result` and every `view` consumer die with its defect instead of
waiting. Ending consumption stops that reader while the run continues. If launch
fails before the run enters the session, there is no `view`: `start` carries the
failure.

Every yielded view is an immutable value: the state reducer publishes levels
with copy-on-touch structural sharing, so an older view stays exactly as it was
for as long as it is held, and untouched branches share object references across
levels. `SessionView`, `RunView`, and `TranscriptView` are read-only all the way
down (`ReadonlyMap`, readonly arrays); mutating through a cast corrupts the
session for every later run. A run is a row of `SessionView.runs`. Its
transcript rows (`RunView.transcript`) stay subscribed while `run.view` is read
(the run and its descendants as they appear) until the run's final view; a
reader that needs them otherwise watches them with `view.watch`.

Runs share one session per workspace storage root: opening a root twice resolves
the session already open there, while a second root gets its own. A session ends
through `sessions.close(roots)`: it refuses new runs on the root, interrupts the
runs it owns, waits within the shutdown budget, flushes artifacts, and returns
`{ abandoned }` (empty when every run ended in time; otherwise the ids still
live, while the session stays open refusing new runs until they end). Releasing
`Sessions.layer` closes every session this way and then releases the process
under them, so draining the scope on shutdown needs no separate close call.

**Build the layer once per process.** Provide `Sessions.layer(...)` once at the
application's edge (`ManagedRuntime.make(Sessions.layer(...))` or one
`Effect.provide` around the whole program). Two live builds share one process
identity, so a second build opening a root the first holds is refused at open
("already open in this process"; guarded by `processRoots` beside
`SessionOwner`). Share that session instead. Builds over different roots work,
and a later build after the first is released is fine.

### Messages to a run

`session.request({ kind: 'followUp.send', runId, text })` sends a run a message
and answers `{ kind: 'followUp', status }`:

- `sent`: a launch in this process holds the run, which reads the message at its
  next model request (with `holdUntil: 'turn'`, when its current turn ends);
- `queued`: no launch here holds the run. The message waits in the run's stored
  queue, and the send resumes the run for it when the run can continue.

A run that cannot take the message refuses it with `Unavailable`, which says
why.

Each send queues one message, so repeating a send after a lost reply queues a
second one. The answer says the message was accepted, not what the run made of
it: read that from the run as for any turn. Its view returns to `waiting` with a
new `forkPoint` (the `seq` of its newest wait) when the turn ends; a run that
ends answers through `run.result`.

## Durable invariants

The full protocol, with what each commit point guarantees, is specified in
[`docs/spec.md`](./docs/spec.md).

A run's next step comes from its committed history. The session publishes a
whole batch through one inbox, and the run reducer checks the batch before the
store commits it. Live trace chunks are transient; they are not recovery input.

The repository's crash-conformance suite verifies the following contracts: it
cuts a real SQLite store back to each commit point of a run (as a process killed
there would leave it), then reopens the store and resumes the run under both
`harnessBuiltins` and a full app's plugins:

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

Every session-store error ends in one of a few outcomes, so a host knows what
happens without reading the code. The full table lives with the session store's
source; in short:

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

## Run results

There is one result shape: `RunEnd`, the end the run stored for its activation.
It carries `outcome`, an optional `usage`, `output`, and on a failed run its
classified `error`: `kind: 'model'` with the provider's `failure`, or a local
`kind` with its `message` (`runEndErrorMessage` from `./schemas` formats
either). A failed run's `result` succeeds with that end, and fails with
`RunFailure` only when no end was stored. Every run's output has one shape,
`{ response, files, structured? }`: the reply text, the workspace-relative files
its tool calls edited, and the `structured` value of a `submit_output` tool when
used. A program's run (`script.kind: 'program'`) ends with its script's return
value as `structured`; how the run reads to whoever launched it is the program's
registered `ProgramResult` (exported from `@texra-ai/worldline/plugins`: the
schema of the plugin fact it reads, its delivery body, and the files it
changed).

`run.result` is terminal-only. A run executes one cycle and ends; one waiting on
a request (an approval, a retry, a question) has no outcome yet, so its `result`
waits until the request is answered (see [Approvals](#approvals)) and the run
continues to end. `SessionView.requests` lists what it waits for.

Accounting is `usage`, present once a round recorded any: one totals record
covering the run and its subagents, whose `usage.cost` is the run's cost and the
only cost this surface states. The harness computes no diffs: a program's plugin
records any it computes in its own value, and otherwise diffing belongs to the
embedder.

## Entry points

| Entry                            | Contents                                                                                                                                                                                                                                                                                                                          |
| :------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@texra-ai/worldline`            | Core embedding surface (~50 names): `Sessions`, `Session`, `Run`, launch inputs, `AgentEvent`, `HostInteractions`, and every tagged error the surface fails with. Start here.                                                                                                                                                     |
| `@texra-ai/worldline/schemas`    | Browser-safe: Effect schemas and derived types for run configs and results; read-only `SessionView`, `RunView`, `TranscriptView`; approval policy; error messages.                                                                                                                                                                |
| `@texra-ai/worldline/transcript` | Browser-safe: `RemoteSessionView` built over transport `SessionInputs`; transcript rows and renderer projections.                                                                                                                                                                                                                 |
| `@texra-ai/worldline/builtins`   | Built-in plugins: `harnessBuiltins`, or individually (`codemode`, `fileOps`, `goal`, `memoryWorkflow`, `multiAgent`, `web`).                                                                                                                                                                                                      |
| `@texra-ai/worldline/plugins`    | Plugin and tool authoring: `defineTool`, `definePlugin`, `ToolContext`, `Settings`, `WorkspaceFs`, `Secrets`, `withLogChannel`, `executed`/`errorResult`, `nullishWithDefault`, `resolveToolPath`, `ToolRegistry`; store ports (`ConfigProvider`, `StateStore`) and process services (`AppState`, `GlobalValues`, `ToolCatalog`). |
| `@texra-ai/worldline/node`       | `nodePlatform(options)`, a ready-made Node `AgentPlatform` with workspace roots; `setLogSink`, `LogSink`, `effectDiagnosticsLayer`.                                                                                                                                                                                               |
| `@texra-ai/worldline/host`       | Full application host composition: `processLayer`, skills, installed plugins, model options, shared file/error/log helpers. No signature on another entry names a type only this one exports, except the requirement unions `RunServices` and `PlatformServices` on `./plugins`. Consumed by TeXRA's hosts; no stability promise. |

Every entry requires the peer dependencies in [Install](#install). Generated API
reference pages with TSDoc and declarations live under
[`docs/api/`](./docs/api/index.md), and runnable examples against a packed
tarball live in [`example/`](./example).

## The platform

Every run needs an `AgentPlatform`: process services (its secret store and an
optional `resourcesRoot` for plugin assets) plus `WorkspaceRoots` for the target
folder (workspace path, storage path, config, workspace state, and process-wide
global state).

- **MCP servers and instructions:** The tool registry reads stdio MCP servers
  from `mcp.json` at the storage root (`roots.storageRoot` / `storageDir`, not
  `roots.globalStorage`; servers must speak MCP revision `2025-11-25`, and older
  revisions do not start). Each run's system prompt carries the storage root's
  `AGENTS.md` (user-wide) followed by the workspace's `AGENTS.md`.
- **Memory:** While `memory.enabled` is on (the default), a run with file tools
  gets two folders of Markdown notes readable and writable with those tools:
  `<storageDir>/memories` (across workspaces) and `memories/` under the
  workspace's storage directory. The system prompt names both folders and
  includes each folder's `MEMORY.md` index at every request (up to 16,000
  characters). There is no memory tool; notes are opened on demand.
  `memoryFolders(platform.roots)` from `./plugins` returns the two folders. Turn
  memory off with `Settings.set(platform.roots, MEMORY_ENABLED_SETTING, false)`.
- **`nodePlatform(options)`:** Supplies defaults: process-local config and
  state, the standard layout under the required `storageDir` (never falling back
  to a per-user directory), that directory's `mcp.json` and `AGENTS.md`, and
  environment-variable secrets (nothing persisted). The harness reads provider
  keys and proxy variables from the workspace's `.env` over `process.env` at
  each launch, while shell commands inherit `.env` over `process.env` with
  provider keys withheld. Point `workspaceDir` only at a folder whose `.env` you
  would load yourself.
- **Custom settings:** Pass plugin settings via `nodePlatform({ settings })`
  using `settingsCatalog({ namespace, rows })` from `@texra-ai/worldline/schemas`
  (or attach the catalog to your own `ConfigProvider` as `catalog`). Keys are
  relative to the namespace (such as `'memory.enabled'`), which stores prepend on
  write. Read and write through `Settings` (`get`, `set`, `reset`).

Model requests carry their own HTTP transport: environment proxy policy
(`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) and a 30-minute stream inactivity
timeout, bound per model rather than installed as a global dispatcher. To
intercept model requests (for a scripted model in tests or a recording
transport), merge `ModelFetch` beneath `Sessions.layer`:

```ts
import { Effect, Layer } from 'effect';
import { ModelFetch, Sessions } from '@texra-ai/worldline';

const scripted: typeof fetch = async () =>
  new Response(/* the provider's wire reply */);

program.pipe(
  Effect.provide(
    Sessions.layer({
      platform,
      plugins: harnessBuiltins,
      client: { name: 'Example App', id: 'example-app' },
    }).pipe(Layer.provideMerge(Layer.succeed(ModelFetch)(scripted))),
  ),
);
```

Merge `ModelFetch` with `Layer.provideMerge` (not `Layer.provide`) so it remains
in the runtime context where runs read it. Leave it out to use the harness's own
transport. [`example/_support.ts`](./example/_support.ts) serves an in-memory
Anthropic Messages stream this way.

The harness logs through `Effect.log*`, and `Sessions.layer` installs no logger
of its own: entries go through whatever logger, level, and tracer your program
provides (`Logger.layer([...])`, or `Logger.layer([])` to silence them). To
route entries through the harness's redacting sink instead, provide
`effectDiagnosticsLayer(level)` from `@texra-ai/worldline/node` and register a
sink with `setLogSink({ write(entry) { … } })`. Each `LogEntry` is Effect's
structured record (formatted with `entryLine` / `entryDetail` from `./schemas`).
Setting a sink disposes the previous one (`dispose`), and `setLogSink(null)`
restores the console. Entries are redacted unless `{ trusted: true }` is passed.
The few lines logged outside any fiber always go to the sink (console by
default).

The platform is **process-wide** for the layer's lifetime: create one and reuse
it for every run on the single `Sessions.layer` built over it. When implementing
`AgentPlatform` and `WorkspaceRoots` yourself, supply a fresh, application-owned
storage directory and do not reuse one written by an earlier release;
`nodePlatform()` selects the separate `v1` storage layout under `storageDir`
automatically without importing or removing earlier data.

## Custom tools

Custom tools return Effect programs. The runtime supplies the run scope and
interrupts tool work when the run stops. `defineTool` validates input and turns
ordinary failures into tool feedback; `execute` runs the work.

```ts
import { defineTool } from '@texra-ai/worldline/plugins';
import { Effect, Schema } from 'effect';

const EchoTool = defineTool({
  name: 'echo',
  description: 'Return the supplied text.',
  schema: Schema.Struct({ text: Schema.String }),
  execute: ({ text }) => Effect.succeed(text),
});

const tools = [EchoTool];
```

`execute` succeeds with text for the model, or with a full `ToolResult`
(`executed(output, summary)` from `./plugins`) when reporting a summary,
attachments, or facts. Failing with an `Error` returns its message to the model
as a tool error.

Pass custom tools to `session.start` as `runTools`. A custom tool with
`requiresApproval` runs only on a session with an approval handler attached
(`session.attach`); otherwise launch fails with `ToolsRefused`. A directly
implemented `ITool` also returns an Effect from `call`. Execute Effect programs
only at the embedding application's host boundary.

## Current limits

These are enforced explicitly rather than failing silently:

- **Under `ask` without a handler, requests are denied.** A session whose policy
  asks and that has no attached host denies every request its runs raise, and
  fails launches whose custom tools require approval with `ToolsRefused`. A
  question or retry is denied under any policy when nobody can answer it.
- **Runs are one cycle long** unless `interactive`: `start` and `resume` end the
  run after its cycle rather than waiting for a follow-up message.
- **Persistent stores may not carry across 0.x releases.** Row schemas are not
  frozen before 1.0, so a release can bump a row kind's version without an
  upcaster. A run holding an older row version is listed as unreadable and is
  not resumed (S3); runs whose row kinds kept their versions still resume. A
  store whose schema stamp differs from this release is refused whole (S1, S2).

## License

Licensed under the [Apache License, Version 2.0](./LICENSE.txt).
