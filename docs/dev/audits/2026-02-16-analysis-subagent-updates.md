# Analysis: Can the Orchestrator Get Real-Time Updates from Subagents?

## Short Answer

**Yes, but with important caveats.** The orchestrator _can_ query running subagents via the `executions` tool endpoints, but it **doesn't receive streaming mid-execution updates automatically**. The system provides two distinct update channels:

1. **Active polling** via the `executions` tool (status, progress, todos, conversation)
2. **Passive delivery** via the FollowUpQueue (final or near-final results only)

The gap: there is **no push-based streaming of intermediate work** from subagent to orchestrator during execution. The orchestrator either polls or waits for completion.

---

## Architecture Diagram

```
                         ORCHESTRATOR (tool-use agent, streamId: A)
                         ════════════════════════════════════════
                              │                          ▲
                              │ delegate_workflow /       │ Result delivered via
                              │ delegate_agent           │ ToolUseFollowUpQueue.enqueue()
                              │                          │
                              ▼                          │
                    ┌─────────────────────┐              │
                    │  executeSubagent()  │              │
                    │                     │              │
                    │  1. generateId()    │              │
                    │  2. registerExec()  │              │
                    │  3. executeAgent()  │──────────────┤
                    │     with callbacks: │              │
                    │     - onBeforeWait  │──┐           │
                    │     - onCompleted   │──┤           │
                    │     - onStreamRes   │  │           │
                    └─────────────────────┘  │           │
                              │              │           │
                    Returns immediately:     │           │
                    "Launched async"          │           │
                              │              │           │
                              ▼              │           │
              ┌───────────────────────────┐  │           │
              │  SUBAGENT (streamId: B)   │  │           │
              │  ═══════════════════════  │  │           │
              │                           │  │           │
              │  ┌─────────────────────┐  │  │           │
              │  │ Tool-Use Flow:      │  │  │           │
              │  │                     │  │  │           │
              │  │  PrepareNode        │  │  │           │
              │  │    ↓                │  │  │           │
              │  │  CycleNode ←──┐    │  │  │           │
              │  │    │ (model   │    │  │  │           │
              │  │    │  call,   │    │  │  │           │
              │  │    │  tools)  │    │  │  │           │
              │  │    ↓          │    │  │  │           │
              │  │  WaitNode ────┘    │  │  │           │
              │  │    │               │  │  │           │
              │  │    │ onBeforeWait  │──┘  │           │
              │  │    │ fires HERE ───────────► enqueue()
              │  │    │               │      │           │
              │  │    ▼               │      │           │
              │  │  WAITING status    │      │           │
              │  └─────────────────────┘      │           │
              │                           │  │           │
              │  ┌─────────────────────┐  │  │           │
              │  │ Workflow Flow:      │  │  │           │
              │  │                     │  │  │           │
              │  │  PrepareContext     │  │  │           │
              │  │    ↓               │  │  │           │
              │  │  TeXCount          │  │  │           │
              │  │    ↓               │  │  │           │
              │  │  MediaExtraction   │  │  │           │
              │  │    ↓               │  │  │           │
              │  │  ResponseCycle     │  │  │           │
              │  │    ↓               │  │  │           │
              │  │  OutputNode        │  │  │           │
              │  │    │               │  │  │           │
              │  │    │ onCompleted   │──┘  │           │
              │  │    │ fires HERE ───────────► enqueue()
              │  └─────────────────────┘      │
              └───────────────────────────┘
```

---

## The Two Update Channels in Detail

### Channel 1: Active Polling via `executions` Tool

The orchestrator has access to the `executions` tool, which provides a REST-like virtual filesystem for querying subagent state:

```
/executions/{id}              → Summary: status, agent, model, progress, todos
/executions/{id}/config       → Agent configuration JSON
/executions/{id}/conversation → Full message history (tool-use subagents)
/executions/{id}/todos        → Task checklist (tool-use subagents)
/executions/{id}/report       → Persisted result report
/executions/{id}/children     → Child execution listing
/executions/{id}/files        → Generated output files (workflow subagents)
/executions/{id}/files/{path} → Read specific output file content
```

**Actions available:**

| Action | Behavior                                               |
| ------ | ------------------------------------------------------ |
| `view` | Returns data immediately (snapshot of current state)   |
| `wait` | Blocks until a status change occurs, then returns data |
| `kill` | Terminates the running execution                       |

**What the orchestrator CAN see while a subagent is running:**

| Endpoint                     | Live Data? | Details                                                                              |
| ---------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| Summary (`/executions/{id}`) | Yes        | Status (RUNNING/WAITING/etc), elapsed time, round progress (`round 2/5`)             |
| Conversation                 | Yes        | Full message history including tool calls and results, updated after each model turn |
| Todos                        | Yes        | Task list items with status (pending/in_progress/completed)                          |
| Files                        | Partial    | Only available after rounds complete (workflow agents write per-round)               |
| Report                       | No         | Only written on completion or when `onBeforeWaiting` fires                           |

**The `wait` action** is the efficient polling mechanism:

```
Orchestrator                          ExecutionRegistry
    │                                       │
    │  executions(path=/executions/{id},     │
    │             action=wait,               │
    │             timeout=300)               │
    │ ─────────────────────────────────────► │
    │                                       │  Registers changeCallback
    │              (blocks)                  │
    │                                       │  ◄── status transition
    │                                       │      (RUNNING→WAITING)
    │                                       │      OR progress update
    │                                       │      OR untrack (complete)
    │  ◄───────────────────────────────────  │
    │  Returns current summary              │
```

The `wait` action resolves on **any** of these events:

- Stream status change (RUNNING → WAITING, RUNNING → STOPPED, etc.)
- Round progress update (`updateExecutionProgress`)
- Execution kill
- Execution completion (untrack)
- Timeout

### Channel 2: Passive Delivery via FollowUpQueue

This is the **primary result delivery mechanism**. Results are pushed to the orchestrator's `ToolUseFollowUpQueue` as XML-formatted messages.

```
┌──────────────────────────────────────────────────────────────┐
│                    DELIVERY TIMING                            │
├──────────────┬──────────────────┬────────────────────────────┤
│ Subagent     │ Trigger          │ Mechanism                  │
│ Category     │                  │                            │
├──────────────┼──────────────────┼────────────────────────────┤
│ Tool-use     │ Enters WAITING   │ onBeforeWaiting callback   │
│              │ state (done with │ fires BEFORE the agent     │
│              │ autonomous work) │ actually enters WAITING    │
├──────────────┼──────────────────┼────────────────────────────┤
│ Workflow     │ Flow completes   │ onCompleted callback fires │
│              │ (all rounds      │ after runner() promise     │
│              │ finished)        │ resolves                   │
├──────────────┼──────────────────┼────────────────────────────┤
│ Either       │ Promise rejects  │ .catch() formats error     │
│ (on error)   │                  │ and enqueues               │
└──────────────┴──────────────────┴────────────────────────────┘
```

**Deduplication guard:** A `hasDelivered` boolean ensures only one delivery per subagent. If `onBeforeWaiting` already fired, `onCompleted` becomes a no-op.

**Delivery format (XML injected as user message):**

```xml
<!-- Tool-use subagent result -->
<subagent-result id="abc123" agent="chat" category="toolUse" status="stopped">
  <response>Here is what I found about the citation errors...</response>
</subagent-result>

<!-- Workflow subagent result -->
<subagent-result id="def456" agent="correct" category="workflow" status="completed">
  <output-files>
    <file path="paper_corrected.tex" location="runStorage" added="12" removed="8" />
  </output-files>
</subagent-result>

<!-- Error -->
<subagent-error id="ghi789" agent="polish">
  <message>Model rate limit exceeded</message>
</subagent-error>
```

---

## The Gap: What the Orchestrator CANNOT See

### No Streaming of Intermediate Work

The orchestrator does **not** receive real-time streaming of:

- Model token generation in progress
- Individual tool call results as they happen
- Partial document rewrites mid-round

The event bus (`ProgressEventBus`) streams these to the **UI/webview** but not back to the orchestrator agent's conversation context.

```
                    Event Bus (ProgressEventBus)
                    ════════════════════════════
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
        Webview UI      Progress Board    Log Panel
        (real-time      (task groups,     (tool calls,
         status)         subagent          model
                         badges)           responses)

              ▲               ▲               ▲
              │               │               │
     updateStreamStatus  updateActive     addLogMessage
     updateTodos         Subagents        updateLogMessage
     updateQueued        setParentStream
     FollowUps
```

The event bus is **frontend-facing only**. The orchestrator agent has no event bus subscription mechanism.

### Polling Tax

To get intermediate updates, the orchestrator must **actively spend a tool call** on the `executions` tool. Each query consumes a model turn. The `wait` action mitigates this by blocking until something changes, but the orchestrator still needs to:

1. Decide to check on the subagent
2. Issue a tool call (`executions` with `action=wait`)
3. Process the response
4. Decide whether to check again

This creates a **latency floor**: the orchestrator only learns about subagent progress when it chooses to look.

---

## Complete Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        USER INTERACTION LAYER                           │
│  ┌──────────┐  ┌──────────────┐  ┌─────────────┐  ┌────────────────┐  │
│  │ Webview   │  │ Progress     │  │ Log Panel   │  │ Subagent       │  │
│  │ (chat UI) │  │ Board        │  │             │  │ Badges         │  │
│  └─────▲─────┘  └──────▲───────┘  └──────▲──────┘  └──────▲─────────┘  │
│        │               │                │               │              │
│        │     WebviewUpdater.postMessage()│               │              │
│        └───────────────┴────────────────┴───────────────┘              │
│                                  ▲                                      │
│                     ProgressEventHandler                                │
│                     (subscribes to all events)                          │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                        ProgressEventBus (pub-sub)
                                  │
          ┌───────────────────────┼────────────────────────┐
          │                       │                        │
   updateActiveSubagents    updateStreamStatus        addLogMessage
   setParentStream          updateQueuedFollowUps     updateLogMessage
          │                       │                        │
          │                       │                        │
┌─────────┴───────────────────────┴────────────────────────┴──────────────┐
│                        EXECUTION REGISTRY                               │
│                                                                         │
│  registry: Map<executionId, ExecutionHandle>                            │
│  changeCallbacks: Map<executionId, callbacks[]>                         │
│                                                                         │
│  ┌──────────────────────┐      ┌──────────────────────┐                 │
│  │ AgentExecutionHandle │      │ AgentExecutionHandle │                 │
│  │ id: exec1            │      │ id: exec2            │                 │
│  │ parent: stream-A     │      │ parent: stream-A     │                 │
│  │ child:  stream-A     │      │ child:  stream-B     │ ◄── subagent   │
│  │ agent:  "orchestrator"│      │ agent:  "correct"    │                 │
│  │ category: toolUse    │      │ category: workflow   │                 │
│  │ progress: n/a        │      │ progress: 2/5        │                 │
│  └──────────────────────┘      └──────────────────────┘                 │
│                                         │                               │
│               trackExecution()  ←───────┘                               │
│               untrackExecution() ───────► notifyWaiters()               │
│               updateExecutionProgress() ─► notifyWaiters()              │
└─────────────────────────────────────────────────────────────────────────┘
          │                                         ▲
          │                                         │
          │  Orchestrator queries via                │  Subagent updates
          │  `executions` tool                      │  via runtime
          │                                         │
          ▼                                         │
┌─────────────────────────────────────────────────────────────────────────┐
│                     ORCHESTRATOR AGENT (stream-A)                        │
│                                                                         │
│  Tool-Use Flow Loop:                                                    │
│                                                                         │
│  ┌─────────────┐    ┌──────────────────┐    ┌───────────────────┐       │
│  │ PrepareNode │───►│  CycleNode       │───►│  WaitNode         │       │
│  └─────────────┘    │                  │    │                   │       │
│                     │  Model call ──►  │    │  Fires            │       │
│                     │  Tool calls:     │    │  onBeforeWaiting  │       │
│                     │  - delegate_*    │    │  if subagent mode │       │
│                     │  - executions    │    │                   │       │
│                     │  - accept_files  │    │  Waits on         │       │
│                     │                  │    │  FollowUpQueue    │       │
│                     └────────▲─────────┘    └─────────┬─────────┘       │
│                              │                        │                 │
│                              │    ┌───────────────────┘                 │
│                              │    │                                     │
│                              │    ▼                                     │
│                     ┌──────────────────────┐                            │
│                     │ ToolUseFollowUpQueue │                            │
│                     │ (stream-A)           │                            │
│                     │                      │                            │
│                     │  Queued messages:     │                            │
│                     │  - subagent results  │ ◄─── enqueue() from        │
│                     │  - bash bg results   │      onBeforeWaiting /     │
│                     │  - user follow-ups   │      onCompleted /         │
│                     │                      │      catch()               │
│                     └──────────────────────┘                            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
          │
          │  executeAgent(isSubagent: true)
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     SUBAGENT (stream-B)                                  │
│                                                                         │
│  ┌─ Workflow Agent ──────────────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │  Round 1/5          Round 2/5          ...          Round 5/5     │  │
│  │  ┌──────────────┐  ┌──────────────┐               ┌────────────┐ │  │
│  │  │PrepareContext │  │PrepareContext │               │OutputNode  │ │  │
│  │  │TeXCount      │  │TeXCount      │               │            │ │  │
│  │  │MediaExtract  │  │ResponseCycle │               │  Writes:   │ │  │
│  │  │ResponseCycle │  │OutputNode    │               │  - files   │ │  │
│  │  │OutputNode    │  │              │               │  - report  │ │  │
│  │  └──────────────┘  └──────────────┘               └────────────┘ │  │
│  │         │                  │                             │        │  │
│  │  updateExecution    updateExecution               onCompleted()  │  │
│  │  Progress(1/5)      Progress(2/5)                fires ─────────────► Queue
│  │                                                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ Tool-Use Agent ──────────────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │  CycleNode ──► CycleNode ──► CycleNode ──► WaitNode              │  │
│  │  (model call)  (model call)  (model call)  │                      │  │
│  │  (tool exec)   (tool exec)   (end turn)    │                      │  │
│  │                                             │                      │  │
│  │                                      onBeforeWaiting()            │  │
│  │                                      fires ───────────────────────────► Queue
│  │                                             │                      │  │
│  │                                      WAITING status               │  │
│  │                                                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  Persistent KV Store (per execution):                                   │
│  ┌────────────────────────────────────────────┐                         │
│  │ meta.json           - agent, model, status │                         │
│  │ config.json         - full agent config    │                         │
│  │ conversation.json   - message history      │ ◄── readable via       │
│  │ todos.json          - task checklist       │     executions tool     │
│  │ report.json         - result summary       │                         │
│  │ flow_{id}           - persisted flow state │                         │
│  │ child-{id}.json     - child records        │                         │
│  └────────────────────────────────────────────┘                         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Summary: Update Mechanisms Ranked by Usefulness

| Mechanism                           | Real-Time?                                   | Data Available                                   | Cost to Orchestrator                                |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| **FollowUpQueue delivery**          | Near-real-time (fires at completion/WAITING) | Final result (XML with outputs or last response) | Zero - delivered automatically as follow-up message |
| **FollowUpQueue progress** (NEW)    | Immediate                                    | Todos, round progress, tool count, files changed | Zero - delivered automatically                      |
| **`executions` with `action=wait`** | Efficient blocking                           | Status + progress + todos                        | One tool call per check (blocks efficiently)        |
| **`executions` with `action=view`** | Snapshot                                     | Status, progress, conversation, todos, files     | One tool call per check                             |
| **`executions/{id}/conversation`**  | Snapshot                                     | Full message history with tool calls             | One tool call (can be large)                        |
| **`executions/{id}/todos`**         | Snapshot                                     | Task checklist                                   | One tool call                                       |
| **Event bus**                       | True real-time                               | Everything                                       | Not available to orchestrator (UI only)             |

---

## Implementation: Pushed Progress Updates (NEW)

### What Changed

Subagents now proactively push intermediate progress to the orchestrator via the FollowUpQueue, using a new `onProgress` callback wired through the execution stack.

### Progress Update Types (Typed Internally)

```typescript
// Discriminated union — typed objects internally, XML at boundary
type SubagentProgressUpdate =
  | { kind: 'todos'; todos: TodoItem[] } // Todo list changed
  | {
      kind: 'round';
      currentRound: number; // Workflow round done
      totalRounds: number;
    }
  | {
      kind: 'overview';
      toolCallCount: number; // Activity summary
      filesChanged: string[];
    };
```

### XML Format at Boundary

```xml
<!-- Todo update -->
<subagent-progress id="abc123" agent="chat" type="todos"
    completed="2" active="1" pending="3">
  [x] Read the input file
  [x] Identify citation errors
  [>] Fix citations on slide 3
  [ ] Fix citations on slide 7
  [ ] Verify bibliography consistency
  [ ] Final review
</subagent-progress>

<!-- Round completion (workflow) -->
<subagent-progress id="def456" agent="correct" type="round"
    current="2" total="5" />

<!-- Overview (tool-use) -->
<subagent-progress id="abc123" agent="chat" type="overview"
    tool-calls="7" files-changed="slides/talk.tex, refs.bib" />
```

### Wiring Diagram

```
executeSubagent() ─── onProgress callback ──┐
        │                                                       │
        ▼                                                       │
executeAgent(options: { onProgress })                           │
        │                                                       │
        ├── Tool-Use path:                                      │
        │   runToolUseFlow(input: { onProgress })               │
        │     → ToolUseServices.onProgress                      │
        │       → ToolUseCycleNode.exec():                      │
        │           todos.setOnUpdate() → onProgress({todos})   │
        │       → ToolUseCycleNode.post():                      │
        │           onProgress({overview: toolCalls, files})     │
        │                                                       │
        └── Workflow path:                                      │
            createRoundProgressCallback(id, onProgress)         │
              → onRoundCompleted → onProgress({round})          │
                                                                │
                      formatSubagentProgress() ◄────────────────┘
                              │
                              ▼
                  ToolUseFollowUpQueue.enqueue()
                              │
                              ▼
                    Orchestrator receives as
                    user-role follow-up message
```

### Files Modified

| File                                                                | Change                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| `src/tools/delegation/subagentResults.ts`                           | New `SubagentProgressUpdate` types + `formatSubagentProgress()` |
| `src/tools/WorkflowTool.ts`                                         | `onProgress` callback in `executeSubagent()`                    |
| `src/agent/runtime/executeAgent.ts`                                 | `onProgress` in `ExecuteAgentOptions`, wired to both paths      |
| `src/agent/implementations/flows/tooluse/ToolUseServices.ts`        | `onProgress` field on services interface                        |
| `src/agent/implementations/flows/tooluse/runToolUseFlow.ts`         | `onProgress` on `RunToolUseFlowInput`                           |
| `src/agent/implementations/flows/tooluse/nodes/ToolUseCycleNode.ts` | Emit todos + overview via `onProgress`                          |

### Key Insight

The `executions` tool endpoints remain useful for deep inspection (full conversation, file contents, killing stuck processes), but the orchestrator no longer needs to spend tool calls just to learn that progress happened. The primary communication path is now:

1. **Launch** → immediate "Launched async" response
2. **Progress** → automatic `<subagent-progress>` messages via FollowUpQueue (NEW)
3. **Result** → automatic `<subagent-result>` message via FollowUpQueue (existing)
4. **Deep inspection** → `executions` tool (escape hatch, unchanged)
