# Subagent Output Return Design

## Problem Statement

Today, when a tool-use orchestrator agent delegates work via `propose_workflow` or `propose_agent`, the subagent executes as **fire-and-forget**. The orchestrator receives a simple confirmation string ("Workflow agent 'correct' started. Monitor ProgressBoard for status.") and has no mechanism to receive the subagent's actual output.

**Current flow** (`WorkflowTool.ts:308`):

```
Orchestrator calls propose_workflow
  → User approves proposal
  → executeAgentWithLogging(proposal)   // fire-and-forget, not awaited
  → return { summary: "Started 'correct' on paper.tex" }
```

The orchestrator cannot:
- Know when the subagent finished
- Read the subagent's output files
- React to subagent errors
- Make decisions based on subagent results

This document proposes three return patterns—**sync**, **await-async**, and **async-come-back-later**—and analyzes their fit with the existing architecture.

---

## Current Architecture Summary

### What exists today

| Component | Role | Key file |
|-----------|------|----------|
| `propose_workflow` tool | Proposes workflow agent, awaits user approval, fires agent | `src/tools/WorkflowTool.ts` |
| `propose_agent` tool | Proposes tool-use agent, same pattern | `src/tools/WorkflowTool.ts` |
| `AgentProposalCoordinator` | Promise-based coordinator for user approval | `src/agent/runtime/AgentProposalCoordinator.ts` |
| `BasePromiseCoordinator` | Generic promise infrastructure (show/resolve events) | `src/agent/runtime/BasePromiseCoordinator.ts` |
| `executeAgent()` | Resolves agent, acquires stream lock, runs flow | `src/agent/runtime/executeAgent.ts` |
| `runReflectionFlow()` | Workflow execution, returns `{ roundOutputs, status }` | `src/agent/implementations/flows/reflection/runReflectionFlow.ts` |
| `runToolUseFlow()` | Tool-use execution, returns `{ status }` | `src/agent/implementations/flows/tooluse/` |
| `FollowUpQueue` | Promise-based message queue for tool-use sessions | `src/agent/toolUse/FollowUpQueue.ts` |
| `StreamStatusService` | Tracks stream execution state (RUNNING/STOPPED/etc.) | `src/agent/runtime/StreamStatusService.ts` |
| `ProgressEventBus` | Pub/sub with buffering for UI events | `src/eventBus/ProgressEventBus.ts` |

### Key observations

1. **`executeAgent()` already returns a Promise** that resolves when the flow completes. The result (`EndGroupStatus`) and `roundOutputs` are available—they just aren't surfaced to the calling tool.

2. **Stream locking prevents concurrent execution** on the same streamId. Subagents get their own streamId, so they run independently.

3. **The proposal coordinator pattern** (BasePromiseCoordinator) already demonstrates how to bridge async operations with promise-based waiting.

4. **Workflow agents produce structured output** (`RoundOutput[]`) containing file locations, diffs, and XML summaries. Tool-use agents produce conversational output.

5. **The FollowUpQueue** demonstrates a message-passing pattern between independent execution contexts.

---

## Proposed Patterns

### Pattern 1: Synchronous (Await in Tool Call)

**Concept**: The `propose_workflow` / `propose_agent` tool awaits the subagent's full execution and returns the result as part of its `ToolResult`.

**Flow**:

```
Orchestrator model calls propose_workflow(agent=correct, inputFile=paper.tex)
  → User approves
  → const result = await executeAgentAndCollectOutput(proposal)
  → return ToolResult { output: result.summary, files: result.outputFiles }
```

**Implementation sketch**:

```typescript
// In WorkflowTool.ts, replace executeAgentWithLogging(proposal)

async function executeAgentAndCollectOutput(
  proposal: WorkflowAgentProposal,
): Promise<SubagentResult> {
  const configPayload: AgentConfigPayload = { ...proposal, agentCategory: ... };

  // executeAgent already returns Promise<void>, but internally has the result.
  // New variant: executeAgentWithResult() returns the flow result.
  const result = await executeAgentWithResult(configPayload);

  return {
    status: result.status,
    roundOutputs: result.roundOutputs,
    outputFiles: result.roundOutputs.flatMap(r =>
      r.outputs.map(o => o.location.absolutePath)
    ),
    summary: formatSubagentSummary(result),
  };
}
```

**Changes required**:

1. **New `executeAgentWithResult()`** in `executeAgent.ts` — like `executeAgent()` but returns `RunReflectionFlowResult` instead of `void`. Minimal change: the flow result is already computed at lines 484-490, just needs to be returned.

2. **Updated `WorkflowAgentTool.execute()`** — await the execution instead of fire-and-forget. Format the result into a `ToolResult` with output file paths and summary text.

3. **Streaming progress** — since the tool call blocks for the full subagent duration, the orchestrator's tool-use cycle pauses. The event bus already streams progress to the ProgressBoard UI, so the user sees real-time updates. But the orchestrator model receives nothing until completion.

**Pros**:
- Simplest mental model—tool returns result, orchestrator continues
- No new infrastructure needed
- Output is guaranteed available when orchestrator resumes
- Natural fit for PocketFlow's sequential node execution

**Cons**:
- **Long blocking**: A workflow agent can run for many minutes. The orchestrator's tool-use cycle is frozen during this time. The model's connection may time out (provider-dependent).
- **No parallelism**: Orchestrator cannot dispatch multiple subagents concurrently.
- **Stream lock**: The orchestrator holds its own stream lock the entire time. If the user wants to interact with the orchestrator during subagent execution, they cannot.

**Best for**: Short, deterministic subagent tasks (single-round corrections, quick merges).

---

### Pattern 2: Await-Async (Launch, Then Await)

**Concept**: The tool call launches the subagent and immediately returns a handle/ticket. The orchestrator can then explicitly await the result using a second tool call (`await_subagent`), or do other work first.

**Flow**:

```
1. Orchestrator calls propose_workflow(agent=correct, inputFile=paper.tex)
     → User approves
     → subagentId = launchSubagent(proposal)   // non-blocking
     → return ToolResult { output: "Launched subagent abc-123" }

2. Orchestrator does other work (calls other tools, reasons, etc.)

3. Orchestrator calls await_subagent(id=abc-123)
     → blocks until subagent completes
     → return ToolResult { output: result.summary, files: result.outputFiles }
```

**Implementation sketch**:

```typescript
// New: SubagentTracker singleton
class SubagentTracker {
  private readonly pending = new Map<string, Promise<SubagentResult>>();
  private readonly results = new Map<string, SubagentResult>();

  launch(id: string, proposal: AgentProposal): void {
    const promise = executeAgentWithResult(proposal)
      .then(result => {
        this.results.set(id, result);
        this.pending.delete(id);
        return result;
      })
      .catch(err => {
        const errorResult: SubagentResult = { status: 'error', error: err.message };
        this.results.set(id, errorResult);
        this.pending.delete(id);
        return errorResult;
      });
    this.pending.set(id, promise);
  }

  async await(id: string): Promise<SubagentResult> {
    // Already completed?
    const existing = this.results.get(id);
    if (existing) return existing;

    // Still running?
    const pending = this.pending.get(id);
    if (pending) return pending;

    throw new Error(`Unknown subagent: ${id}`);
  }

  /** Check status without blocking */
  status(id: string): 'pending' | 'completed' | 'error' | 'unknown' {
    if (this.results.has(id)) {
      return this.results.get(id)!.status === 'error' ? 'error' : 'completed';
    }
    if (this.pending.has(id)) return 'pending';
    return 'unknown';
  }
}
```

**New tools**:

```typescript
// await_subagent tool
const AwaitSubagentSchema = z.object({
  id: z.string().describe('Subagent ID returned by propose_workflow/propose_agent'),
});

class AwaitSubagentTool extends defineTool({
  name: 'await_subagent',
  description: 'Wait for a previously launched subagent to complete and get its result.',
  schema: AwaitSubagentSchema,
}) {
  async execute(input): Promise<ToolResult> {
    const result = await subagentTracker.await(input.id);
    return formatSubagentResult(result);
  }
}

// check_subagent tool (optional, for polling)
class CheckSubagentTool extends defineTool({
  name: 'check_subagent',
  description: 'Check the status of a launched subagent without blocking.',
  schema: z.object({ id: z.string() }),
}) {
  async execute(input): Promise<ToolResult> {
    const status = subagentTracker.status(input.id);
    if (status === 'completed') {
      return formatSubagentResult(subagentTracker.getResult(input.id));
    }
    return { output: `Subagent ${input.id}: ${status}` };
  }
}
```

**Changes required**:

1. **`SubagentTracker`** — new singleton that manages launched subagent promises and stores their results. Lives alongside `AgentProposalCoordinator`.

2. **`executeAgentWithResult()`** — same as Pattern 1.

3. **Updated `propose_workflow` / `propose_agent`** — after approval, calls `subagentTracker.launch(id, proposal)` instead of `executeAgentWithLogging()`. Returns the subagent ID.

4. **New `await_subagent` tool** — blocks on the tracker's promise. Returns structured result.

5. **Optional `check_subagent` tool** — non-blocking status check.

6. **Cleanup** — results must be evicted after the orchestrator's session ends. Tie cleanup to stream disposal via `StreamStatusService`.

**Pros**:
- Orchestrator can do useful work while subagent runs
- Supports launching multiple subagents concurrently, then awaiting all
- Clean separation: launch is fast, await is explicit
- The await point is chosen by the orchestrator, not forced

**Cons**:
- Two tool calls per subagent interaction (launch + await)
- Model must remember the subagent ID across turns
- More complex mental model for the LLM
- Still blocks when awaiting (though only at the orchestrator's chosen point)

**Best for**: Multi-step orchestration where the orchestrator dispatches several subagents and collects results.

---

### Pattern 3: Async Come-Back-Later (Event-Driven Delivery)

**Concept**: The subagent runs fully asynchronously. When it completes, its output is injected into the orchestrator's conversation as a follow-up message, similar to how `FollowUpQueue` works for user messages.

**Flow**:

```
1. Orchestrator calls propose_workflow(agent=correct, inputFile=paper.tex)
     → User approves
     → launch subagent with completion callback
     → return ToolResult { output: "Subagent abc-123 launched. Results will be delivered automatically." }

2. Orchestrator continues its conversation normally

3. [Subagent completes in background]
     → Completion callback fires
     → Result injected into orchestrator's FollowUpQueue
     → ToolUsePrepNode picks it up before next model call

4. Orchestrator's next turn sees:
   "[Subagent result: correct on paper.tex]
    Status: completed
    Output files: paper_correct_gemini3p_r0.tex
    Changes: +42 -18 lines"
```

**Implementation sketch**:

```typescript
// In WorkflowTool.ts after approval:
const subagentId = randomUUID();
const orchestratorStreamId = getRequiredStreamId();

executeAgentWithResult(configPayload)
  .then(result => {
    const message = formatSubagentCompletion(subagentId, proposal, result);
    // Inject into orchestrator's follow-up queue
    ToolUseFollowUpQueueManager.enqueue(orchestratorStreamId, message);
  })
  .catch(err => {
    const message = formatSubagentError(subagentId, proposal, err);
    ToolUseFollowUpQueueManager.enqueue(orchestratorStreamId, message);
  });

return {
  summary: `Launched '${input.agent}' (id: ${subagentId})`,
  output: 'Subagent launched. Results will appear in your conversation when ready.',
};
```

**The FollowUpQueue already supports this pattern**:

- `ToolUsePrepNode` (in `ToolUseCycleFlow.ts:198-228`) checks for queued follow-ups before every model call
- If a follow-up exists, it's injected as a user message
- The model sees it and can react in its next response
- The queue handles the timing: if the model is mid-generation, the message waits; if the model is idle (in WaitNode), the message triggers a new cycle

**Two sub-variants**:

**3a. Deliver on next turn**: Result enters `FollowUpQueue`. Orchestrator sees it only when it naturally loops back (after current tool execution completes and the model generates a response that the user follows up on — or the WaitNode triggers).

**3b. Interrupt current turn**: Result enters `FollowUpQueue` and additionally signals the orchestrator's cycle to check for follow-ups. This requires cooperation from `ToolUsePrepNode` which already does this check.

The difference: 3a requires the orchestrator to still be in an active session (WaitNode). 3b works even if the orchestrator is mid-generation, but the message won't be seen until the current cycle's prep phase.

**Changes required**:

1. **`executeAgentWithResult()`** — same as Pattern 1 and 2.

2. **Updated `propose_workflow` / `propose_agent`** — after approval, launch with a completion callback that enqueues to the orchestrator's `FollowUpQueue`.

3. **Subagent result formatting** — structured message format that the orchestrator's model can parse.

4. **Session lifetime management** — if the orchestrator's session has ended by the time the subagent completes, the result has nowhere to go. Options:
   - Store results in persistent storage, deliver on session resume
   - Emit to ProgressBoard as a fallback notification
   - Both (store + notify)

5. **Optional: `SubagentResultStore`** — persistent storage for results that outlive sessions. Allows the user to resume the orchestrator and see what happened.

**Pros**:
- Zero blocking—orchestrator never waits
- Natural conversation flow—results appear as messages
- Leverages existing `FollowUpQueue` infrastructure
- Subagent completion can arrive at any point in the conversation
- Multiple subagents complete independently and results stream in

**Cons**:
- Orchestrator model must handle results arriving at unpredictable times
- Results may arrive mid-conversation about a different topic
- No guarantee the orchestrator is still running when results arrive
- Requires careful session lifetime management
- Model may not "remember" what it dispatched if many turns have passed
- Testing is harder (non-deterministic timing)

**Best for**: Long-running subagents where the orchestrator or user continues working. Research agents that take minutes. Background batch processing.

---

## Comparison Matrix

| Dimension | Pattern 1: Sync | Pattern 2: Await-Async | Pattern 3: Come-Back-Later |
|-----------|-----------------|----------------------|---------------------------|
| **Complexity** | Low | Medium | Medium-High |
| **New tools** | 0 | 1-2 (await, check) | 0 |
| **New infrastructure** | `executeAgentWithResult()` | + `SubagentTracker` | + result formatting + lifetime mgmt |
| **Blocking** | Full (entire subagent run) | Partial (only at await point) | None |
| **Parallelism** | None | Yes (launch N, await N) | Yes (natural) |
| **Result guarantee** | Always available | Available at await | May be lost if session ends |
| **Model complexity** | Low (call returns result) | Medium (remember IDs) | High (handle async messages) |
| **Existing infra reuse** | `executeAgent` + `ToolResult` | + `BasePromiseCoordinator` pattern | + `FollowUpQueue` |
| **Timeout risk** | High (long subagents) | Low-Medium | None |
| **User interactivity** | Blocked during subagent | Partial | Full |

---

## Recommendation: Phased Implementation

### Phase 1: Sync (Pattern 1)

Start here. It requires the least new code and provides immediate value:

1. Add `executeAgentWithResult()` to `executeAgent.ts` — ~30 lines, wraps existing `executeAgent()` to return `RunReflectionFlowResult`.
2. Update `WorkflowAgentTool.execute()` to await and return the result.
3. Add a `mode: 'sync' | 'async'` parameter to the tool schema (default `'sync'`).

This unblocks the core use case: orchestrator dispatches a correction agent, gets the result, decides what to do next.

### Phase 2: Await-Async (Pattern 2)

Add when orchestrators need to dispatch multiple subagents:

1. Build `SubagentTracker` (follows `BasePromiseCoordinator` pattern).
2. Add `await_subagent` tool.
3. When `mode: 'async'`, launch via tracker instead of awaiting inline.

### Phase 3: Come-Back-Later (Pattern 3)

Add for long-running background agents:

1. Wire completion callback to `FollowUpQueue`.
2. Add `SubagentResultStore` for persistence across sessions.
3. Integrate with ProgressBoard for result notifications.

### Why this order?

- Each phase builds on the previous (executeAgentWithResult → SubagentTracker → FollowUpQueue delivery)
- Sync is the minimum viable feature
- Await-async requires the model to understand subagent IDs (prompt engineering)
- Come-back-later requires session lifetime management (most complex)

---

## Shared Infrastructure: `SubagentResult` Schema

All three patterns need a common result type:

```typescript
// src/shared/schemas/subagent.ts

export const SubagentResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('completed'),
    agentName: z.string(),
    model: z.string(),
    roundOutputs: RoundOutputSchema.array(),
    outputFiles: FileLocationSchema.array(),
    totalRounds: z.number(),
    summary: z.string(),
  }),
  z.strictObject({
    status: z.literal('error'),
    agentName: z.string(),
    model: z.string(),
    error: z.string(),
  }),
  z.strictObject({
    status: z.literal('cancelled'),
    agentName: z.string(),
    model: z.string(),
    reason: z.string(),
  }),
]);

export type SubagentResult = z.infer<typeof SubagentResultSchema>;
```

## Shared Infrastructure: `executeAgentWithResult()`

The key enabling function for all patterns:

```typescript
// In executeAgent.ts

export async function executeAgentWithResult(
  configPayload: AgentConfigPayload,
  executionId?: ExecutionId,
): Promise<SubagentResult> {
  // Reuse all existing resolution logic
  const ctx = await resolveAgentBase(configPayload, executionId);
  const { setting, streamId, config } = ctx;

  try {
    acquireStreamOrThrow(streamId);

    // Run the flow (same as executeAgent, but capture result)
    const flowResult = await runFlowCore(ctx, streamId);

    return {
      status: 'completed',
      agentName: config.agent,
      model: config.model,
      roundOutputs: flowResult.roundOutputs ?? [],
      outputFiles: (flowResult.roundOutputs ?? [])
        .flatMap(r => r.outputs.map(o => o.location)),
      totalRounds: flowResult.roundOutputs?.length ?? 0,
      summary: buildSummary(config, flowResult),
    };
  } catch (err) {
    return {
      status: 'error',
      agentName: config.agent,
      model: config.model,
      error: toErrorMessage(err),
    };
  }
}
```

---

## Open Questions

1. **Tool-use subagents**: Workflow agents produce file outputs. Tool-use agents produce conversational output (no `roundOutputs`). How should tool-use subagent results be structured? Options:
   - Return the full conversation transcript
   - Return only the final assistant message
   - Return a structured summary (tool-use agents could write to a "result" field)

2. **Output file reading**: Should the orchestrator receive file *contents* or just file *paths*? Paths are smaller but require the orchestrator to read files. Contents are self-contained but can be large.

3. **Timeout handling for Pattern 1**: What's the maximum acceptable blocking time? Should there be a configurable timeout that auto-switches to async mode?

4. **Concurrent subagent limits**: Should there be a cap on how many subagents an orchestrator can launch simultaneously? The stream lock system already prevents duplicate streams, but multiple distinct subagents could overwhelm API quotas.

5. **Result formatting for Pattern 3**: How should async results be formatted when injected as follow-up messages? The model needs to distinguish subagent results from user messages. A structured prefix/wrapper would help: `[subagent-result: id=abc-123, agent=correct, status=completed]`.
