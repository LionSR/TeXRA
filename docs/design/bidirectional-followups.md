# Bidirectional Follow-ups (Future Work)

## Current State

The FollowUpQueue is unidirectional: subagents deliver results to the orchestrator via `ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg)`. Once delivered, the subagent either exits or enters WAITING state.

The `onBeforeWaiting` callback infrastructure already exists — tool-use subagents fire this callback before entering WAITING, allowing the orchestrator to receive interim results without waiting for the flow to fully exit.

## Vision

Enable the orchestrator to send follow-up instructions to a subagent that has reported back and is in WAITING state. This would allow iterative refinement without re-launching:

1. Subagent completes initial work, delivers result via FollowUpQueue
2. Subagent enters WAITING state (flow paused, resources retained)
3. Orchestrator reviews result, decides refinement is needed
4. Orchestrator sends follow-up instruction to the waiting subagent
5. Subagent resumes with the new instruction, produces refined result

## Key Questions

- **Message format**: How should the orchestrator's follow-up instruction be structured? Plain text? Structured payload with context about what to refine?
- **Queueing semantics**: Should the subagent's FollowUpQueue be bidirectional, or should a separate channel exist for orchestrator-to-subagent messages?
- **Resume mechanism**: How does the waiting subagent consume the follow-up? The current FollowUpQueue is consumed during the tool-use cycle — a reverse queue would need to inject into the subagent's conversation as a user message.
- **Timeout and cleanup**: How long should a subagent remain in WAITING? What happens if the orchestrator never sends a follow-up?
- **Nesting depth**: Should bidirectional follow-ups be limited to one level, or can a subagent itself delegate and wait?

## Dependencies

- Requires the ExecutionHandle refactoring (completed) — handles provide the `terminate()` and status introspection needed for lifecycle management of waiting subagents.
- The `StreamStatusService.shouldPreserveOnCompletion` mechanism already preserves WAITING state, preventing premature cleanup.

## Non-Goals

- This design does not cover real-time streaming of subagent progress to the orchestrator. Progress is already available via the executions tool with `action=wait`.
- This does not replace the proposal system for launching new agents. Bidirectional follow-ups are for iterating on an already-running subagent.
