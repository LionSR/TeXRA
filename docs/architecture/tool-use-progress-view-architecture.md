# Tool Use & Progress View Display Chain Architecture

> A Linus-style critical review of the data flow from tool invocation to user display.

## Executive Summary

The architecture follows a **Backend-Broadcast, Frontend-Decides** pattern with clear separation of concerns:

1. **Tool Use Layer**: PocketFlow-based execution with provider-abstracted model handlers
2. **Event Bus**: Buffered pub/sub for decoupled communication
3. **Progress View**: State managers + WebviewUpdater for VS Code webview rendering

The design is **sound** - no spaghetti state, clean abstractions, proper error boundaries. The main complexity is justified by multi-provider support and resumable sessions.

---

## High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TOOL USE EXECUTION LAYER                          │
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                  │
│  │ToolUseRunFlow│───▶│ToolUseCycle  │───▶│ToolUseCycle  │                  │
│  │   (outer)    │    │    Node      │    │    Flow      │                  │
│  └──────────────┘    └──────────────┘    └──────────────┘                  │
│         │                   │                   │                          │
│         ▼                   ▼                   ▼                          │
│  ┌─────────────────────────────────────────────────────────────┐           │
│  │                    PersistedFlow State                       │           │
│  │  • shared: Mutable state (messages, workspace, run state)   │           │
│  │  • services: Immutable deps (modelHandler, logger, config)   │           │
│  │  • Snapshots for resume capability                           │           │
│  └─────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ emits events
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EVENT BUS LAYER                                │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────┐           │
│  │                    ProgressEventBus                          │           │
│  │  • 23 event types (streams, logs, tasks, approvals...)       │           │
│  │  • Buffering: up to 1000 events if no listeners              │           │
│  │  • Replay on first subscriber attachment                     │           │
│  │  • AbortSignal support for cleanup                           │           │
│  └─────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ routes to handlers
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PROGRESS VIEW LAYER                                │
│                                                                             │
│  ┌────────────────────┐    ┌────────────────────┐                          │
│  │ProgressEventHandler│───▶│  ProgressViewState │                          │
│  │   (orchestrator)   │    │   (state managers) │                          │
│  └────────────────────┘    └────────────────────┘                          │
│            │                        │                                       │
│            ▼                        ▼                                       │
│  ┌────────────────────┐    ┌────────────────────┐                          │
│  │  Domain Handlers   │    │  WebviewUpdater    │                          │
│  │  • LogEventHandlers│───▶│  (postMessage)     │                          │
│  │  • TodoHandlers    │    └────────────────────┘                          │
│  │  • OutputHandlers  │             │                                       │
│  │  • UsageHandlers   │             │                                       │
│  └────────────────────┘             │                                       │
│                                     │                                       │
│                                     ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐           │
│  │                     Webview Frontend                         │           │
│  │  • Sidebar view + Panel view (dual synchronized)             │           │
│  │  • Frontend decides render based on active stream            │           │
│  │  • Sends actions back via postMessage                        │           │
│  └─────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Tool Use Flow Architecture

### PocketFlow Node Pattern

Every node follows a strict three-phase lifecycle:

```
┌─────────────────────────────────────────────────────────────┐
│                         NODE LIFECYCLE                       │
│                                                             │
│   prep(shared)          exec(prepRes)        post(shared,   │
│        │                     │              prepRes, execRes)│
│        │                     │                     │        │
│        ▼                     ▼                     ▼        │
│  ┌──────────┐         ┌──────────┐         ┌──────────┐    │
│  │ Extract  │         │  Pure    │         │ Write    │    │
│  │ from     │────────▶│ compute  │────────▶│ to       │    │
│  │ shared   │         │ (no side │         │ shared   │    │
│  │          │         │ effects) │         │          │    │
│  └──────────┘         └──────────┘         └──────────┘    │
│                             │                     │        │
│                             │                     ▼        │
│                       Retryable           Returns Action    │
│                       (maxRetries,        (DEFAULT, CONTINUE│
│                        wait config)        COMPLETE, etc.)  │
└─────────────────────────────────────────────────────────────┘
```

**Why this matters**: `exec()` is isolated and retryable because it can't touch `shared` directly. This enables clean error recovery and makes flows resumable.

### Tool Use Run Flow Structure

```
┌─────────────────────────────────────────────────────────────┐
│                      ToolUseRunFlow                          │
│                                                             │
│  ┌──────────────────┐                                       │
│  │ToolUsePrepareNode│  Initialize/resume session            │
│  │                  │  Load or create state snapshots       │
│  └────────┬─────────┘                                       │
│           │                                                 │
│           ▼                                                 │
│  ┌──────────────────┐                                       │
│  │ ToolUseCycleNode │  Runs ToolUseCycleFlow internally     │
│  │                  │  (nested flow execution)              │
│  └────────┬─────────┘                                       │
│           │                                                 │
│           ▼                                                 │
│  ┌──────────────────┐     ◀────── CONTINUE ─────┐          │
│  │ ToolUseWaitNode  │     Wait for follow-up    │          │
│  │                  │     or continue signal    │          │
│  └────────┬─────────┴───────────────────────────┘          │
│           │                                                 │
│           ▼ COMPLETE                                        │
│        [EXIT]                                               │
└─────────────────────────────────────────────────────────────┘
```

### Tool Use Cycle Flow (Nested)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ToolUseCycleFlow                                  │
│                                                                         │
│  ┌────────────────┐                                                     │
│  │ToolUsePrepNode │  Check interruption, reset cycle state              │
│  └───────┬────────┘                                                     │
│          │                                                              │
│          ▼                                                              │
│  ┌────────────────┐                                                     │
│  │ToolUseCallNode │  modelHandler.createResponse() with tools           │
│  │                │  Returns raw provider response                      │
│  └───────┬────────┘                                                     │
│          │                                                              │
│          ▼                                                              │
│  ┌────────────────┐                                                     │
│  │ToolUseProcess  │  extractToolUse() → SdkToolCall[]                   │
│  │     Node       │  extractResponse() → text, usage, stopReason       │
│  └───────┬────────┘                                                     │
│          │                                                              │
│          ▼                                                              │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │                    ToolUseDispatchNode                          │    │
│  │                                                                  │    │
│  │  for each SdkToolCall:                                          │    │
│  │    1. toolRegistry.get(call.name)                               │    │
│  │    2. parseToolInput(call.input)                                │    │
│  │    3. withToolFileInteractionContext(() => tool.call(input))    │    │
│  │    4. extractToolAttachments(result)                            │    │
│  │    5. createToolUseFollowUpMessages(...)                        │    │
│  │                                                                  │    │
│  │  Emits: updateTodos, tracks file interactions                   │    │
│  └───────┬────────────────────────────────────────────────────────┘    │
│          │                                                              │
│          ├──── CONTINUE (more tool calls) ──────▶ [loop to PrepNode]   │
│          │                                                              │
│          ▼ DEFAULT (endTurn = true)                                     │
│       [EXIT to parent flow]                                             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Model Handler Abstraction Layer

### Provider-Agnostic Tool Handling

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         IModelHandler Interface                          │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    extractToolUse(response)                      │   │
│  │                                                                   │   │
│  │   Anthropic  ────▶  content.filter(type === 'tool_use')          │   │
│  │   OpenAI     ────▶  choices[0].message.tool_calls                │   │
│  │   Google     ────▶  candidates[0].content.parts.functionCall     │   │
│  │                                                                   │   │
│  │   All return: SdkToolCall[] (discriminated by 'provider' field)  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │              createToolUseFollowUpMessages(...)                  │   │
│  │                                                                   │   │
│  │   Anthropic  ────▶  [assistant/tool_use, user/tool_result]      │   │
│  │                     + Files API upload for attachments           │   │
│  │                                                                   │   │
│  │   OpenAI     ────▶  [assistant/tool_calls, tool/content]        │   │
│  │                     (text summaries only, no inline attachments)│   │
│  │                                                                   │   │
│  │   Google     ────▶  [model/functionCall, user/functionResponse] │   │
│  │                     + inline media via FunctionResponsePart[]   │   │
│  │                     + batched calls preserve thoughtSignature    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### SdkToolCall Discriminated Union

```typescript
type SdkToolCall =
  | { provider: 'anthropic'; callId; name; input: ToolUseBlock['input']; raw }
  | { provider: 'openai';    callId; name; input: string (parsed); raw }
  | { provider: 'deepseek';  callId; name; input: unknown; raw }
  | { provider: 'google';    callId; name; input: args; raw; thoughtSignature? }
  | { provider: 'openai-response'; callId; name; input: unknown; raw }
```

**Usage**: `if (call.provider === 'anthropic') { ... }` for type narrowing.

---

## Event Bus Architecture

### Event Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          EVENT EMISSION POINTS                          │
│                                                                         │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐   │
│  │ ToolUseCycleNode  │  │  VSCodeTransport  │  │ StreamStatusSvc   │   │
│  │   updateTodos     │  │   addLogMessage   │  │ updateStreamStatus│   │
│  │                   │  │   addTaskGroup    │  │                   │   │
│  └─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘   │
│            │                      │                      │             │
│            └──────────────────────┼──────────────────────┘             │
│                                   │                                     │
│                                   ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      ProgressEventBus                            │   │
│  │                                                                   │   │
│  │   emit(event, payload)                                           │   │
│  │       │                                                           │   │
│  │       ├─── listeners exist? ───▶ emit immediately to all         │   │
│  │       │                                                           │   │
│  │       └─── no listeners? ──────▶ buffer (max 1000 events)        │   │
│  │                                       │                           │   │
│  │   on(event, handler, { signal })      │                           │   │
│  │       │                               │                           │   │
│  │       └─── replays buffered events ◀──┘                           │   │
│  │            of this type on first subscription                     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Event Categories

| Category | Events | Purpose |
|----------|--------|---------|
| **Stream Lifecycle** | `setActiveStream`, `updateStreamStatus`, `setTaskState` | Stream tab management |
| **Task Groups** | `addTaskGroup`, `updateTaskGroup` | Progress board runs |
| **Logging** | `addLogMessage`, `updateLogMessage` | Console output |
| **Output Files** | `addOutputFiles`, `updateMissingOutputs` | Result tracking |
| **Usage/Context** | `updateStreamUsage`, `updateContextState` | Token metrics |
| **Todos** | `updateTodos` | Task list state |
| **Approvals** | `showToolEditApprovalPrompt`, `resolveToolEditApprovalPrompt` | Edit confirmations |
| **Proposals** | `showAgentProposal`, `resolveAgentProposal` | Workflow suggestions |
| **Retry** | `showRetryRequest`, `resolveRetryRequest` | Error recovery |

---

## Progress View State Management

### State Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ProgressViewState                                 │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    PERSISTENT MANAGERS                           │   │
│  │         (Backed by VS Code workspace storage)                    │   │
│  │                                                                   │   │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐        │   │
│  │  │StreamTabsMgr  │  │TaskGroupMgr   │  │OutputFilesMgr │        │   │
│  │  │ LogMessage[]  │  │ TaskGroup[]   │  │ FileInfo[][]  │        │   │
│  │  │ per stream    │  │ per stream    │  │ by run/round  │        │   │
│  │  └───────────────┘  └───────────────┘  └───────────────┘        │   │
│  │                                                                   │   │
│  │  ┌───────────────┐  ┌───────────────┐                           │   │
│  │  │UsageStatsMgr  │  │RunInstructMgr │                           │   │
│  │  │ TokenUsage    │  │ Instructions  │                           │   │
│  │  │ by stream/run │  │ by stream/run │                           │   │
│  │  └───────────────┘  └───────────────┘                           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    EPHEMERAL SESSION STATE                       │   │
│  │            (Per-stream, cleared on stream close)                 │   │
│  │                                                                   │   │
│  │  • Hints (agentCategory, isRemote, hasMultipleOutputs)          │   │
│  │  • Todos (TodoItem[])                                           │   │
│  │  • ContextState (token utilization %)                           │   │
│  │  • ActiveRunId (for UI restoration)                             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                       UI STATE                                   │   │
│  │                                                                   │   │
│  │  • activeStream: StreamTabId | undefined                        │   │
│  │  • streamSortOrder: 'time' | ...                                │   │
│  │  • agentCategoryFilter: 'all' | 'workflow' | 'toolUse'         │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Event Handler Pipeline

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     ProgressEventHandler                                 │
│                                                                         │
│  setupEventListeners() creates modular handler registration:            │
│                                                                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │LogEventHandlers │  │TodoEventHandlers│  │OutputEventHndlrs│         │
│  │                 │  │                 │  │                 │         │
│  │ addLogMessage   │  │ updateTodos     │  │ addOutputFiles  │         │
│  │ updateLogMessage│  │                 │  │ updateMissing   │         │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘         │
│           │                    │                    │                   │
│           └────────────────────┼────────────────────┘                   │
│                                │                                        │
│                                ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    EventHandlerContext                           │   │
│  │                                                                   │   │
│  │  • state: ProgressViewState                                      │   │
│  │  • webviewUpdater: WebviewUpdater                                │   │
│  │                                                                   │   │
│  │  Helper functions:                                               │   │
│  │  • isWebviewAvailable() - any webview ready?                     │   │
│  │  • isActiveStream(s) - is this the displayed stream?             │   │
│  │  • canUpdateWebview(s) - both conditions met?                    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Webview Communication Protocol

### Message Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    BACKEND → FRONTEND (WebviewUpdater)                  │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  sendMessage(message)                                            │   │
│  │       │                                                           │   │
│  │       ├───▶ Sidebar webview.postMessage(message)                 │   │
│  │       │                                                           │   │
│  │       └───▶ Panel webview.postMessage(message)                   │   │
│  │             (dual synchronized views)                             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  Command Types:                                                         │
│  • UPDATE_STREAMS, UPDATE_LOGS, APPEND_LOG, UPDATE_LOG                 │
│  • UPDATE_FILES, UPDATE_MISSING_OUTPUTS, UPDATE_RUN_USAGE              │
│  • ADD_TASK_GROUP, UPDATE_TASK_GROUP, UPDATE_TODOS                     │
│  • SHOW_TOOL_EDIT_APPROVAL, SHOW_RETRY_REQUEST, SHOW_AGENT_PROPOSAL    │
│  • THEME_SET, UPDATE_CONTEXT_STATE, UPDATE_INSTRUCTION                 │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                    FRONTEND → BACKEND (MessageHandler)                  │
│                                                                         │
│  webview.onDidReceiveMessage(message) →                                │
│                                                                         │
│  Stream Actions:                                                        │
│  • switchStream, deleteStream, stopStream, resume, runNew              │
│                                                                         │
│  Approval Actions (Zod validated):                                     │
│  • toolEditApprovalAction: { requestId, action: 'approve'|'reject' }   │
│  • agentProposalAction: { proposalId, action, feedback? }              │
│                                                                         │
│  File Operations:                                                       │
│  • openFile, compareOriginal, comparePrevious, acceptFile              │
│                                                                         │
│  Follow-Up:                                                             │
│  • sendFollowUp, polishFollowUp, startRecording, stopRecording         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Approval Flow Sequence

```
┌───────────┐     ┌───────────┐     ┌───────────┐     ┌───────────┐
│Tool Edit  │     │ProgressEvt│     │Webview    │     │ Frontend  │
│Coordinator│     │  Handler  │     │ Updater   │     │           │
└─────┬─────┘     └─────┬─────┘     └─────┬─────┘     └─────┬─────┘
      │                 │                 │                 │
      │ showToolEditApprovalPrompt       │                 │
      │────────────────▶│                 │                 │
      │                 │                 │                 │
      │                 │ store in        │                 │
      │                 │ pendingPrompts  │                 │
      │                 │                 │                 │
      │                 │ showToolEdit    │                 │
      │                 │ ApprovalPrompt()│                 │
      │                 │────────────────▶│                 │
      │                 │                 │                 │
      │                 │                 │ postMessage     │
      │                 │                 │ (SHOW_TOOL_     │
      │                 │                 │  EDIT_APPROVAL) │
      │                 │                 │────────────────▶│
      │                 │                 │                 │
      │                 │                 │                 │ User clicks
      │                 │                 │                 │ approve/reject
      │                 │                 │                 │
      │                 │                 │ toolEditApproval│
      │                 │                 │◀────────────────│
      │                 │                 │ Action message  │
      │                 │                 │                 │
      │                 │◀────────────────│                 │
      │                 │                 │                 │
      │ resolveRequest()│                 │                 │
      │◀────────────────│                 │                 │
      │                 │                 │                 │
      │ Promise resolves│                 │                 │
      │ (tool continues)│                 │                 │
      │                 │                 │                 │
```

---

## Critical Design Patterns

### 1. Backend Broadcasts, Frontend Decides

```
Backend:  Sends ALL events regardless of active stream
          (supports future concurrent sub-agents)

Frontend: Compares message.stream vs lastRenderedStream
          Decides whether to render or ignore
          Single source of truth for render state
```

### 2. Flat State Architecture (No Wrappers)

```typescript
// ❌ Anti-pattern: Wrapper classes
class AgentSharedStore {
  private run: AgentRunState;
  private workspace: AgentWorkspaceState;
}

// ✅ TeXRA pattern: Flat state slices
interface CycleStateSlices {
  readonly run: AgentRunState;           // Direct reference
  readonly workspace: AgentWorkspaceState;
}
// Passed directly through services, mutated in-place
```

### 3. Single Source of Truth via Zod Schemas

```typescript
// Schema defines structure
const ToolResultSchema = z.object({
  output: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  isError: z.boolean().optional(),
  files: z.array(ToolFileAttachmentSchema).optional(),
  edits: z.array(EditRecordSchema).optional(),
});

// Type derived from schema
type ToolResult = z.infer<typeof ToolResultSchema>;
```

### 4. Buffering with Replay

```
Startup Race Condition:
  Agent emits events ──▶ No listeners yet ──▶ Events lost?

Solution:
  1. ProgressEventBus buffers events (max 1000)
  2. First subscriber triggers replay of buffered events
  3. No events lost during initialization
```

### 5. PersistedFlow for Resumability

```
Normal execution:
  step → persist shared → step → persist → step → complete

Resume from crash:
  Load persisted shared state
  Navigate node graph using stored actions
  Continue from last completed node
```

---

## File Reference Map

### Tool Use Layer
| File | Purpose |
|------|---------|
| `src/tools/core/base.ts` | BaseTool abstract class with Zod validation |
| `src/tools/core/define.ts` | `defineTool()` factory |
| `src/tools/registry.ts` | Tool registry singleton (40+ tools) |
| `src/tools/result.ts` | ToolResult, ToolFileAttachment schemas |
| `src/agent/core/ToolTypes.ts` | ITool, IToolRegistry interfaces |

### Flow Layer
| File | Purpose |
|------|---------|
| `src/agent/node/persisted-flow.ts` | PersistedFlow for resumable execution |
| `src/agent/implementations/flows/ToolUseRunFlow.ts` | Outer flow (prepare→cycle→wait) |
| `src/agent/core/flows/ToolUseCycleFlow.ts` | Inner cycle (call→process→dispatch) |
| `src/agent/core/flows/FlowTransitions.ts` | Action constants |

### Model Handler Layer
| File | Purpose |
|------|---------|
| `src/agent/modelHandlers/types/IModelHandler.ts` | Interface, SdkToolCall union |
| `src/agent/modelHandlers/modelHandlerAnthropic.ts` | Anthropic implementation |
| `src/agent/modelHandlers/modelHandlerOpenAI.ts` | OpenAI/DeepSeek implementation |
| `src/agent/modelHandlers/modelHandlerGoogleGenAI.ts` | Google implementation |

### Event Bus Layer
| File | Purpose |
|------|---------|
| `src/eventBus/ProgressEventBus.ts` | Event bus with buffering |
| `src/eventBus/schemas.ts` | Zod schemas for payloads |
| `src/eventBus/types.ts` | Type definitions |

### Progress View Layer
| File | Purpose |
|------|---------|
| `src/progressView/state/ProgressViewState.ts` | Consolidated state |
| `src/progressView/events/ProgressEventHandler.ts` | Event orchestrator |
| `src/progressView/managers/WebviewUpdater.ts` | Backend→frontend messages |
| `src/progressView/ProgressViewProvider.ts` | VS Code webview provider |
| `src/progressView/ProgressViewMessageHandler.ts` | Frontend→backend messages |

---

## Assessment

### Strengths

1. **Clean abstractions**: Model handler interface properly isolates provider differences
2. **Resumability**: PersistedFlow enables crash recovery without re-execution
3. **Type safety**: Zod schemas as single source of truth, discriminated unions for providers
4. **Decoupling**: Event bus separates execution from display completely
5. **Dual view support**: Sidebar + panel webviews stay synchronized

### Potential Concerns

1. **Buffer size**: 1000 events may not be enough for long-running agents with verbose logging
2. **Replay complexity**: Buffered events replay in order of subscription, not emission (minor issue)
3. **State snapshot size**: Large conversation histories may bloat PersistedFlow storage

### Verdict

The architecture is **well-designed** for its requirements. The complexity is justified by:
- Multi-provider AI support
- Resumable long-running operations
- Real-time progress display
- VS Code webview limitations

No fundamental architectural issues detected. The code follows its own documented patterns consistently.
