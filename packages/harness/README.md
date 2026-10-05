# `@texra-ai/harness`

The embeddable [TeXRA](https://texra.ai) agent runtime: run a TeXRA agent from a
Node program and consume its trace as a stream.

> **Not published to npm.** This package builds and is consumed inside the
> repository; the publish job is deliberately disabled until a named external
> consumer exists. The surface below is real and typechecked, but it is **not
> yet a stability promise** — treat it as `0.x` and expect the gaps in
> [Current limits](#current-limits) to move.

## Install

Requires Node.js 22.19.0 or later in 22.x, or Node.js 24 or later.

Not on the registry yet. Inside this workspace, depend on it by name:

```jsonc
{ "dependencies": { "@texra-ai/harness": "workspace:*" } }
```

`effect` and `zod` (v4) are peer dependencies of the whole package: the bundle
imports `effect` at runtime (`dist/index.js` opens with
`import ... from 'effect'`). Install both alongside it, `effect` at the exact
version the package pins (`4.0.0`). Two copies of `effect` in one
process do not work at all: Streams, Fibers and Context built by one copy do
not interoperate with another's, and a peer dependency is how a consumer gets
one copy rather than a second nested one.

```jsonc
{ "dependencies": { "effect": "4.0.0", "zod": "^4.4.3" } }
```

## Usage

The package's surface is Effect: `Sessions.layer({ platform, plugins })`
composes the process and provides the session owner for one `Scope`, and the
embedder runs the program at its own entry point. `plugins` is the list of
what the runs can use: the harness's built-ins (`harnessBuiltins.all`, or
`harnessBuiltins.minimal` for files and the shell alone), and any plugin of
the embedder's own beside them. `session.start` runs an agent as a
conversation. A document task (an agent's `task:` block, run as revisions
that rewrite documents) is a recipe script over the tools of TeXRA's
`documents` plugin, which is the app's and which the package does not ship.

```ts
import { Effect, Stream } from 'effect';
import { Sessions } from '@texra-ai/harness';
import { nodePlatform } from '@texra-ai/harness/node';
import { harnessBuiltins } from '@texra-ai/harness/plugins';

const platform = nodePlatform({
  agentsDir: './agents',
  storageDir: './.agent-storage',
});

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open();
  const run = yield* session.start({
    agent: 'polish',
    instruction: 'Tighten the abstract in paper.tex.',
  });
  yield* Effect.forkScoped(
    Stream.runForEach(run.events, (event) =>
      Effect.sync(() => {
        if (event.type === 'stream.chunk') process.stdout.write(event.text);
      }),
    ),
  );
  return yield* run.result;
}).pipe(
  Effect.scoped,
  Effect.provide(Sessions.layer({ platform, plugins: harnessBuiltins.all })),
);

const result = await Effect.runPromise(program);
console.log(result.outcome);
```

Nothing in the package calls `Effect.runPromise` itself: the
`Effect.runPromise` above is the embedder's own boundary, as is any host
entry that runs the program.

| Service    | What it is                                                                                                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Sessions` | The process's one session owner: `open(roots?)`, `close(roots?)`, `list`. One session per workspace storage root, the same owner every TeXRA host opens through. `Sessions.layer({ platform, plugins })` composes the process and provides it, with this scope as the lifetime of the hold it takes on that composition. |
| `Session`  | `start`, `request`, `view.changes`, and `subscribe`, whose transcript interest is held for a `Scope` and cleared when it closes. A value, one per root, not a tag.                                                                                                                                                       |
| `Run`      | `runId`, `result`, `view`, `events`, `interrupt`. `start` succeeds at admission: the run exists in the session, its row published and its trace live.                                                                                                                                                                    |

`run.events` is the run's trace as a `Stream`. Trace events are buffered from
the moment the run enters its session, so a reader begun right after `start`
misses none of the launch events. Ending the stream's consumption detaches
the event source while the run itself continues, and a run that settles
without ever being read discards what it buffered. That buffer is only the
handover to the first reader, and it is bounded: a run whose events pass the
handover window with nobody reading has no reader, so it logs a warning
naming the run and detaches its trace. Taking only `result` therefore never
retains a long run's whole trace. A reader that did attach is never dropped:
past its first pull the buffer is that reader's, and nothing discards what it
has yet to read.

Every failure is a typed error on the effect that owns it. A refusal before
any model work fails `session.start` with one of the tagged errors the
surface names (`AgentNotFound`, `ToolsRefused`, and `PlatformConflict` for a
second, different platform or a process runtime a host already installed); a run that fails after entering its session
fails `run.result` and `run.events` with `RunFailure`, whose `cause` is
exactly what the launch path threw.

`run.view` is the folded session state every TeXRA host renders, so run
status, transcript rows, and pending approvals are read from it rather than
re-folded from the trace. It yields the current view first, then subsequent
changes through the first view containing the run's durable outcome. That
final view is included even when consumption starts after `result` completes,
and the first view yielded always holds the run's row. `result` completes
only once the final view has folded, independently of whether the caller
reads it; if the session's fold dies first, `result` and every `view`
consumer die with its defect instead of waiting. A run that fails on its own
fails `result` with its own error without waiting for the fold; the fold's
defect then reaches `view` consumers only. Ending consumption stops that
reader while the run continues. If launch fails before the run enters the
session, there is no `view` at all: `start` itself carries the failure.

Every yielded view is a value: the fold publishes immutable levels with
copy-on-touch structural sharing, so an older view stays exactly what it was
for as long as it is held, and a branch the later level did not touch is the
same object in both. An older view is stable to read; it is not a fold input,
so nothing in the package folds onto anything but the latest level. The exported
`SessionView`, `RunView`, and
`TranscriptView` types are read-only all the way down (`ReadonlyMap`, readonly
arrays); a write through a cast corrupts the session every later run in the
process reads. A run is a row of `SessionView.runs`. The run's transcript rows
(`RunView.transcript`) are subscribed on its behalf, the run itself and its
descendants as they appear, and stay resident for the life of the process.

Runs share one session per workspace storage root. The runtime's session
owner holds it, the same owner every TeXRA host opens its sessions through, so
opening a root twice resolves the one session already open there; a second
root gets its own. The package never borrows a host's runtime (see "The
platform" below), so every session on it is the package's own, and its host answers no
approval prompt, so the session denies the retries of every run on it. A
session ends through `sessions.close(roots)`: it refuses new runs on the
root, interrupts the runs it owns and waits for them to settle within the
runtime's shutdown budget, flushes its artifacts, and releases the session,
returning `{ settled, abandoned }`. `settled` is true when every run ended in
time; otherwise `abandoned` names the runs still live, and the session stays
open, refusing new runs, until they end. Leaving the `Sessions.layer` scope
closes every session the owner holds this way and then disposes the runtime
they ran on — the scope is the lifetime of the composition's hold, so an
embedder that drains its scopes on shutdown needs no separate close call.

The composition is held, not owned: each `Sessions.layer` scope takes a hold
on it, and the last hold to end is what closes every session the owner holds,
each settling its runs and flushing its artifacts, and then disposes the
runtime they ran on. So two overlapping scopes over one platform are safe,
the first one out ends nothing the second is still using, and a later program
in the same process composes again once the last hold has ended. A
scope arriving during the last holder's shutdown waits for disposal to finish
before composing the next runtime. Acquisition is interruption-safe:
cancellation while waiting aborts without taking a hold, while the retiring
runtime completes disposal through its own scope.

## Durable invariants

A run's next step comes from its committed history. The session publishes a
whole batch through one inbox, and the run fold checks the batch before the
store commits it. Live trace chunks are transient; they are not recovery input.

The existing [crash-conformance suite](../../src/test-kernel/support/crashConformance.ts)
checks the following contracts by reopening a real SQLite store at every commit
point, under both the harness built-ins and TeXRA's plugins:

- **I1** Recovery reaches the clean run's outcome: its committed answers,
  tool results, owned children, and context edits are preserved.
- **I2** A tool call has one settlement. A result committed before a crash
  is reused, and a settled call is not executed again.
- **I3** A model invocation has at most one committed response. Recovery
  does not append another answer for an invocation already answered.
- **I4** A command subject to approval runs only after approval. An unfinished
  command whose outcome is unknown is retried only after a person chooses to retry
  that call. Recovery does not assume that an absent result means no effect
  occurred.
- **I5** An owned child that ended cleanly answers its awaiting call on
  recovery. Relaunching a child for the same call requires a retry decision,
  and owned children are left with terminal rows.
- **I6** A child's result delivery settles with the turn that produced it.
  Recovery queues and consumes that delivery once, including results from
  detached agents, scripts, and commands.
- **I7** Handoff, compaction, and fork preserve the context they committed.
  A fork is recovered with the history it was registered with.
- **I8** A stopped run's halt and terminal outcome commit together.
  Recovery cannot treat an acknowledged stop as an interrupted run to continue.
- **I9** Turning off a run's shell approval bypass is acknowledged only
  after the policy row is durable, so recovery cannot restore the old bypass.

These are committed-state contracts. An external effect that finished before
its result was committed can remain uncertain; **I4** governs that uncertainty,
without promising exactly-once execution of arbitrary external effects.

## Run results

There is exactly one result shape: `RunEndResult`, the run's `run.end`
payload plus the `runId` it belongs to. It carries an `outcome`, an optional
`usage`, an `output`, and, on a failed run, a structured `error`. Every run's
output is one shape, `{ response, files, structured?, documents? }`: the reply
text, the workspace-relative files its tool calls edited, and the `structured`
value of a `submit_output` tool when the run used one. `documents` is present
only on a document task's run: `{ outputs, compileFailures, diffs,
diffsUnavailable? }`, the output files of its newest revision and the
compilation failures. There is no category to switch on; test for
`output.documents`.

`run.result` is terminal-only. Internally a run also has a
non-terminal `WAITING` state — the run is parked mid-session waiting on the
user rather than finished — and the runtime carries a separate waiting shape
for it. That shape is deliberately not exported and never completes
`run.result`: a parked run has no outcome to report, and this surface has no
interactive channel to un-park it (see [Current limits](#current-limits)).
Watch the trace stream if you need to observe a run reaching that state.

Accounting is `usage`, present once a round recorded any: one totals record
covering the run and its subagents, whose `usage.totalCost` is the run's cost
and the only cost this surface states. The per-file `documents.diffs` are
written by the delivery that computes them after the run ended, so
the embedding contract leaves diffing to the embedder, which already owns the
files.

## Entry points

| Entry                       | Contents                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@texra-ai/harness`         | `Sessions`, `Session`, `Run`, the tagged errors, and the tool-definition helpers (`defineTool`, `MapToolRegistry`) with their types |
| `@texra-ai/harness/schemas` | Zod schemas + inferred types for agent definitions, configs, and run results                                                        |
| `@texra-ai/harness/plugins` | `harnessBuiltins`: the built-in plugins, `.all` and `.minimal`                                                                      |
| `@texra-ai/harness/node`    | `nodePlatform(options)`, a ready-made Node `AgentPlatform` with its workspace roots                                                 |

Every entry needs the `effect` and `zod` peers installed. See
[Install](#install).

## Effect

The package's surface is Effect, in full: every decision the package makes is
stated once, in Effect, on the services above, and nothing in the package
calls `Effect.runPromise`, `runSync`, or `runFork`.

Until 2026-09-21 the root entry rendered these services as Promises and
AsyncIterables, the boundary kind rule R1 of TeXRA's Effect migration names
for the published SDK (`2026-08-26-effect-4-runtime-migration.md`
§7 R1; supersession recorded in the architecture rulings ledger,
`.agents/docs/implemented/architecture/2026-08-01-architecture-rulings-ledger.md`).
That ruling is superseded: `effect` was already a mandatory exact-pin peer of
the whole package, so no consumer was spared installing Effect; the package
is unpublished and the Promise entry had no consumers; and TeXRA 1.0 keeps no
parallel surfaces. The composition-once-per-process limit went with the
Promise entry: each `Sessions.layer` scope owns the composition it made.

Failures are `Data.TaggedError`s. Four come from the package itself —
`PlatformConflict`, `AgentNotFound`, `ToolsRefused`, and `RunFailure`, whose
`cause` is exactly what the launch path threw — and two, `DatabaseOpenFailed`
and `DatabaseReadFailed` (the `SessionOpenError` union), reach the surface from
the session store when it cannot open or read, for six in all. A
`session.request` answers with the runtime's own `Outcome` or its
`RequestError` union, the same values every TeXRA host reads. Beyond these,
nothing else is exported: no fold internals, no host widgets.

A runnable version of this program against a packed tarball is in
[`example/`](./example).

## The platform

Every run needs an `AgentPlatform`: the process services the package
composes (the agent directories, secrets, the resume
and language-model ports, and an optional `toolMissingHandler` that surfaces
a missing external tool) plus the `WorkspaceRoots` of the folder the runs
work in (workspace path, its storage path, config, workspace state, and the
process-wide global state), and the `mcpConfigPath` its tool registry reads.
`nodePlatform()` supplies all of them: process-local config and state,
TeXRA's ordinary storage layout under the `storageDir` you name (required; the
package never writes to the user's `~/.texra`), that directory's `mcp.json`,
and environment-variable secrets (so provider API keys are read from
`process.env`; nothing is persisted).

Model requests carry their own HTTP transport: the environment's proxy policy
(`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) and a 30-minute stream inactivity
timeout, bound to each model rather than installed as your process's global
dispatcher.

The platform is **process-wide** while any `Sessions.layer` scope holds the
composition. Create one and reuse it for every run: passing a second,
different platform while a hold is live fails the layer with
`PlatformConflict`, and so does composing in a process where a TeXRA host
already installed its own process runtime, since the package does not borrow
a runtime built for someone else's roots. Once the last hold ends, the next
scope may compose with a different platform.

Implement the `AgentPlatform` ports and the `roots` yourself when embedding in a
host that already owns those services. For TeXRA 1.0, supply a fresh,
application-owned storage directory in custom `WorkspaceRoots`; the SDK uses
that exact directory. Do not reuse an earlier TeXRA storage directory.
`nodePlatform()` selects the separate `v1` storage layout under `storageDir`
automatically. Earlier histories and checkpoints
are not imported or removed.

## Custom tools

Custom tools return Effect programs. The SDK supplies the run scope and
interrupts tool work when the run stops. `defineTool` validates the input and
normalizes ordinary failures into tool feedback; `execute` implements the work.

```ts
import { defineTool } from '@texra-ai/harness';
import { Effect } from 'effect';
import { z } from 'zod';

const EchoTool = defineTool({
  name: 'echo',
  description: 'Return the supplied text.',
  schema: z.strictObject({ text: z.string() }),
  execute: ({ text }) =>
    Effect.succeed({ status: 'executed' as const, output: text }),
});

const tools = [EchoTool];
```

Pass `tools` to `session.start`. A custom tool that requires
approval fails the launch with `ToolsRefused`: the package has no approval
channel. A directly implemented `ITool` also returns an Effect from
`call`; asynchronous operations compose inside that program. Execute programs
only at the embedding application's host boundary.

## Current limits

These are enforced, not undocumented — each fails or degrades loudly rather
than failing quietly:

- **Approval-requiring tools are refused.** A tool with `requiresApproval`
  fails the launch with `ToolsRefused`. There is no interactive approval
  channel yet.
- **Interactive retry always denies.** A run that would prompt to retry gets a
  denial with a reason instead: on each session the package opens it answers
  every retry request with `request.decide`, the same door a host answers
  through, for the life of that session.
- **No resume.** `nodePlatform` reports no resumable runs; resuming a
  persisted tool-use session is host-side functionality today.
- **No language-model port.** `nodePlatform` wires the unavailable port, so a
  host that needs host-provided models must supply its own.

## License

See `LICENSE.txt`.
