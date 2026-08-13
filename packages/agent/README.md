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
  interactions: { cancel: () => {} },
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
  interrupt(): void;
}
```

Event delivery starts at the iterator's first `next()`. Awaiting only `result`
does not retain trace events, and ending iteration detaches the event source
while the run itself continues.

## Entry points

| Entry                     | Contents                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@texra-ai/agent`         | `runAgent`, `AgentRun`, `defineTool`, `MapToolRegistry`, and the `AgentEvent` / `ITool` / `AgentFlowResult` types |
| `@texra-ai/agent/schemas` | Zod schemas + inferred types for agent definitions, configs, and run results                                      |
| `@texra-ai/agent/node`    | `nodePlatform(options)` — a ready-made Node `Platform`                                                            |

## The platform

Every run needs a `Platform`: the host port bundle (config, state, filesystem,
workspace, storage, secrets, logging). `nodePlatform()` supplies a Node
implementation — process-local config and state, TeXRA's ordinary storage
layout, and environment-variable secrets (so provider API keys are read from
`process.env`; nothing is persisted).

The platform is **process-wide**. Create one and reuse it for every run; passing
a second, different platform in the same process throws.

Implement the `Platform` ports yourself when embedding in a host that already
owns those services.

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
  at launch. The public `HostInteractions` is deliberately the minimal
  `cancel()` shape; there is no interactive approval channel yet.
- **Interactive retry always denies.** A run that would prompt to retry gets a
  denial with a reason instead.
- **No resume.** `nodePlatform` reports no resumable streams; resuming a
  persisted tool-use session is host-side functionality today.
- **No language-model port.** `nodePlatform` wires the unavailable port, so a
  host that needs host-provided models must supply its own.
- **Remote agents are not loaded** — the local `agentsDir` only.

## License

See `LICENSE.txt`.
