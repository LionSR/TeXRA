---
created: 2026-06-28
---

# Sub-PRD 02: One `requestRuntimeStreamResume` Command

## Context

Resuming a stream from its persisted snapshot is a fixed-order runtime
transaction: read the persisted `{ executionId, taskState }`, classify the
resume state, then dispatch to the tool-use or workflow resume path under a
status guard. Only the classify step (`readRuntimeSessionResumeData`) is shared
today.

## Problem

The classify-and-dispatch sequence is hand-written in two hosts and will be in
every future host:

- Extension: `tryResumeFromSnapshot` (`packages/extension/src/commands/agent/resumeFromSnapshot.ts:25-97`)
  reads `progressState.snapshots`, calls `readRuntimeSessionResumeData`, switches
  on `missing` / `failed` / `resumable`, then dispatches `toolUse`
  (`requestRuntimeToolUseSnapshotResume`) vs `workflow`
  (`requestRuntimeWorkflowResume`) with an active/resuming guard.
- Desktop: `tryResumeStream` (`packages/desktop/src/main/desktopAgentExecution.ts:877-955`)
  re-implements the same switch and dispatch.
- CLI uses a divergent config-based variant (`resumeCommands` already owns its
  classification), which is a legitimate difference.

Per PRD Rule 2 (no host re-implements a runtime transaction), the host should
make one runtime request and render the typed result. Branching on
`resume.type` in host code is the Pattern 3 Ask anti-pattern.

## Design

Add one deep command to `resumeCommands`:

```ts
requestRuntimeStreamResume({
  streamId, executionId, taskState, runtimeHost, session,
  runWorkflow,           // host callback for the workflow launch leg
}): Promise<RuntimeStreamResumeResult>
```

It owns: `readRuntimeSessionResumeData`, the missing/failed/resumable switch, the
tool-use vs workflow dispatch, and the active/resuming ownership guard. It
returns a typed host-facing result; the host renders the message and never sees
`resume.type`. Extension and desktop collapse to one call plus a `runWorkflow`
callback.

This is the same boundary the agent-identity audit's resume item names, and it
folds the host-safe projection so `SessionResumeData` / the tool-use snapshot no
longer leak to hosts.

## Scope

- `src/agent/runtime/resumeCommands.ts`: new `requestRuntimeStreamResume` (+
  result type) wrapping the existing private resume steps.
- `packages/extension/src/commands/agent/resumeFromSnapshot.ts` and
  `packages/desktop/src/main/desktopAgentExecution.ts`: collapse to the one call.
- Keep `config.agent` raw for the stream-id reproduction the resume path relies
  on (see Sub-PRD 04).

## Acceptance

- Neither host branches on `resume.type`; both call one command.
- An invariant test proves supplied-session ownership and that a duplicate
  resume does not clear another owner's `RESUMING` guard, and that
  `RESUMING -> WAITING` repair holds when the workflow callback throws.

## Risk

- Medium. The status algebra is subtle (the existing snapshot-resume command is
  the model). The CLI variant stays as-is; do not force it through the new
  command if its config-based entry is genuinely different.
