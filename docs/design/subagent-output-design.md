# Subagent Output Return Design

## The Actual Problem

`executeAgent()` returns `void`. The flow result is computed, then discarded.

```
WorkflowTool.execute()
  → executeAgentWithLogging(proposal)    // fire-and-forget, discards Promise
    → executeAgent(configPayload)        // returns Promise<void>
      → runFlowWithLifecycle(ctx, ...)   // only passes status to lifecycle
        → runReflectionFlow(...)         // returns { roundOutputs, status }
        → return result.status           // ← roundOutputs thrown away here
```

`runReflectionFlow()` already returns `{ roundOutputs: RoundOutput[], status }`. `RoundOutput` already contains everything the orchestrator needs: output file locations, diff stats, file lineage. The data exists. It's just discarded at `executeAgent.ts:490` because `runFlowWithLifecycle` only captures `EndGroupStatus`.

For tool-use agents, `runToolUseFlow()` returns `{ status }` — no output data at all. But the conversation and last response ARE in `shared` at flow end. They're just not surfaced.

This is not a "three-pattern design problem." This is a function signature bug.

---

## What Each Agent Type Actually Produces

### Workflow agents: Generated files

The orchestrator needs the **file artifacts**, not the raw model response.

`OutputNode` produces a `RoundOutput` per round (`ReflectionFlow OutputNode.ts:91-213`). By flow end, `shared.roundOutputs` is a complete array. Each `RoundOutput` contains:

```
RoundOutput
├── round: number
├── rawOutput: FileLocation | null          ← raw XML/text (not useful to orchestrator)
├── outputs: OutputFileInfo[]               ← THE ACTUAL OUTPUT
│   ├── source: string                      ← source tag
│   ├── location: FileLocation              ← WHERE the output file is
│   │   ├── absolutePath: string
│   │   ├── relativePath: string
│   │   └── kind: 'workspace' | 'runStorage'
│   ├── round: number
│   ├── lineage                             ← file relationships
│   │   ├── original: FileLocation | null   ← base input file
│   │   ├── diffBase: FileLocation | null   ← file compared against
│   │   └── diffFile: FileLocation | null   ← compiled diff PDF
│   └── diff: DiffStats | null              ← WHAT CHANGED
│       ├── added: number
│       └── removed: number
└── xmlSummary: OutputXmlSummary            ← XML metadata (internal)
```

What the orchestrator actually cares about from this:

| Field                             | Why                               |
| --------------------------------- | --------------------------------- |
| `outputs[].location.relativePath` | Where to find the generated file  |
| `outputs[].diff.added / .removed` | How much changed (quality signal) |
| `outputs[].lineage.original`      | Which input file this came from   |
| `status`                          | Did it succeed                    |

That's it. Not the XML summary. Not the raw output. Not the conversation. The **files and their diffs**.

### Tool-use agents: Last assistant response

Tool-use agents don't produce files through the flow — they produce conversational output. The right output is the **last assistant response text**.

This is already tracked at `ToolUseCycleFlow.ts:513`:

```typescript
workspace.assembly.lastResponse = execRes.text; // stored on endTurn
```

And the full conversation is in `shared.conversation` at flow end (`ToolUseCycleNode.ts:156`).

But `runToolUseFlow()` discards both — it returns only `{ status }`.

---

## Root Cause: `executeAgent()` Conflates Two Concerns

`executeAgent()` does two unrelated things:

1. **Run the flow** — resolve agent, build context, execute, get result
2. **Manage UI lifecycle** — acquire stream lock, show notifications, display errors, set stream status

These are tangled together. The command layer (UI buttons, commands) needs #2. The tool layer (subagent delegation) needs #1. Today both callers go through the same function, so the tool layer gets the UI lifecycle it doesn't need and loses the result it does need.

---

## Proposed Refactoring: Split `executeAgent`

### Step 1: Make the flows return their output

**`runToolUseFlow`** — add `lastResponse` to its result:

```typescript
// Current (runToolUseFlow.ts:47-50)
export interface RunToolUseFlowResult {
  status: EndGroupStatus;
}

// Proposed
export interface RunToolUseFlowResult {
  status: EndGroupStatus;
  lastResponse?: string;
}
```

Capture before return (at `runToolUseFlow.ts:178`):

```typescript
// Extract last assistant text from the conversation
const lastAssistant = shared.conversation
  .filter((m) => m.role === 'assistant')
  .at(-1);

return {
  status,
  lastResponse: lastAssistant
    ? services.modelHandler.extractTextFromMessage(lastAssistant)
    : undefined,
};
```

**`runReflectionFlow`** — already returns `roundOutputs`. No change needed.

### Step 2: Unified flow result type

```typescript
// src/agent/runtime/AgentFlowResult.ts

/** What a workflow agent execution produces. */
export interface WorkflowFlowResult {
  category: 'workflow';
  status: EndGroupStatus;
  outputs: OutputFileSummary[];
}

/** What a tool-use agent execution produces. */
export interface ToolUseFlowResult {
  category: 'toolUse';
  status: EndGroupStatus;
  lastResponse: string | undefined;
}

export type AgentFlowResult = WorkflowFlowResult | ToolUseFlowResult;

/** Minimal file output info — what the orchestrator needs. */
export interface OutputFileSummary {
  /** Relative path to generated file */
  relativePath: string;
  /** Absolute path to generated file */
  absolutePath: string;
  /** Which input file produced this output */
  originalPath: string | null;
  /** Lines added */
  added: number | null;
  /** Lines removed */
  removed: number | null;
}
```

This is **not** a Zod schema. It's a plain TypeScript type. It doesn't need runtime validation — it's an internal boundary between two functions in the same process. No serialization, no persistence, no over-engineering.

If `OutputFileSummary` later needs to cross a serialization boundary (e.g., sent to a webview, persisted to KVStore), convert to a Zod schema at that point per CLAUDE.md: "Define schemas first, then derive TypeScript types using `z.infer<typeof Schema>`." Until then, a plain interface is correct.

`OutputFileSummary` is a projection of `OutputFileInfo` — it extracts the 5 fields the orchestrator cares about and drops the rest. The orchestrator doesn't need `FileLocation` discriminated unions, `xmlSummary`, `rawOutput`, or `lineage.diffFile`.

### Step 3: Extract `executeAgentCore()`

```typescript
// executeAgent.ts — new function

/**
 * Core agent execution. Runs the flow and returns the result.
 * No UI side effects. No stream locking. No notifications.
 * Callers manage their own lifecycle.
 */
export async function executeAgentCore(
  configPayload: AgentConfigPayload,
  executionId?: ExecutionId,
): Promise<AgentFlowResult> {
  const ctx = await resolveAgentBase(configPayload, executionId);
  const { setting, config } = ctx;

  if (setting.agentCategory === AgentCategory.ToolUse) {
    const result = await runToolUseFlow({
      ...ctx,
      ...createInterruptCallbacks(),
      getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'tool-use'),
      setting: setting as AgentToolUseSetting,
      onFollowUpConsumed: () =>
        bus.emit('updateQueuedFollowUps', { streamId: ctx.streamId }),
    });
    return {
      category: 'toolUse',
      status: result.status,
      lastResponse: result.lastResponse,
    };
  }

  const result = await runReflectionFlow({
    ...ctx,
    ...createInterruptCallbacks(),
    getUsageRecorder: createUsageRecorder(ctx.usageMonitor, 'workflow'),
    setting: setting as AgentWorkflowSetting,
    parentStage: ctx.parentStage,
  });

  return {
    category: 'workflow',
    status: result.status,
    outputs: result.roundOutputs.flatMap((r) =>
      r.outputs.map((o) => ({
        relativePath: o.location.relativePath ?? o.location.absolutePath,
        absolutePath: o.location.absolutePath,
        originalPath: o.lineage?.original?.absolutePath ?? null,
        added: o.diff?.added ?? null,
        removed: o.diff?.removed ?? null,
      })),
    ),
  };
}
```

**`executeAgent()` becomes a thin wrapper:**

```typescript
export async function executeAgent(
  configPayload: AgentConfigPayload,
  executionId?: ExecutionId,
): Promise<void> {
  // ... same stream locking, notification, lifecycle code ...
  // But internally calls executeAgentCore() and uses only result.status
  // Existing callers unchanged.
}
```

### Step 4: Update the delegation tools

```typescript
// WorkflowTool.ts — the key change

// Replace:
executeAgentWithLogging(proposal);
return { summary: `Started '${input.agent}' on ${input.inputFile}`, ... };

// With:
const result = await executeAgentCore(configPayload);
return formatFlowResult(result, input);
```

Where `formatFlowResult` for workflow agents returns:

```typescript
{
  summary: `'${agent}' completed on ${inputFile}`,
  output: [
    `Agent '${agent}' completed with status: ${result.status}`,
    '',
    'Generated files:',
    ...result.outputs.map(o =>
      `  ${o.relativePath} (${formatDiff(o.added, o.removed)})`
    ),
  ].join('\n'),
}
```

The orchestrator sees:

```
Agent 'correct' completed with status: completed

Generated files:
  paper_correct_gemini3p_r0.tex (+42 -18 lines)
```

Not a 500-line XML dump. Not the raw model response. Just the files and what changed.

For tool-use agents:

```
Agent 'search' completed with status: completed

Response:
I found 4 relevant papers on efficient transformer attention...
```

---

## The Three Execution Modes

With `executeAgentCore()` extracted, the three modes become trivial. They're not "patterns" — they're just different ways to call a function that returns a Promise.

### Mode A: Sync (await inline)

```typescript
const result = await executeAgentCore(configPayload);
return formatFlowResult(result);
```

One line. The tool blocks, the orchestrator waits, the result comes back as a `ToolResult`.

### Mode B: Launch-and-await (store the Promise)

```typescript
// Launch — keep own reference to the promise, separate from lineage
const promise = executeAgentCore(configPayload);
pendingResults.set(subagentId, promise);
registerSubagent(subagentId, parentStreamId, childStreamId, agentName, promise);
return { output: `Launched subagent ${subagentId}` };

// Later, in await_subagent tool:
const result = await pendingResults.get(id);
pendingResults.delete(id);
return formatFlowResult(result);
```

`pendingResults` is a `Map<string, Promise<AgentFlowResult>>`. It lives in the tool module, not in the lineage module. The lineage map tracks active children for lifecycle; `pendingResults` holds promises for the `await_subagent` tool to resolve. Each map has one job. The promise reference survives lineage auto-cleanup because it's a separate map.

### Mode C: Fire-and-deliver (via FollowUpQueue)

```typescript
const orchestratorStreamId = getRequiredStreamId();
executeAgentCore(configPayload)
  .then((result) => {
    const msg = formatSubagentDelivery(subagentId, result);
    ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg);
  })
  .catch((err) => {
    const msg = formatSubagentError(subagentId, err);
    ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg);
  });
return { output: `Launched subagent ${subagentId}. Result will be delivered.` };
```

### How the orchestrator chooses

Add a `mode` parameter to the tool schema:

```typescript
mode: z.enum(['sync', 'async', 'background'])
  .prefault('sync')
  .describe(
    'sync: wait for result. async: launch and use await_subagent later. background: result delivered as follow-up.',
  );
```

Uses `.prefault('sync')` — consistent with existing tool schemas in `WorkflowTool.ts` (e.g., `model: z.string().prefault('gemini3p')`). Per AGENTS.md, `.prefault()` normalizes input before validation, which is the right pattern for tool defaults where the LLM may omit the field entirely.

Default is `sync` because it's the simplest and most useful. The model can choose `async` when it wants to launch multiple subagents in parallel.

---

## Parallel Tool Calling

### Current state

`ToolUseDispatchNode` extends `BatchNode` — all tool calls in a single model response execute **sequentially** (`ToolUseCycleFlow.ts:564`). A `ParallelBatchNode` exists (`node/index.ts:244-257`) using `Promise.all` but is unused.

### Impact

With `sync` mode, if the model emits `[delegate_workflow(A), delegate_workflow(B)]` in one response, they serialize: A runs to completion, then B starts. Total time = A + B.

With `async` mode, both launch instantly (non-blocking). The model later emits `[await_subagent(id-1), await_subagent(id-2)]`. Even under sequential `BatchNode`, the second await resolves near-instantly because both subagents ran concurrently.

**Switching to `ParallelBatchNode`** would let sync-mode calls run concurrently too. But that affects ALL tools, not just subagent delegation. Some tools have ordering dependencies.

### Pragmatic fix

Don't change `BatchNode` vs `ParallelBatchNode`. Instead: `async` mode solves the parallel case naturally. The model launches N subagents (instant, non-blocking), then awaits them (also instant if already done). No infrastructure change to the dispatch node needed.

If we later want true parallel sync mode, add a `parallelSafe` flag to tool metadata and have the dispatch node partition calls.

---

## Follow-Up Context Building (Pattern C Deep Dive)

### The delivery path

When a subagent completes in background mode, the result flows through:

```
executeAgentCore(configPayload).then(result => {
  ToolUseFollowUpQueue.enqueue(orchestratorStreamId, formattedMsg);
})
```

The follow-up queue is the static `ToolUseFollowUpQueue` manager (`ToolUseFollowUpQueueManager.ts:53`), keyed by `StreamTabId`. It auto-creates queues and works regardless of whether the orchestrator's session is active.

### How the orchestrator consumes it

The delivery chain:

```
1. ToolUseFollowUpQueue.enqueue(streamId, text)
   └→ FollowUpQueue.enqueue(text) — adds to array or resolves pending waitForNext

2. If orchestrator is in WaitNode (waiting for user):
   └→ session.waitForFollowUp() resolves with the enqueued text
   └→ ToolUseWaitNode.post() creates user follow-up message
   └→ Returns CONTINUE → loops back to CycleNode

3. If orchestrator is mid-cycle (model calling / tool executing):
   └→ Text sits in queue
   └→ On NEXT round, ToolUseRoundPrepNode.prep() checks session.hasQueuedFollowUp()
   └→ Drains queue, calls modelHandler.createUserFollowUpMessages()
   └→ Appended to shared.messages as user message before next model call
```

### The semantic problem

Both paths inject the subagent result as a **user-role message** via `createUserFollowUpMessages()`. The model sees:

```
[assistant]: I'll launch the correction agent...
[tool_result]: Launched subagent abc-123
[user]: <subagent-result agent="correct" status="completed">     ← WRONG ROLE
          Output: paper_correct.tex (+42 -18)
        </subagent-result>
```

The model thinks the user typed a subagent result. This is semantically confused.

### Pragmatic fix: structured prefix, don't over-engineer the role

The model can handle this if the system prompt explains it. Use a structured prefix:

```
[SUBAGENT COMPLETED: abc-123]
Agent: correct
Status: completed
Output files:
  paper_correct_gemini3p_r0.tex (+42 -18 lines)
```

The system prompt tells the orchestrator: "Messages prefixed with [SUBAGENT COMPLETED: ...] are automated delivery of background agent results, not user input."

This is pragmatic. It works. The alternative — introducing a new message role or a parallel injection path that bypasses `createUserFollowUpMessages` — is over-engineering for a v1. If it proves to be a real problem in practice, THEN build a dedicated channel.

### Session lifetime edge case

If the orchestrator's session has ended (WaitNode returned stop, flow exited):

1. `ToolUseFollowUpQueue.enqueue()` still works — it auto-creates the queue
2. But nobody is listening — the orchestrator's flow has exited
3. If the user resumes the session, `ToolUsePrepareNode` restores from snapshot and `ToolUseRoundPrepNode` drains the queue on the next round

So results are NOT lost — they persist in the queue until the session resumes or the queue is released. The only true loss case is if `ToolUseFollowUpQueue.release(streamId)` is called before the subagent completes. This happens in `ToolUseSessionLifecycle.dispose()`.

**Fix**: Don't release the queue if there are pending subagents (check via lineage registry). Release on subagent completion instead.

---

## Nesting Constraint: No Orchestrator-Launches-Orchestrator

An orchestrator is an agent that has delegation tools (`delegate_workflow`, `delegate_agent`). Agents launched via those delegation tools **never** receive delegation tools — they are workers, not orchestrators. One level of delegation, no recursion.

**Why**: Nesting adds cascading lifecycle complexity (cascading cancellation, recursive depth tracking, multi-level result routing) for no demonstrated use case. The orchestrator dispatches work; the workers do work and return results. If a task needs further decomposition, the orchestrator handles it in its next turn after collecting the subagent's output.

**Enforcement**: `resolveTools()` in `ToolUseFlowContext.ts` is where agent tool lists are resolved from YAML config against the registry. When called for a subagent, filter out delegation tools before they reach the flow:

```typescript
// In resolveTools() — add isSubagent parameter:
const DELEGATION_TOOLS = new Set(['delegate_workflow', 'delegate_agent']);

export function resolveTools(
  tools: AgentToolUseSetting['tools'],
  registry: IToolRegistry,
  logger: { warn: (msg: string) => void },
  options?: { isSubagent?: boolean },
): ToolDefinition[] {
  const toolConfigs = Array.isArray(tools) ? tools : [];

  const resolved = toolConfigs
    .map((config) => (typeof config === 'string' ? { name: config } : config))
    .filter((def) => {
      if (options?.isSubagent && DELEGATION_TOOLS.has(def.name)) return false;
      if (!registry.has(def.name)) {
        logger.warn(`Tool "${def.name}" not found in registry`);
        return false;
      }
      return true;
    });

  // ... memory tool injection unchanged ...
  return resolved;
}
```

The call site in `WorkflowTool.ts` passes `{ isSubagent: true }` through to the flow setup. The subagent simply never sees delegation tools. No depth counter, no configuration flag, no exceptions.

---

## Parent-Child Lineage

### Why it's needed

Not for some future dream feature. It's needed NOW for:

1. **Result routing** (Mode C): which orchestrator does the subagent deliver to?
2. **Queue lifetime**: don't dispose the orchestrator's queue while subagents are running
3. **Cascading cancellation**: stopping the orchestrator should stop its subagents
4. **Nesting enforcement**: reject delegation tools if calling agent is already a subagent

### Minimal implementation

Don't build a registry class. Use a Map. Lives in `src/agent/runtime/` alongside `executeAgent.ts` and `StreamStatusService.ts` — it's about agent execution lifecycle, not specifically tool-use.

The lineage map tracks **active children only** — for lifecycle queries (`hasActiveChildren`, `isSubagent`, cascading cancellation). It does NOT store promises or results. Mode B keeps its own `Promise` reference; mode C delivers via `.then()`. Each concern has one owner.

```typescript
// src/agent/runtime/subagentLineage.ts

interface SubagentEntry {
  parentStreamId: StreamTabId;
  childStreamId: StreamTabId;
  childAgentName: string;
}

const activeSubagents = new Map<string, SubagentEntry>();

export function registerSubagent(
  subagentId: string,
  parentStreamId: StreamTabId,
  childStreamId: StreamTabId,
  childAgentName: string,
  promise: Promise<unknown>,
): void {
  activeSubagents.set(subagentId, {
    parentStreamId,
    childStreamId,
    childAgentName,
  });
  // Auto-cleanup: entry removed when subagent settles (success or failure).
  // By this point, Mode B already has its own reference to the promise,
  // and Mode C has already wired .then()/.catch(). The lineage map's job is done.
  promise.finally(() => activeSubagents.delete(subagentId));
}

export function getActiveChildren(
  parentStreamId: StreamTabId,
): SubagentEntry[] {
  return [...activeSubagents.values()].filter(
    (e) => e.parentStreamId === parentStreamId,
  );
}

export function hasActiveChildren(parentStreamId: StreamTabId): boolean {
  return getActiveChildren(parentStreamId).length > 0;
}

/** Check if a stream is itself a subagent (has a parent). */
export function isSubagent(streamId: StreamTabId): boolean {
  return [...activeSubagents.values()].some(
    (e) => e.childStreamId === streamId,
  );
}
```

No schemas. No classes. No timestamps. No `completedAt` field. The entry deletes itself when the promise settles.

---

## Summary: What To Build

### Changes to existing code (small, surgical)

| File                | Change                                             | Lines                       |
| ------------------- | -------------------------------------------------- | --------------------------- |
| `runToolUseFlow.ts` | Add `lastResponse` to result                       | ~5 lines                    |
| `executeAgent.ts`   | Extract `executeAgentCore()` from `executeAgent()` | ~40 lines (move, not write) |
| `WorkflowTool.ts`   | Await result, format file info                     | ~20 lines                   |

### New code

| File                 | Purpose                                             | Lines     |
| -------------------- | --------------------------------------------------- | --------- |
| `AgentFlowResult.ts` | `AgentFlowResult` + `OutputFileSummary` types       | ~25 lines |
| `subagentLineage.ts` | Active subagent tracking (one Map, three functions) | ~30 lines |

### What NOT to build

- `SubagentTracker` class — use `Map<string, SubagentEntry>`, the promise IS the tracker
- `SubagentResult` Zod schema — internal boundary, plain types are fine
- `SubagentRegistry` class with `register/getChildren/getParent/markCompleted/cleanupParent` — a Map with auto-cleanup via `promise.finally()`
- `SubagentResultStore` for persistence — the FollowUpQueue already persists
- `BasePromiseCoordinator` extension — not every async pattern needs a coordinator

### Execution modes (all enabled by `executeAgentCore`)

| Mode         | Implementation             | New tools            | Blocking       |
| ------------ | -------------------------- | -------------------- | -------------- |
| `sync`       | `await executeAgentCore()` | 0                    | Yes            |
| `async`      | Store promise, return ID   | 1 (`await_subagent`) | At await point |
| `background` | `.then()` → FollowUpQueue  | 0                    | No             |

Total new infrastructure: ~95 lines of code. One type file, one lineage file, minor edits to three existing files.

---

## Decisions Made

1. **No orchestrator-launches-orchestrator**: Delegation tools (`delegate_workflow`, `delegate_agent`) are filtered out in `resolveTools()` when `isSubagent` is true. Workers work, orchestrators orchestrate.

2. **Workflow output = file artifacts**: `OutputFileSummary[]` (paths + diffs), not raw model response text. Projection of `OutputFileInfo`.

3. **Tool-use output = last assistant response**: `lastResponse` string from `workspace.assembly.lastResponse`.

4. **`.prefault('sync')` for mode default**: Consistent with existing tool schema patterns in the codebase.

5. **Plain TypeScript types for internal boundary**: `AgentFlowResult` and `OutputFileSummary` are not Zod schemas. Convert to schema only if they cross a serialization boundary later.

6. **Lineage in `src/agent/runtime/`**: Alongside `executeAgent.ts` and `StreamStatusService.ts` — it's execution lifecycle infrastructure.

---

## Open Questions

1. **Default mode**: Should the default be `sync` (simple, blocking) or `async` (parallel-friendly)? Recommendation: `sync` — it's the mode where the model needs to understand the least.

2. **Queue lifetime for background mode**: When should the orchestrator's FollowUpQueue be released if subagents are still running? Proposal: `hasActiveChildren(streamId)` check in `ToolUseSessionLifecycle.dispose()`.

3. **File content vs. path**: The `ToolResult` returns file paths. Should it also include a short content preview (first N lines of the output)? Probably not for v1 — the orchestrator can use `read_file` if it needs the content.

4. **Streaming progress for sync mode**: The orchestrator blocks for the full subagent duration. Should we emit progress events that the ProgressBoard shows? Already happens — the event bus is independent of the tool call. No extra work needed.
