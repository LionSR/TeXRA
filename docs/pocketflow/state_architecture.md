# Agent State Architecture

TeXRA's agents follow the pocket flow model where flows operate over an explicit
shared store. This document outlines the state slices that travel through the
store and how they relate to the response and tool-use cycles.

## Shared store slices

Each agent execution owns an `AgentSharedStore` composed of the following
slices:

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

Flows receive a reference to the shared store and always mutate state through
these slices rather than copying structures between nodes.

## Usage tracking

The `RunUsageAccumulator` maintains derived totals for input, output, caching,
reasoning, and tool-use tokens. Each round stores both the derived usage summary
and the native provider payload. When a response completes, the run state
records the round, which updates the accumulator and captures the raw usage
snapshot. The `UsageMonitor` reads from the accumulator to emit telemetry while
summing native payloads to compute total cost.

## Persistence and resume

Tool-use persistence stores the serialized `AgentWorkspaceState` by delegating to
its `toJSON`/`fromJSON` helpers. Round and run state serialization hooks are
available through their `toJSON`/`fromJSON` methods for future resume support.

## Integration points

- **Response cycle flow** uses `AgentSharedStore` directly, mutating
  `store.round`, `store.run`, and `store.workspace` as the model is invoked and the
  response is processed.
- **Reflection run flow** keeps track of run progress through `AgentRunState`
  and persists round/tool states for later inspection.
- **Tool-use flows** rely on `AgentWorkspaceState` slices to manage assembled
  responses, media files, and reasoning caches while persisting state between
  executions.

By consolidating state management around the shared store, the refactored flows
align with the pocket flow design and make it easier to orchestrate agents,
resume executions, and surface telemetry.
