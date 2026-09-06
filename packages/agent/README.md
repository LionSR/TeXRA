# `@texra-ai/agent`

The embeddable [TeXRA](https://texra.ai) agent runtime: run a TeXRA agent from a
Node program and consume its trace as an async stream.

> **Not published to npm.** This package builds and is consumed inside the
> repository; the publish job is deliberately disabled until a named external
> consumer exists. The surface below is real and typechecked, but it is **not
> yet a stability promise** — treat it as `0.x` and expect the gaps in
> [Current limits](#current-limits) to move.

## Install

Not on the registry yet. Inside this workspace, depend on it by name:

```jsonc
{ "dependencies": { "@texra-ai/agent": "workspace:*" } }
```

`effect` and `zod` (v4) are peer dependencies, and they are peers of the
**whole package**, not only of the `@texra-ai/agent/effect` subpath: the root
entry's bundle imports `effect` at runtime too (`dist/index.js` opens with
`import ... from 'effect'`). Install both alongside it, `effect` at the exact
version the package pins (`4.0.0-rc.112`). Two copies of `effect` in one
process do not work at all: Streams, Fibers and Context built by one copy do
not interoperate with another's, and a peer dependency is how a consumer gets
one copy rather than a second nested one.

```jsonc
{ "dependencies": { "effect": "4.0.0-rc.112", "zod": "^4.4.3" } }
```

## Usage

```ts
import { runAgent } from '@texra-ai/agent';
import { nodePlatform } from '@texra-ai/agent/node';

const platform = nodePlatform({ agentsDir: './agents' });

const run = runAgent({
  platform,
  agent: 'polish',
  instruction: 'Tighten the abstract in paper.tex.',
});

for await (const event of run) {
  if (event.type === 'stream.chunk') process.stdout.write(event.text);
}

const result = await run.result;
console.log(result.outcome);
```

`runAgent` returns an `AgentRun`:

```ts
interface AgentRun extends AsyncIterable<AgentEvent> {
  readonly result: Promise<AgentFlowResult>;
  readonly view: AsyncIterable<SessionView>;
  interrupt(): void;
}
```

Trace events are buffered from the moment the run enters its session, so an
iteration begun right after `runAgent()` misses none of the launch events.
Ending the iteration detaches the event source while the run itself continues,
and a run that settles without ever being iterated discards what it buffered.
That buffer is only the handover to the first reader, and it is bounded: a run
whose events pass the handover window with nobody reading has no reader, so it
logs a warning naming the run and detaches its trace. Awaiting only `result`
therefore never retains a long run's whole trace. A reader that did attach is
never dropped: past its first pull the buffer is that reader's, and nothing
discards what it has yet to read.

Every failure reaches the caller on `result`; `runAgent()` itself does not
throw. A refusal before any model work is one of the tagged errors the Effect
surface names below (`AgentNotFound`, `ToolsRefused`, and `PlatformConflict`
for a second, different platform); a run that fails after entering its session
rejects with exactly what the launch path threw.

`view` is the folded session state every TeXRA host renders, so stream
status, transcript rows, and pending approvals are read from it rather than
re-folded from the trace. Each `for await` over it yields the current view
first, then subsequent changes through the first view containing the run's
durable outcome. That final view is included even when iteration starts after
`result` settles, and the first view yielded always holds the run's stream.
`result` settles only once the final view has folded, independently of whether
the caller reads it; if the session's fold dies first, `result` and every
`view` iteration fail with its defect instead of waiting. A run that fails on
its own settles `result` with its own error without waiting for the fold; the
fold's defect then reaches `view` iterations only. Breaking the loop
stops that reader while the run continues. If launch fails before the run
enters the session, `view` ends without a value and `result` carries the
failure.

Every yielded view is a value: the fold publishes immutable levels with
copy-on-touch structural sharing, so an older view stays exactly what it was
for as long as it is held, and a branch the later level did not touch is the
same object in both. An older view is stable to read; it is not a fold input,
so nothing in the package folds onto anything but the latest level. The exported
`SessionView`, `StreamView`, and
`TranscriptView` types are read-only all the way down (`ReadonlyMap`, readonly
arrays); a write through a cast corrupts the session every later run in the
process reads. The run's transcript rows (`StreamView.transcript`) are
subscribed on its behalf, its stream and its descendants as they appear, and
stay resident for the life of the process.

Runs share one session per workspace storage root. The runtime's session
owner holds it, the same owner every TeXRA host opens its sessions through, so
opening a root twice (two runs, or a run beside a host in the same process)
resolves the one session already open there; a second root gets its own. When the session was opened by a host (the extension, the desktop, or the CLI in the same process), that host's decision delivery applies to every run on it: retries and approvals prompt in the host's UI and the run waits there, as PR #11893 section 8 rules; the package's inline retry denial applies only to sessions the package opened itself. A
session ends only through `closeSession(roots)`: it refuses new runs on the
root, interrupts the runs it owns and waits for them to settle within the
runtime's shutdown budget (or the `signal` you pass, when the close runs under
a budget of your own), flushes its artifacts, and releases the session,
returning `{ settled, abandoned }`. `settled` is true when every run ended in
time; otherwise `abandoned` names the runs still live, and the session stays
open, refusing new runs, until they end. The platform's shutdown path
(`lifecycle.runShutdown()`), which an embedder runs before it exits, closes
the platform's session this way after the runs it owns have settled, and then
disposes the runtime the session owner ran on.

That path runs once, so `runAgent` composes once per process: a run started
after the platform's shutdown has run is refused, because the session it would
open has no shutdown left to close and flush it. An embedder that needs more
than one composition in a process takes the Effect surface below, where each
scope owns the composition it made.

## Run results

There is exactly one result shape: `AgentFlowResult`, a union discriminated on
`category` (`'workflow'` | `'toolUse'`). Both members carry the same run
identity and accounting — `executionId`, `streamId`, an optional coarse
`totalCostUsd` covering the run and its subagents, and, on a failed run, a
structured `error`. A `workflow` result adds `outputs` and `compileFailures`; a
`toolUse` result adds `response`, `files`, and the `structured` value of a
`submit_output` tool. Switch on `category` before reading either half.

`run.result` is terminal-only. Internally a tool-use flow also has a
non-terminal `WAITING` state — the run is parked mid-session waiting on the
user rather than finished — and the runtime carries a separate waiting shape
for it. That shape is deliberately not exported and never resolves `result`: a
parked run has no outcome to report, and this surface has no interactive
channel to un-park it (see [Current limits](#current-limits)). Watch the trace
stream if you need to observe a run reaching that state.

Two things a host sees are absent here on purpose. The normalized `cost`
breakdown and the per-file `diffs` summary live on an internal result type used
for persistence and host presentation; the embedding contract exposes only the
coarse `totalCostUsd` and leaves diffing to the embedder, which already owns the
files.

## Entry points

| Entry                     | Contents                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@texra-ai/agent`         | `runAgent`, `closeSession`, `AgentRun`, `defineTool`, `MapToolRegistry`, and the `AgentEvent` / `ITool` / `AgentFlowResult` / `SessionCloseReport` types |
| `@texra-ai/agent/schemas` | Zod schemas + inferred types for agent definitions, configs, and run results                                                                             |
| `@texra-ai/agent/node`    | `nodePlatform(options)`, a ready-made Node `Platform` with its workspace roots                                                                           |
| `@texra-ai/agent/effect`  | `Runtime`, `Sessions`, `Session`, `Run` and the tagged errors: the services the entry above renders                                                      |

Every entry needs the `effect` and `zod` peers installed, the root one
included: `@texra-ai/agent` is the Effect surface rendered as Promises, and
its bundle imports `effect` at runtime like the subpath does.

## Effect

`@texra-ai/agent/effect` is the surface. Everything this package decides is
stated once there, in Effect: which level is a run's first, when its transcript
interest changes, when its drain ends, which failure wins. `@texra-ai/agent`
above is that surface rendered as Promises and AsyncIterables, and holds no
logic of its own. It stays the Promise entry because the published SDK is one
of the three boundary kinds rule R1 of TeXRA's Effect migration names
(`.agents/docs/proposed/architecture/2026-08-26-effect-4-runtime-migration.md`, §7): host entries, the
tool `execute()` contract, and this package's public API speak Promises;
everything below them is Effect-typed.

`effect` is a peer dependency of every entry, not only this one. See
[Install](#install).

```ts
import { Effect, Stream } from 'effect';
import { Runtime, Sessions } from '@texra-ai/agent/effect';
import { nodePlatform } from '@texra-ai/agent/node';

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open();
  yield* Effect.forkScoped(Stream.runForEach(session.view.changes, render));
  const run = yield* session.start({ agent: 'polish', instruction });
  yield* session.subscribe([{ id: run.streamId, fromSeq: 0 }]);
  yield* session.request({
    kind: 'followUp.send',
    streamId: run.streamId,
    text: 'Keep the theorem statements unchanged.',
  });
  return yield* run.result;
}).pipe(Effect.scoped, Effect.provide(Runtime.layer(nodePlatform(options))));
```

| Service    | What it is                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Runtime`  | The composed process: the platform and its workspace roots. `Runtime.layer(platform)` provides it and `Sessions`, with this scope as the lifetime of the hold it takes on that composition. |
| `Sessions` | The process's one session owner: `open(roots?)`, `close(roots?, signal?)`, `list`. One session per workspace storage root, the same owner every TeXRA host opens through.                   |
| `Session`  | `start`, `request`, `view.changes`, `events`, and `subscribe`, whose transcript interest is held for a `Scope` and cleared when it closes. A value, one per root, not a tag.                |
| `Run`      | `executionId`, `streamId`, `result`, `view`, `events`, `interrupt`. `start` succeeds at admission: the run exists in the session, its stream published and its trace live.                  |

`session.view.changes` publishes the fold's levels as values: each is
immutable, an older level stays exactly what it was for as long as it is held,
and a branch the later level did not touch is the same object in both.

The composition is held, not owned: each `Runtime.layer` scope takes a hold on
it, and the last hold to end is what closes every session the owner holds,
each settling its runs and flushing its artifacts, and then disposes the
runtime they ran on. So two overlapping scopes over one platform are safe, the
first one out ends nothing the second is still using, and a later program in
the same process composes again over the platform already installed. That is
what the Promise entry cannot do, and why it composes once: its owner is the
embedder's shutdown path, which runs once. A composition that found a host's
own installation ends nothing however its holds end: those sessions are the
host's, and killing its live runs is not this package's to do.

Failures are `Data.TaggedError`s: `PlatformConflict`, `AgentNotFound`,
`ToolsRefused`, and `RunFailure`, whose `cause` is exactly what the launch path
threw, which is what the Promise entry rejects with. A `session.request`
answers with the runtime's own `Outcome` or its `RequestError` union, the same
values every TeXRA host reads. Nothing else is exported: no store, no fold
internals, no host widgets.

A runnable version of this program against a packed tarball is in
[`example/`](./example).

## The platform

Every run needs a `Platform`: the process-wide host port bundle (global state,
filesystem, storage, secrets, logging) plus the `WorkspaceRoots` of the folder
the runs work in (workspace path, its storage path, config, and workspace
state). `nodePlatform()` supplies both: process-local config and state,
TeXRA's ordinary storage layout, and environment-variable secrets (so provider
API keys are read from `process.env`; nothing is persisted).

The platform is **process-wide**. Create one and reuse it for every run; passing
a second, different platform in the same process throws.

Implement the `Platform` ports and the `roots` yourself when embedding in a
host that already owns those services.

## Custom tools

```ts
import { defineTool, runAgent } from '@texra-ai/agent';
```

Pass `tools` to `runAgent`. Custom tools are accepted for **tool-use** agents
only; passing them to a workflow agent throws.

## Current limits

These are enforced, not undocumented — each throws or degrades loudly rather
than failing quietly:

- **Approval-requiring tools are refused.** A tool with `requiresApproval` throws
  at launch. There is no interactive approval channel yet: the package attaches
  one headless host to each session for its whole life, so concurrent runs on a
  root never displace each other's host.
- **Interactive retry always denies.** A run that would prompt to retry gets a
  denial with a reason instead.
- **No resume.** `nodePlatform` reports no resumable streams; resuming a
  persisted tool-use session is host-side functionality today.
- **No language-model port.** `nodePlatform` wires the unavailable port, so a
  host that needs host-provided models must supply its own.
- **Remote agents are not loaded** — the local `agentsDir` only.

## License

See `LICENSE.txt`.
