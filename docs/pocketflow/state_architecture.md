# Agent State Architecture

TeXRA's agents follow the PocketFlow model where flows operate over explicit
state slices. This document outlines the state slices that travel through the
flow and how they relate to the response and tool-use cycles.

## State slices

Each agent execution uses the following state slices (passed directly, not
wrapped in a store class):

- **Round state (`ConversationRoundState`)** – Tracks the current round index,
  continuation count, accumulated response time, target output file, and the
  most recent usage snapshot. Round state also keeps a provider identifier and
  native usage payload so downstream tooling can access the raw SDK responses.
- **Run state (`AgentRunState`)** – Records run-level lifecycle data such as the
  total number of rounds executed, aggregate response time, and a
  `RunUsageAccumulator` that aggregates token usage across all rounds.
- **Workspace state (`AgentWorkspaceState`)** – Provides focused slices for
  response assembly, media attachments, reasoning caches, and document metrics.
  Flows mutate these slices independently when composing responses.
- **User variable channels (`UserVariableChannels`)** – Separates immutable input
  variables, per-round transient variables, and exported output variables so
  orchestrators can safely compose multiple agents.

Flows receive references to these state slices directly (via `flow.setServices()`)
and mutate them in place rather than copying structures between nodes.

## Snapshot serialization

State slices support snapshot serialization for PersistedFlow:

```typescript
// Serialize to plain objects (structuredClone-safe)
const runSnapshot = runState.toSnapshot();
const workspaceSnapshot = workspaceState.toSnapshot();

// Restore from snapshots
const runState = AgentRunState.fromSnapshot(runSnapshot);
const workspaceState = AgentWorkspaceState.fromSnapshot(workspaceSnapshot);
```

This pattern enables PersistedFlow to checkpoint state between nodes using
`structuredClone()` without requiring special handling.

## Usage tracking

The `RunUsageAccumulator` maintains derived totals for input, output, caching,
reasoning, and tool-use tokens. Each round stores both the derived usage summary
and the native provider payload. When a response completes, the run state
records the round, which updates the accumulator and captures the raw usage
snapshot. The `UsageMonitor` reads from the accumulator to emit telemetry while
summing native payloads to compute total cost.

## Integration points

- **Response cycle flow** receives state slices directly via `flow.setServices()`,
  mutating `run` and `workspace` as the model is invoked and response processed.
- **Reflection run flow** keeps track of run progress through `AgentRunState`
  and persists round/tool states for later inspection.
- **Tool-use flows** pass state slices through `shared.state.stateSlices` as
  individual snapshots, reconstructing class instances only when needed.

By passing state slices directly (without wrapper classes), flows align with the
PocketFlow design while eliminating unnecessary abstraction overhead.
