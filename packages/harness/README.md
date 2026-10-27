# `@texra-ai/harness`

An embeddable agent runtime in Effect, from [TeXRA](https://texra.ai): run an
agent from a Node program and consume its trace as a stream.

> **0.x: the API may change in any minor release.** The package is versioned
> on its own, not with the TeXRA app. The surface below is real and
> type-checked against the packed tarball, but it is not yet a stability
> promise; expect the gaps in [Current limits](#current-limits) to move.

## Install

Requires Node.js 22.19.0 or later in 22.x, or Node.js 24 or later. The
package is ESM only.

```bash
npm install @texra-ai/harness @texra-ai/llm effect @effect/platform-node @effect/sql-sqlite-node
```

[`@texra-ai/llm`](https://www.npmjs.com/package/@texra-ai/llm), the model
package, is a peer too: the harness checks a model's failures with
`instanceof ModelError`, so a model your program binds and the harness must
share one copy of the package.

`effect` is a peer dependency of both packages, and the harness also takes
`@effect/platform-node` and `@effect/sql-sqlite-node` as peers so the host
process resolves a single copy of `effect` and `@effect/*` (duplicate copies
break `Context.Service`, `Context.Reference`, and `Stream` identity). Install them in
the host package with matching caret ranges; do not pin `effect` to an exact
patch while `@effect/*` packages float.

```jsonc
{
  "dependencies": {
    "@effect/platform-node": "^4.0.6",
    "@effect/sql-sqlite-node": "^4.0.6",
    "@texra-ai/harness": "^0.1.0",
    "@texra-ai/llm": "^0.1.0",
    "effect": "^4.0.6",
  },
}
```

`nodePlatform()` reads provider API keys from the environment (`ANTHROPIC_API_KEY`, …).
A Claude Max or Team plan includes [monthly API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)
that an Anthropic API key can spend once you link a Console organization to
the plan.

## Usage

The package's surface is Effect: `Sessions.layer({ platform, plugins })`
composes the process and provides the session owner for one `Scope`, and the
embedder runs the program at its own entry point. `plugins` is the list of
what the runs can use: the harness's built-ins (`harnessBuiltins`) and any
plugin of the embedder's own beside them. `session.start` runs an agent as a conversation. A plugin can also register a
custom YAML task block via `Plugin.agentBlock` (an `AgentBlock`) and run agents
that declare that block with its own recipe script; `@texra-ai/harness` ships
no built-in task-block plugins.

```ts
import { Effect, Fiber, Stream } from 'effect';
import { Sessions } from '@texra-ai/harness';
import { nodePlatform } from '@texra-ai/harness/node';
import { harnessBuiltins } from '@texra-ai/harness/plugins';

const platform = nodePlatform({
  agentsDir: './agents',
  storageDir: './.agent-storage',
});

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open(platform.roots);
  const run = yield* session.start({
    agent: 'polish',
    instruction: 'Tighten the summary in notes.md.',
  });
  const events = yield* Effect.forkScoped(
    Stream.runForEach(run.events, (event) =>
      Effect.sync(() => {
        if (event.type === 'stream.chunk') process.stdout.write(event.text);
      }),
    ),
  );
  const result = yield* run.result;
  // The run's trace ends with it; join so the consumer drains what the
  // result may have outrun instead of being interrupted with the scope.
  yield* Fiber.join(events);
  return result;
}).pipe(
  Effect.scoped,
  Effect.provide(Sessions.layer({ platform, plugins: harnessBuiltins })),
);

const result = await Effect.runPromise(program);
console.log(result.outcome);
```

### An inline persona

`agent` names an agent file in the platform's agent directories, or it is the
persona itself, written in the same format as the file
(`InlinePersonaSchema` from `@texra-ai/harness/schemas`): `name`,
`description`, `prompt`, `tools` and `temperature`. The run records the
persona with its configuration, so nothing has to be written to disk. An
inline persona has no bundled original (`basedOn`) and no plugin's block;
each is refused with a `RunFailure`. A tool
it names that no plugin offers fails the run before any model call, as it
would in a file.

```ts
const program = Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(platform.roots);
  const run = yield* session.start({
    agent: {
      name: 'summary_editor',
      description: 'Reviews summaries.',
      prompt: 'You review summaries for concision. Keep every claim.',
      tools: ['read_file', 'grep'],
    },
    instruction: 'Suggest a tighter summary for notes.md.',
  });
  return yield* run.result;
});
```

Nothing in the package calls `Effect.runPromise` itself: the
`Effect.runPromise` above is the embedder's own boundary, as is any host
entry that runs the program.

### A persistent session, and resume

`sessions.open(roots, { persistent: true })` keeps the session's history in
the root's SQLite store under the platform's `storageDir`. Without
`persistent: true`, the store is in memory and ends with the session. Reopening
an already-open workspace root returns the existing session; passing a
different `persistent` option fails with `SessionOptionsConflict` until the
session is closed.

A later process can open the same root and call `session.resume(runId)` to
continue a run from its committed history, returning the same `Run` handle that
`start` returns. A run that cannot continue fails with `ResumeRefused`, whose
`reason` is `finished`, `owned_elsewhere` (a live process holds it), `blocked`
(an agent or plugin it needs is missing), `unusable_checkpoint`, or
`not_resumable` (it is running here, or it was deleted). If `runId` belongs to
a child run owned by an active parent call, `session.resume` resumes the parent
and sets `run.redirectedFrom` to the requested child `runId`. Pass the same
custom `tools` to `resume` that were passed to `start`. Calling `resume` on a
run already resuming in this process joins the active resume and returns the
same `Run`.

```ts
const program = Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(platform.roots, {
    persistent: true,
  });
  const run = yield* session.resume(runId, { tools });
  return yield* run.result;
});
```

### Approvals

A session with no attached approval handler denies every request a run raises,
and offers no tool that requires approval. `session.attach({ approve })`
attaches a host with a handler for the caller's scope, an Effect function from
a `PendingRequest` (which run asks, the request's id, and its `payload`, whose
`kind` is a command, an edit, a plan, a retry, or a question) to the
`RequestDecision` it records. The handler is called once for each request a run
waits on (also listed in `SessionView.requests`), or an embedder can answer a
listed request directly with `session.request({ kind: 'request.decide', ... })`;
whichever answer lands first is the decision. A handler that fails, throws, or
has not answered within ten minutes denies the request and logs a warning, so no
run stays waiting on a handler that went quiet.

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
    agent: 'polish',
    instruction: 'Tighten the summary in notes.md.',
  });
  return yield* run.result;
});
```

| Service    | What it is                                                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Sessions` | The process's sessions: `open(roots, options?)`, `close(roots)`, `list`. One session per workspace storage root. `processLayer` serves it; `Sessions.layer({ platform, plugins })` composes that process for the layer's lifetime. Build it once per process.            |
| `Session`  | `roots`; `view.current()`, `view.changes`, and `view.watch(set, from)`, a reader's view inputs whose transcript subscription lives as long as the stream; `start`, `resume`, `request`; `attach(host)`, a host for the caller's scope. A value, one per root, not a tag. |
| `Run`      | `runId`, `result`, `view`, `events`, `interrupt`, and `redirectedFrom` on a resume that continued a child's parent. `start` succeeds when accepted: the run exists in the session, its row published and its trace live.                                                 |

`run.events` is the run's trace as a `Stream`. Trace events are buffered from
the moment the run enters its session, so a reader begun right after `start`
misses none of the launch events. Ending the stream's consumption detaches
the event source while the run itself continues, and a run that finishes
without ever being read discards what it buffered. That buffer is only the
handover to the first reader, and it is bounded: a run whose events pass the
handover window with nobody reading has no reader, so it logs a warning
naming the run and detaches its trace. Taking only `result` therefore never
retains a long run's whole trace. A reader that attaches after that, or
after the run finished unread, fails with `TraceUnavailable` (`truncated` or
`ended`) rather than reading an empty trace; so does any reader of a run
another process runs, which keeps its trace (`remote`). A reader that did attach in
time is never dropped: past its first pull the buffer is that reader's, and
nothing discards what it has yet to read.

Every failure is a typed error on the effect that owns it. A refusal before
any model work fails `session.start` with one of the tagged errors the
surface names (`AgentNotFound`, `ToolsRefused`); a run that fails after entering its session
fails `run.result` and `run.events` with `RunFailure`, whose `cause` is
exactly what the launch path threw.

`run.view` is the derived session state every host renders, so run
status, transcript rows, and pending approvals are read from it rather than
rebuilt from the trace. It yields the current view first, then subsequent
changes through the first view containing the run's durable outcome. That
final view is included even when consumption starts after `result` completes,
and the first view yielded always holds the run's row. `result` completes
only once the final view is applied, independently of whether the caller
reads it; if the session's state reducer dies first, `result` and every `view`
consumer die with its defect instead of waiting. A run that fails on its own
fails `result` with its own error without waiting for the view update; a
reducer defect then reaches `view` consumers only. Ending consumption stops that
reader while the run continues. If launch fails before the run enters the
session, there is no `view` at all: `start` itself carries the failure.

Every yielded view is a value: the state reducer publishes immutable levels with
copy-on-touch structural sharing, so an older view stays exactly what it was
for as long as it is held, and a branch the later level did not touch is the
same object in both. An older view is stable to read; updates always apply to
the latest level. The exported `SessionView`, `RunView`, and
`TranscriptView` types are read-only all the way down (`ReadonlyMap`, readonly
arrays); a write through a cast corrupts the session every later run in the
process reads. A run is a row of `SessionView.runs`. The run's transcript rows
(`RunView.transcript`) are subscribed on its behalf, the run itself and its
descendants as they appear, until the run's final view: a reader that needs
them later watches them (`view.watch`).

Runs share one session per workspace storage root: opening a root twice
resolves the session already open there, while a second root gets its own. A
session ends through `sessions.close(roots)`: it refuses new runs on the
root, interrupts the runs it owns and waits for them to finish within the
runtime's shutdown budget, flushes its artifacts, and releases the session,
returning `{ settled, abandoned }`. `settled` is true when every run ended in
time; otherwise `abandoned` names the runs still live, and the session stays
open, refusing new runs, until they end. Releasing the `Sessions.layer`
closes every session the owner holds this way and then releases the process
under them, so an embedder that drains its scope on shutdown needs no
separate close call.

**Build the layer once per process.** It is an ordinary Effect layer: provide
it once at the application's edge (`ManagedRuntime.make(Sessions.layer(...))`,
or one `Effect.provide` around the whole program) and run every program on
it. Two live builds share one process identity, so a second build that opens
a root the first holds is refused at open ("already open in this process";
the guard is `processRoots` beside `SessionOwner`): share that session
instead. Builds over different roots each work, and a later build after the
first one is released is fine.

## Durable invariants

The full protocol, with what each commit point guarantees, is specified in
[`docs/spec.md`](./docs/spec.md).

A run's next step comes from its committed history. The session publishes a
whole batch through one inbox, and the run reducer checks the batch before the
store commits it. Live trace chunks are transient; they are not recovery input.

The repository's crash-conformance suite checks the following contracts: it
cuts a real SQLite store back to each commit point of a run, as a process
killed there would leave it, then reopens the store and resumes the run,
under both the harness built-ins and a full app's plugins:

- **I1** Recovery reaches the clean run's outcome: its committed answers,
  tool results, owned children, and context edits are preserved.
- **I2** A tool call finishes once. A result committed before a crash
  is reused, and a finished call is not executed again.
- **I3** A model invocation has at most one committed response. Recovery
  does not append another answer for an invocation already answered.
- **I4** A command subject to approval runs only after approval. An unfinished
  command whose outcome is unknown is retried only after a person chooses to retry
  that call. Recovery does not assume that an absent result means no effect
  occurred.
- **I5** An owned child that ended cleanly answers its awaiting call on
  recovery. Relaunching a child for the same call requires a retry decision,
  and owned children are left with terminal rows.
- **I6** A child's result delivery commits with the turn that produced it.
  Recovery queues and consumes that delivery once, including results from
  detached agents, scripts, and commands.
- **I7** Compaction and fork preserve the context they committed.
  A fork is recovered with the history it was registered with.
- **I8** A stopped run's halt and terminal outcome commit together.
  Recovery cannot treat an acknowledged stop as an interrupted run to continue.
- **I9** Turning off a run's shell approval bypass is acknowledged only
  after the policy row is durable, so recovery cannot restore the old bypass.

These are committed-state contracts. An external effect that finished before
its result was committed can remain uncertain; **I4** governs that uncertainty,
without promising exactly-once execution of arbitrary external effects.

## Storage failures

Every session-store error ends in one of a few outcomes, so a host knows what
happens without reading the code. The full table is kept with
the session store's source; in short:

- **S1** The store does not open (`DatabaseOpenFailed`): the session does
  not open, and the error says why. A store written before 1.0, or one SQLite
  reports damaged, is moved aside instead (`movedAside`), never read again.
- **S2** A store a newer build wrote (`DatabaseStoreNewer`, the cause of an
  open, read or write failure) is refused whole: nothing is read in part or
  written beside it.
- **S3** A read fails (`DatabaseReadFailed`): the call that read fails. A
  run whose own rows do not decode (`DatabaseRowCorrupt`, or
  `DatabaseRowEarlier` from an earlier build) cannot open; it is listed as
  unreadable and is never resumed. A listing or a tail leaves such a row out
  with one warning instead.
- **S4** A write fails (`DatabaseWriteFailed`): the batch rolled back and
  the call fails. Inside a run, the run ends, whatever the tool or model
  call that met it did with it.
- **S5** The claim is not this process's (`DatabaseNotOwner` or
  `DatabaseClaimRefused`, both typed): nothing was written. A run that loses its own
  claim stops, with no retry. When another process holds the run, every
  caller refuses the same way (`heldElsewhereBy`): a resume or follow-up
  answers `owned_elsewhere`, a request `NotOwner`.

## Run results

There is exactly one result shape: `RunEndResult`, the run's `run.end`
payload plus the `runId` it belongs to. It carries an `outcome`, an optional
`usage`, an `output`, and, on a failed run, a structured `error`. Every run's
output is one shape, `{ response, files, structured? }`: the reply text, the
workspace-relative files its tool calls edited, and the `structured` value of
a `submit_output` tool when the run used one. A recipe's run (`script.kind:
'recipe'`) ends with its script's return value as `structured`; the plugin
that owns the recipe's block reads it (`AgentBlock.result`, exported from
`@texra-ai/harness/plugins`: the value's schema, its delivery body, and the
files it changed). There is no category to switch on.

`run.result` is terminal-only. A run of this package runs one cycle and
ends; one waiting on a request (an approval, a retry, a question) has no
outcome yet, so its `result` waits until the request is answered (see
[Approvals](#approvals)) and the run goes on to end. `SessionView.requests`
lists what it waits for.

Accounting is `usage`, present once a round recorded any: one totals record
covering the run and its subagents, whose `usage.totalCost` is the run's cost
and the only cost this surface states. The harness computes no diffs: a
recipe's plugin records any it computes in its own value, and otherwise the
embedding contract leaves diffing to the embedder, which already owns the
files.

## Entry points

| Entry                          | Contents                                                                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@texra-ai/harness`            | `Sessions`, `Session`, `Run`, the tagged errors, the tool-definition helper (`defineTool`) with its types, and `readSessionView`, a project's view read cold from its store                                    |
| `@texra-ai/harness/schemas`    | Browser-safe: Effect schemas + derived types for agent definitions, configs, and run results; the read-only `SessionView`, `RunView` and `TranscriptView` and their reads; the approval policy; error messages |
| `@texra-ai/harness/transcript` | Browser-safe: `RemoteSessionView`, a session's view built over the `SessionInputs` a transport serves; the transcript rows a `TranscriptView` holds and the projections a renderer derives from them           |
| `@texra-ai/harness/plugins`    | The built-in plugins (`harnessBuiltins`, or one by one), and what a plugin is written with: `definePlugin`, `executed`/`errorResult`, `nullishWithDefault`, `resolveToolPath`, `ToolRegistry`                  |
| `@texra-ai/harness/node`       | `nodePlatform(options)`, a ready-made Node `AgentPlatform` with its workspace roots                                                                                                                            |

Every entry needs the peers installed. See [Install](#install). Each entry's
exports, with their TSDoc and declarations, are listed in its API reference
under [`docs/api/`](./docs/api/index.md), generated from the source. A runnable
version of the usage program against a packed tarball is in
[`example/`](./example).

## The platform

Every run needs an `AgentPlatform`: the process services the package
composes (the agent directories, secrets, the resume
port, and an optional `toolMissingHandler` that surfaces
a missing external tool) plus the `WorkspaceRoots` of the folder the runs
work in (workspace path, its storage path, config, workspace state, and the
process-wide global state). The tool registry reads the MCP servers of the
`mcp.json` at the storage root that global storage lies under.
`nodePlatform()` supplies all of them: process-local config and state,
the ordinary storage layout under the `storageDir` you name (required; the
package never falls back to a per-user directory), that directory's `mcp.json`,
and environment-variable secrets (so provider API keys are read from
`process.env`; nothing is persisted). The setting rows your own plugins read
go to it as `nodePlatform({ settings })`, resolved after the harness's own; a
platform with its own `ConfigProvider` carries them as its `catalog`, built
with `settingsCatalog(rows)` from `@texra-ai/harness/schemas`. Code reads and
writes a setting through `Settings` (`get`, `set`, `reset`) against the
stores it holds.

Model requests carry their own HTTP transport: the environment's proxy policy
(`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) and a 30-minute stream inactivity
timeout, bound to each model rather than installed as your process's global
dispatcher.

The platform is **process-wide** for the layer's lifetime: create one and
reuse it for every run, with the one `Sessions.layer` built over it.

Implement the `AgentPlatform` ports and the `roots` yourself when embedding in a
host that already owns those services. Supply a fresh, application-owned
storage directory in custom `WorkspaceRoots`; the SDK uses that exact
directory. Do not reuse a storage directory an earlier release wrote.
`nodePlatform()` selects the separate `v1` storage layout under `storageDir`
automatically. Earlier histories and checkpoints
are not imported or removed.

## Custom tools

Custom tools return Effect programs. The SDK supplies the run scope and
interrupts tool work when the run stops. `defineTool` validates the input and
normalizes ordinary failures into tool feedback; `execute` implements the work.

```ts
import { defineTool } from '@texra-ai/harness';
import { Effect, Schema } from 'effect';

const EchoTool = defineTool({
  name: 'echo',
  description: 'Return the supplied text.',
  schema: Schema.Struct({ text: Schema.String }),
  execute: ({ text }) =>
    Effect.succeed({ status: 'executed' as const, output: text }),
});

const tools = [EchoTool];
```

Pass `tools` to `session.start`. A custom tool that requires
approval runs only on a session opened with an approval handler; on any
other session it fails the launch with `ToolsRefused`. A directly implemented `ITool` also returns an Effect from
`call`; asynchronous operations compose inside that program. Execute programs
only at the embedding application's host boundary.

## Current limits

These are enforced, not undocumented — each fails or degrades loudly rather
than failing quietly:

- **Without a handler, requests are denied.** A session no attached host
  answers denies every request its runs raise, retries included, and fails
  a launch whose custom tools need approval with `ToolsRefused`.
- **Runs are one cycle long** unless `interactive`: `start` and `resume`
  end the run after its cycle rather than waiting for a follow-up message.
- **A persistent store may not carry across 0.x releases.** No row schema
  is frozen before 1.0, so a release can change a row kind's version with no
  upcaster. A run holding a row of a kind whose version changed is listed as
  unreadable and is not resumed (S3); runs whose row kinds kept their
  versions still resume. A store whose schema stamp differs from this
  release's is refused whole (S1, S2). Do not rely on a persistent store
  surviving an upgrade.

## License

See `LICENSE.txt`.
