# Bidirectional Follow-ups

## Current State

The FollowUpQueue supports bidirectional message flow between orchestrators and subagents:

- **Subagent → Orchestrator**: Results delivered via `ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg)` through `onBeforeWaiting` callback (tool-use) or `onCompleted` callback (workflow).
- **Orchestrator → Subagent**: Follow-up instructions sent via the `resume_subagent` tool, which routes through `sendSubagentFollowUp()` and triggers auto-resume of WAITING sessions.

## Architecture

### Orchestrator → Subagent Flow

```
1. Orchestrator calls resume_subagent(execution_id, instruction)
2. ResumeSubagentTool resolves execution_id → AgentExecutionHandle → childStreamId
3. sendSubagentFollowUp() routes the instruction to the child stream:
   a. Active session → direct append via session.appendFollowUp()
   b. WAITING session → queue + auto-resume via tryAutoResumeSubagent()
   c. RESUMING session → queue (processed when resume completes)
4. Subagent resumes from persisted state with new instruction as user message
5. Subagent delivers refined result via onBeforeWaiting → orchestrator's FollowUpQueue
```

### Key Design Decisions

- **Message format**: Plain text instructions. The subagent sees the follow-up as a standard user message in its conversation, maintaining simplicity and compatibility with the existing tool-use cycle.
- **Queueing semantics**: Reuses the existing `FollowUpQueue` (same channel for both user and orchestrator messages). No separate bidirectional channel needed — the subagent's WaitNode already consumes follow-ups generically.
- **Resume mechanism**: Follow-ups are injected via `sendFollowUp()` which queues to the child stream's `FollowUpQueue`. For WAITING sessions, `tryAutoResumeSubagent()` retrieves the session snapshot and triggers `texra.resumeAgent` to restart the persisted flow.
- **Nesting depth**: `resume_subagent` is included in `DELEGATION_TOOLS` and filtered out for subagents (`isSubagent: true`), preventing infinite delegation chains.

### Components

| Component | File | Role |
|-----------|------|------|
| `resume_subagent` tool | `src/tools/ResumeSubagentTool.ts` | Tool interface for orchestrators |
| `sendSubagentFollowUp()` | `src/agent/toolUse/ToolUseFollowUp.ts` | Execution ID → stream routing |
| `sendFollowUp()` | `src/agent/toolUse/ToolUseFollowUp.ts` | Stream-level follow-up routing |
| `ToolUseFollowUpQueue` | `src/agent/toolUse/ToolUseFollowUpQueueManager.ts` | Queue management |
| `ToolUseWaitNode` | `src/agent/implementations/flows/tooluse/nodes/ToolUseWaitNode.ts` | Consumes follow-ups |

## Typical Flow

1. Orchestrator launches subagent via `delegate_agent`
2. Subagent completes initial work, delivers result via FollowUpQueue
3. Subagent enters WAITING state (flow paused, state persisted)
4. Orchestrator reviews result, decides refinement is needed
5. Orchestrator calls `resume_subagent` with execution ID and new instruction
6. Subagent resumes from snapshot, processes instruction, delivers refined result
7. Steps 4-6 can repeat for iterative refinement

## Timeout and Cleanup

Subagents remain in WAITING state until:
- The orchestrator sends a follow-up (via `resume_subagent`)
- The user manually resumes or stops the session
- The VS Code window is closed (session state persists on disk via `ExecutionKVStore`)

The `StreamStatusService.shouldPreserveOnCompletion` mechanism prevents premature cleanup of WAITING state.

## Non-Goals

- This design does not cover real-time streaming of subagent progress to the orchestrator. Progress is already available via the executions tool with `action=wait`.
- This does not replace the proposal system for launching new agents. Bidirectional follow-ups are for iterating on an already-running subagent.
