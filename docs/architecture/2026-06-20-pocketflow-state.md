# Agent State Architecture

TeXRA's agents follow the PocketFlow model where flows operate over explicit
state slices. This document outlines the state slices that travel through the
flow and how they relate to the response and tool-use cycles.

## State slices

Each agent execution uses the following state slices:

- **Round state (`ConversationRoundStateSnapshot`)** – Tracks the current round
  index, continuation count, accumulated response time, and the most recent
  usage snapshot. A plain Zod-validated object, not a wrapper class.
- **Run state (`AgentRunStateSnapshot`)** – Records run-level lifecycle data
  such as the total number of rounds executed, aggregate response time, and a
  `RunUsageAccumulator` that aggregates token usage across all rounds. Also a
  plain Zod-validated object; `recordCycleMetrics`/`recordRound`
  (`src/agent/core/state/AgentState.ts`) mutate it in place.
- **Workspace state (`AgentWorkspaceState`)** – A class providing focused
  slices for response assembly, media attachments, reasoning caches, and
  document metrics. Flows mutate these slices independently when composing
  responses.
- **User variable channels (`UserVariableChannels`)** – Separates immutable input
  variables, per-round transient variables, and exported output variables so
  orchestrators can safely compose multiple agents.

Flows receive references to these state slices directly (via `flow.setServices()`)
and mutate them in place rather than copying structures between nodes.

## Snapshot serialization

Round and run state are already snapshot-shaped: they are plain objects
validated by their Zod schemas (`ConversationRoundStateSnapshotSchema`,
`AgentRunStateSnapshotSchema`), so `structuredClone()` can checkpoint them
directly with no serialization step.

Workspace state is a class, so it exposes explicit conversion:

```typescript
// Serialize to a plain object (structuredClone-safe)
const workspaceSnapshot = workspaceState.toSnapshot();

// Restore from a snapshot
const workspaceState = AgentWorkspaceState.fromSnapshot(workspaceSnapshot);
```

Its own sub-slices (`FileInteractionState`, `MediaAttachmentState`,
`WorkPlanState`) follow the same `toSnapshot()` / static `fromSnapshot()`
pattern, composed by `AgentWorkspaceState`'s own methods.

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
- **Reflection run flow** keeps track of run progress through `AgentRunStateSnapshot`
  and persists round/tool states for later inspection.
- **Tool-use flows** pass state slices through `shared.stateSlices` as
  individual snapshots, reconstructing class instances only when needed.

By passing state slices directly (without wrapper classes for round/run state),
flows align with the PocketFlow design while eliminating unnecessary abstraction
overhead.
