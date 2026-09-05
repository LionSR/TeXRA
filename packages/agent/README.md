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

`zod` (v4) is a peer dependency.

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

Event delivery starts at the iterator's first `next()`. Awaiting only `result`
does not retain trace events, and ending iteration detaches the event source
while the run itself continues.

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

Each view is the runtime's own value, not a copy: a yielded view supersedes
the one before it, and the maps and arrays beneath an older view may already
show a later level. The exported `SessionView`, `StreamView`, and
`TranscriptView` types are read-only all the way down (`ReadonlyMap`, readonly
arrays); a write through a cast corrupts the session every later run in the
process reads. The run's transcript rows (`StreamView.transcript`) are
subscribed on its behalf, its stream and its descendants as they appear, and
stay resident for the life of the process.

Runs share one session per workspace storage root. The runtime's session
owner holds it, the same owner every TeXRA host opens its sessions through, so
opening a root twice (two runs, or a run beside a host in the same process)
resolves the one session already open there; a second root gets its own. A
session ends only through `closeSession(roots)`: it refuses new runs on the
root, interrupts the runs it owns and waits for them to settle within the
runtime's shutdown budget, flushes its artifacts, and releases the session,
returning `{ settled, abandoned }`. `settled` is true when every run ended in
time; otherwise `abandoned` names the runs still live, and the session stays
open, refusing new runs, until they end. The platform's shutdown path
(`lifecycle.runShutdown()`), which an embedder runs before it exits, closes
the platform's session this way after the runs it owns have settled.

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
