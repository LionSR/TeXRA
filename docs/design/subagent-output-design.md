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

## Parallel Tool Calling Considerations

### Current behavior

The orchestrator model can emit **multiple tool calls in a single response** (e.g., two `propose_workflow` calls for different files). Today these are dispatched through `ToolUseDispatchNode` which extends `BatchNode` — executing them **sequentially**, not in parallel (`ToolUseCycleFlow.ts:564`).

A `ParallelBatchNode` exists (`node/index.ts:244-257`) that uses `Promise.all` but is **not currently used** for tool dispatch.

### Impact per pattern

**Pattern 1 (Sync)**: If the orchestrator emits two `propose_workflow` calls in one response, they run sequentially. Subagent A finishes, then subagent B starts. Total time = A + B. This is the worst case for parallel dispatch.

To fix: Switch `ToolUseDispatchNode` from `BatchNode` to `ParallelBatchNode`. Both proposal tools would execute concurrently — each awaits its own subagent, and `Promise.all` collects both results. Total time = max(A, B). However, both tools block simultaneously, which means two approval dialogs may appear and two subagents run in parallel (API quota impact).

**Pattern 2 (Await-Async)**: Natural fit. The orchestrator emits two `propose_workflow` calls in one response. Both launch immediately (non-blocking), both return subagent IDs. Later, the orchestrator emits two `await_subagent` calls in one response. With `ParallelBatchNode`, both awaits resolve concurrently. Even with `BatchNode`, the second `await` resolves near-instantly if the subagent finished while the first was being awaited.

```
Turn 1: [propose_workflow(A), propose_workflow(B)]  → "id-1", "id-2"
Turn 2: [await_subagent(id-1), await_subagent(id-2)] → results
```

**Pattern 3 (Come-Back-Later)**: Parallel dispatch is irrelevant — all launches are non-blocking. Results arrive independently via `FollowUpQueue`.

### Recommendation

For Patterns 1 and 2, switching to `ParallelBatchNode` for `ToolUseDispatchNode` is a prerequisite for true parallel subagent execution. This is a one-line change (`extends ParallelBatchNode` instead of `extends BatchNode`) but has broader implications: **all** tool calls in a response would then execute concurrently, not just subagent proposals. This needs careful validation for tools that have side effects or ordering dependencies.

A safer alternative: keep `BatchNode` as default, but let individual tools declare `parallelSafe: true`. The dispatch node could then partition calls into parallel-safe and sequential groups.

---

## Tool-Use Subagent Output Definition

### Problem

Workflow subagents produce structured `RoundOutput[]` (file locations, diffs, XML summaries). Tool-use subagents produce **conversational output** — there is no equivalent structured result.

### Proposal: Last assistant response as output

For tool-use subagents, define the output as the **last model assistant response text** from the conversation. This is already tracked:

- `ToolUseProcessNode.post()` stores `workspace.assembly.lastResponse = execRes.text` when `endTurn` is true (`ToolUseCycleFlow.ts:513`)
- The full `shared.conversation` (array of `ProviderMessage[]`) is maintained throughout the session and accessible at flow end (`ToolUseCycleNode.ts:156`)

### Implementation

Extend `RunToolUseFlowResult` to include the output:

```typescript
// Current
export interface RunToolUseFlowResult {
  status: EndGroupStatus;
}

// Proposed
export interface RunToolUseFlowResult {
  status: EndGroupStatus;
  /** Last assistant text response (for subagent output reporting). */
  lastResponse?: string;
  /** Full conversation for detailed inspection (optional, large). */
  conversation?: ProviderMessage[];
}
```

In `runToolUseFlow()`, capture from the shared state before returning:

```typescript
// At end of runToolUseFlow(), before return:
const lastAssistantMsg = shared.conversation
  .filter(m => m.role === 'assistant')
  .at(-1);
const lastResponse = extractTextFromMessage(lastAssistantMsg);

return { status, lastResponse };
```

### SubagentResult for tool-use agents

```typescript
// Add to the discriminated union:
z.strictObject({
  status: z.literal('completed'),
  agentName: z.string(),
  model: z.string(),
  agentCategory: z.literal('toolUse'),
  lastResponse: z.string(),           // Last assistant message text
  // No roundOutputs/outputFiles — tool-use agents don't produce these
})
```

This keeps the output lightweight (single string) while providing the meaningful content. The orchestrator can parse structured data from the response if the subagent was instructed to produce it (e.g., "return your findings as a JSON list").

---

## Parent-Child Agent Lineage

### Problem

Today, when a subagent is launched, there is no record of which orchestrator spawned it. This prevents:
- Cascading cancellation (stop orchestrator → stop its subagents)
- Progress tree views (show subagents nested under their parent)
- Result routing (deliver subagent output back to the correct orchestrator)
- Debugging (trace which agent spawned a failing subagent)

### Proposal: SubagentLineage tracking

Introduce a lightweight lineage record that links subagents to their parent orchestrator.

```typescript
// src/shared/schemas/subagent.ts

export const SubagentLineageSchema = z.strictObject({
  /** Unique ID for this subagent execution */
  subagentId: z.string().uuid(),
  /** StreamTabId of the parent orchestrator that spawned this subagent */
  parentStreamId: StreamTabIdSchema,
  /** ExecutionId of the parent orchestrator */
  parentExecutionId: ExecutionIdSchema,
  /** StreamTabId of the subagent itself */
  childStreamId: StreamTabIdSchema,
  /** ExecutionId of the subagent */
  childExecutionId: ExecutionIdSchema,
  /** Agent name of the child */
  childAgentName: z.string(),
  /** Agent category of the child */
  childAgentCategory: z.enum(['workflow', 'toolUse']),
  /** Timestamp when the subagent was launched */
  launchedAt: z.number(),
  /** Timestamp when the subagent completed (null if still running) */
  completedAt: z.number().nullable(),
});

export type SubagentLineage = z.infer<typeof SubagentLineageSchema>;
```

### SubagentRegistry singleton

```typescript
class SubagentRegistry {
  private readonly lineage = new Map<string, SubagentLineage>();

  /** Register a new parent-child relationship */
  register(entry: SubagentLineage): void {
    this.lineage.set(entry.subagentId, entry);
  }

  /** Get all children of a parent stream */
  getChildren(parentStreamId: StreamTabId): SubagentLineage[] {
    return [...this.lineage.values()]
      .filter(e => e.parentStreamId === parentStreamId);
  }

  /** Get the parent of a child stream */
  getParent(childStreamId: StreamTabId): SubagentLineage | undefined {
    return [...this.lineage.values()]
      .find(e => e.childStreamId === childStreamId);
  }

  /** Mark a subagent as completed */
  markCompleted(subagentId: string): void {
    const entry = this.lineage.get(subagentId);
    if (entry) entry.completedAt = Date.now();
  }

  /** Get all active (uncompleted) children of a parent */
  getActiveChildren(parentStreamId: StreamTabId): SubagentLineage[] {
    return this.getChildren(parentStreamId)
      .filter(e => e.completedAt === null);
  }

  /** Clean up entries for a completed parent */
  cleanupParent(parentStreamId: StreamTabId): void {
    for (const [id, entry] of this.lineage) {
      if (entry.parentStreamId === parentStreamId) {
        this.lineage.delete(id);
      }
    }
  }
}

export const subagentRegistry = new SubagentRegistry();
```

### Integration points

1. **At launch time** (`WorkflowTool.ts`): When `executeAgentWithLogging()` / `executeAgentWithResult()` is called after approval, register the lineage entry. The parent's `streamId` and `executionId` are available from the tool's context (`getCurrentToolFileInteractionContext()`).

2. **At completion time**: The `executeAgent()` wrapper marks the entry as completed. For Pattern 2/3, this triggers result delivery.

3. **At cancellation time**: When an orchestrator is interrupted, `getActiveChildren()` can identify running subagents for cascading cancellation via `StreamStatusService`.

4. **For ProgressBoard**: Emit lineage info on the event bus so the UI can render a tree:
   ```typescript
   bus.emit('subagentLaunched', {
     parentStreamId,
     childStreamId,
     childAgentName,
   });
   ```

### Depth limits

For safety, enforce a maximum nesting depth (e.g., 3 levels). A subagent should not spawn its own subagents beyond this limit. Check at proposal time:

```typescript
function getLineageDepth(streamId: StreamTabId): number {
  const parent = subagentRegistry.getParent(streamId);
  if (!parent) return 0;
  return 1 + getLineageDepth(parent.parentStreamId);
}
```

---

## Updated Comparison Matrix

| Dimension | Pattern 1: Sync | Pattern 2: Await-Async | Pattern 3: Come-Back-Later |
|-----------|-----------------|----------------------|---------------------------|
| **Complexity** | Low | Medium | Medium-High |
| **New tools** | 0 | 1-2 (await, check) | 0 |
| **New infrastructure** | `executeAgentWithResult()` | + `SubagentTracker` | + result formatting + lifetime mgmt |
| **Blocking** | Full (entire subagent run) | Partial (only at await point) | None |
| **Parallelism** | Via ParallelBatchNode only | Yes (launch N, await N) | Yes (natural) |
| **Parallel tool calls** | Works but serializes subagent duration | Best fit — launch is instant | Trivial — all non-blocking |
| **Result guarantee** | Always available | Available at await | May be lost if session ends |
| **Model complexity** | Low (call returns result) | Medium (remember IDs) | High (handle async messages) |
| **Existing infra reuse** | `executeAgent` + `ToolResult` | + `BasePromiseCoordinator` | + `FollowUpQueue` |
| **Timeout risk** | High (long subagents) | Low-Medium | None |
| **User interactivity** | Blocked during subagent | Partial | Full |
| **Lineage tracking** | Optional | Required (ID tracking) | Required (result routing) |
| **Workflow output** | `RoundOutput[]` + file paths | Same | Same |
| **Tool-use output** | `lastResponse` text | Same | Same |

---

## Open Questions

1. **Output file reading**: Should the orchestrator receive file *contents* or just file *paths*? Paths are smaller but require the orchestrator to read files with a separate tool call. Contents are self-contained but can be large. A middle ground: include a short diff summary (already available in `RoundOutput.outputs[].diff`) and file paths.

2. **Timeout handling for Pattern 1**: What's the maximum acceptable blocking time? Should there be a configurable timeout that auto-switches to async mode? Provider-specific limits (Anthropic tool calls can run for several minutes; some providers may time out).

3. **Concurrent subagent limits**: Should there be a cap on how many subagents an orchestrator can launch simultaneously? The stream lock system prevents duplicate streams, but multiple distinct subagents could overwhelm API quotas. The `SubagentRegistry` can enforce this via `getActiveChildren().length`.

4. **Result formatting for Pattern 3**: How should async results be formatted when injected as follow-up messages? The model needs to distinguish subagent results from user messages. Proposal: XML-wrapped structured format that the model can parse:
   ```xml
   <subagent-result id="abc-123" agent="correct" status="completed">
     <output-files>paper_correct_gemini3p_r0.tex</output-files>
     <diff-summary>+42 -18 lines</diff-summary>
   </subagent-result>
   ```

5. **ParallelBatchNode migration**: Should `ToolUseDispatchNode` switch to `ParallelBatchNode` unconditionally, or should it be opt-in per tool? Some tools may have ordering dependencies (e.g., file creation before file read). A `parallelSafe` tool metadata flag could gate this.

6. **Nesting depth for subagent-of-subagent**: Proposed limit of 3 levels. Should this be configurable? What happens when a subagent tries to exceed the limit — hard error or silent degradation to sync?

7. **Lineage persistence**: Should the `SubagentRegistry` persist across extension restarts (write to `ExecutionKVStore`), or is in-memory sufficient? Persistence would allow resume scenarios where the extension restarts mid-subagent-execution.
