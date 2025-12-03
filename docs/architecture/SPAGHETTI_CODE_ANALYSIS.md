# TeXRA Round-Trip Spaghetti Code Analysis

This document identifies architectural issues in the TeXRA codebase including circular dependencies, ping-pong call patterns, tangled event flows, and mixed concerns. It also proposes cleaner designs.

## Executive Summary

**Critical Issues Found:**
- **23 circular dependency cycles** across 40+ files
- **6 major ping-pong call patterns** creating complex control flows
- **9+ deep callback chains** (4+ levels of nesting)
- **6 tangled event flow chains** triggering cascading side effects
- **18 files with mixed concerns** (UI + business logic + data access)
- **6 bidirectional data flow patterns** causing state confusion

---

## 1. Circular Dependencies

### 1.1 Current Architecture - Dependency Tangles

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CRITICAL CIRCULAR DEPENDENCY CHAINS                       │
└─────────────────────────────────────────────────────────────────────────────┘

  CHAIN A: Logger/EventBus/Utils/Files/Common (10+ files)
  ═══════════════════════════════════════════════════════

    ┌──────────────────┐
    │ common/errors/   │
    │ index.ts         │───────────────────────────────────────────────┐
    └────────┬─────────┘                                               │
             │ imports                                                 │
             ▼                                                         │
    ┌──────────────────┐                                               │
    │ errorHandling    │                                               │
    │ Utils.ts         │                                               │
    └────────┬─────────┘                                               │
             │ imports @logger/logUtils                                │
             ▼                                                         │
    ┌──────────────────┐                                               │
    │ logger/          │                                               │
    │ logUtils.ts      │                                               │
    └────────┬─────────┘                                               │
             │ imports LogChannelRegistry                              │
             ▼                                                         │
    ┌──────────────────┐                                               │
    │ LogChannel       │                                               │
    │ Registry.ts      │                                               │
    └────────┬─────────┘                                               │
             │ imports ProgressViewSink                                │
             ▼                                                         │
    ┌──────────────────┐                                               │
    │ sinks/           │                                               │
    │ ProgressViewSink │                                               │
    └────────┬─────────┘                                               │
             │ imports @eventBus/ProgressEventBus                      │
             ▼                                                         │
    ┌──────────────────┐                                               │
    │ eventBus/        │                                               │
    │ ProgressEventBus │                                               │
    └────────┬─────────┘                                               │
             │ imports @agent/output/types                             │
             ▼                                                         │
    ┌──────────────────┐                                               │
    │ agent/output/    │                                               │
    │ types.ts         │                                               │
    └────────┬─────────┘                                               │
             │ imports @utils/files                                    │
             ▼                                                         │
    ┌──────────────────┐                                               │
    │ utils/files/     │                                               │
    │ taskRunStorage   │                                               │
    └────────┬─────────┘                                               │
             │ imports @common/errors                                  │
             ▼                                                         │
             └─────────────────────────────────────────────────────────┘
                                    CYCLE CLOSES!


  CHAIN B: BaseToolUseAgent Complex (3 interlocking cycles)
  ══════════════════════════════════════════════════════════

         ┌───────────────────────────────────────────────────────┐
         │                                                       │
         ▼                                                       │
    ┌──────────────────┐      imports      ┌──────────────────┐  │
    │ BaseToolUseAgent ├──────────────────►│ ToolUseSession   │  │
    │ .ts              │                   │ Persistence.ts   │  │
    └────────┬─────────┘                   └────────┬─────────┘  │
             │                                      │            │
             │ imports                              │ imports    │
             ▼                                      │            │
    ┌──────────────────┐                            │            │
    │ ToolUseSession   │◄───────────────────────────┘            │
    │ Lifecycle.ts     │                                         │
    └────────┬─────────┘                                         │
             │ imports type { BaseToolUseAgent }                 │
             └───────────────────────────────────────────────────┘


  CHAIN C: ProgressView Manager/State Cycle
  ══════════════════════════════════════════

    ┌──────────────────┐
    │ managers/        │
    │ index.ts         │
    └────────┬─────────┘
             │ exports WebviewUpdater
             ▼
    ┌──────────────────┐        imports        ┌──────────────────┐
    │ WebviewUpdater   │◄──────────────────────│ ProgressView     │
    │ .ts              │                       │ State.ts         │
    └────────┬─────────┘                       └────────▲─────────┘
             │                                          │
             │ imports ProgressViewState                │
             └──────────────────────────────────────────┘


  CHAIN D: Agent Registry Cycles
  ════════════════════════════════

    ┌──────────────────┐                    ┌──────────────────┐
    │ agent/index/     │    imports         │ RemoteAgent      │
    │ agentRegistry.ts ├───────────────────►│ Loader.ts        │
    └────────▲─────────┘                    └────────┬─────────┘
             │                                       │
             │ imports isMultipleVariant             │
             └───────────────────────────────────────┘

             AND

    ┌──────────────────┐                    ┌──────────────────┐
    │ agentRegistry.ts │    imports         │ AgentDirectory   │
    │                  ├───────────────────►│ Manager.ts       │
    └────────▲─────────┘                    └────────┬─────────┘
             │                                       │
             │ imports type { AgentSource }          │
             └───────────────────────────────────────┘
```

### 1.2 Proposed Design - Breaking Cycles

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      PROPOSED: LAYERED ARCHITECTURE                          │
└─────────────────────────────────────────────────────────────────────────────┘

  Layer 0: Pure Types (no dependencies)
  ══════════════════════════════════════
    ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
    │ AgentTypes  │  │ FileTypes   │  │ EventTypes  │  │ ErrorTypes  │
    │ .ts         │  │ .ts         │  │ .ts         │  │ .ts         │
    └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘
           │                │                │                │
           └────────────────┴────────────────┴────────────────┘
                                    │
                                    ▼
  Layer 1: Core Utilities (depend only on types)
  ════════════════════════════════════════════════
    ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
    │ FileSystem  │  │ Logger      │  │ Config      │
    │ Utils       │  │ Core        │  │ Reader      │
    └─────────────┘  └─────────────┘  └─────────────┘
           │                │                │
           └────────────────┴────────────────┘
                            │
                            ▼
  Layer 2: Domain Services (depend on Layer 1)
  ═════════════════════════════════════════════
    ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
    │ AgentCore   │  │ EventBus    │  │ Storage     │
    │ Service     │  │ Service     │  │ Service     │
    └─────────────┘  └─────────────┘  └─────────────┘
           │                │                │
           └────────────────┴────────────────┘
                            │
                            ▼
  Layer 3: Orchestration (depend on Layer 2)
  ════════════════════════════════════════════
    ┌─────────────────────────────────────────────────────────────┐
    │                    AgentRuntime                              │
    │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
    │  │ Lifecycle   │  │ Persistence │  │ Registry    │          │
    │  │ Manager     │  │ Manager     │  │ Manager     │          │
    │  └─────────────┘  └─────────────┘  └─────────────┘          │
    └─────────────────────────────────────────────────────────────┘
                            │
                            ▼
  Layer 4: UI/Commands (depend on Layer 3)
  ═════════════════════════════════════════
    ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
    │ Commands    │  │ Webview     │  │ Progress    │
    │             │  │ Handlers    │  │ View        │
    └─────────────┘  └─────────────┘  └─────────────┘


  KEY PRINCIPLE: Dependencies flow DOWN only, never UP or SIDEWAYS
  ═══════════════════════════════════════════════════════════════════
```

---

## 2. Ping-Pong Call Patterns

### 2.1 Current Architecture - Tool Approval Round-Trip

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              CURRENT: TOOL EDIT APPROVAL PING-PONG FLOW                      │
└─────────────────────────────────────────────────────────────────────────────┘

  WriteTool.ts ───────────────────────────────────────────────────────────────►
       │                                                                       │
       │ 1. requestToolEditApproval(request)                                   │
       ▼                                                                       │
  toolEditApproval.ts ◄───────────────────────────────────────────────────────┐
       │                                                                       │
       │ 2. Creates Promise, stores in pendingApprovals Map                    │
       │                                                                       │
       │ 3. bus.emit('showToolEditApprovalPrompt', payload)                    │
       ▼                                                                       │
  ProgressEventBus ────────────────────────────────────────────────────────►   │
       │                                                                       │
       │ 4. Routes event to registered handlers                                │
       ▼                                                                       │
  ApprovalEvents.ts ────────────────────────────────────────────────────────►  │
       │                                                                       │
       │ 5. shared.showToolEditApprovalPrompt(payload)                         │
       ▼                                                                       │
  ProgressViewProvider.ts ─────────────────────────────────────────────────►   │
       │                                                                       │
       │ 6. Queues UI update, posts to webview                                 │
       ▼                                                                       │
  ProgressView Webview ────────────────────────────────────────────────────►   │
       │                                                                       │
       │ 7. User clicks Approve/Reject                                         │
       │                                                                       │
       │ 8. postMessage({ command: 'approvalAction', ... })                    │
       ▼                                                                       │
  ProgressViewMessageHandler.ts ───────────────────────────────────────────►   │
       │                                                                       │
       │ 9. handleProgressViewToolEditApprovalAction(payload)                  │
       ▼                                                                       │
  toolEditApproval.ts ◄────────────────────────────────────────────────────────┘
       │
       │ 10. entry.settle(result) - Resolves the Promise from step 2
       ▼
  WriteTool.ts (Original caller receives result)
       │
       │ 11. Continues with approved/rejected edit
       ▼

  TOTAL ROUND-TRIPS: 6 module boundaries
  TOTAL EVENT HOPS: 3 (bus emit → handler → provider → webview → message → resolve)
```

### 2.2 Proposed Design - Simplified Approval Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              PROPOSED: STREAMLINED APPROVAL ARCHITECTURE                     │
└─────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────────────────────┐
                    │         ApprovalService             │
                    │  (Single source of truth)           │
                    │                                     │
                    │  • Manages pending requests         │
                    │  • Handles all state transitions    │
                    │  • Exposes simple async API         │
                    └───────────────┬─────────────────────┘
                                    │
           ┌────────────────────────┼────────────────────────┐
           │                        │                        │
           ▼                        ▼                        ▼
    ┌─────────────┐          ┌─────────────┐          ┌─────────────┐
    │   Tools     │          │  UI Bridge  │          │  Commands   │
    │             │          │  (1-way)    │          │             │
    │ await       │          │             │          │ trigger     │
    │ approval    │          │ Receives    │          │ approval    │
    │ Service.    │          │ updates,    │          │ via service │
    │ request()   │          │ sends user  │          │             │
    │             │          │ actions     │          │             │
    └─────────────┘          └─────────────┘          └─────────────┘

  SIMPLIFIED FLOW:
  ═══════════════

    Tool ──► ApprovalService.request(edit) ──► Returns Promise
                       │
                       │ (internally)
                       ▼
              ┌─────────────────┐
              │ 1. Store request│
              │ 2. Notify UI    │◄──────── UIBridge receives
              │ 3. Wait         │          user action
              │ 4. Resolve      │
              └─────────────────┘
                       │
                       ▼
                  Tool receives result

  BENEFITS:
  • Single module owns all approval state
  • No event bus for request/response (only for UI updates)
  • UI Bridge is purely reactive (no callbacks to service)
  • Clear async boundary with Promise
```

---

## 3. Deep Callback Chains

### 3.1 Current Architecture - Nested Async Hell

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              CURRENT: executeAgent.ts NESTING (Lines 394-504)                │
└─────────────────────────────────────────────────────────────────────────────┘

  await logger.withScope('Task: ${agentName}', async () => {          ◄─ LEVEL 1
    │
    │  try {
    │    │
    │    await logger.withScope('Task Details', async () => {         ◄─ LEVEL 2
    │      │
    │      │  // 70+ lines of initialization logic
    │      │
    │      │  if (!isResume) {
    │      │    │
    │      │    if (!runStorage.isViewVisible()) {
    │      │      │
    │      │      await vscode.commands.executeCommand(...)           ◄─ LEVEL 3
    │      │      │
    │      │      if (!runStorage.isViewVisible()) {
    │      │        │
    │      │        vscode.window.showInformationMessage(...)
    │      │          .then((selection) => {                          ◄─ LEVEL 4
    │      │            │
    │      │            if (selection === 'Show ProgressBoard') {
    │      │              vscode.commands.executeCommand(...)         ◄─ LEVEL 5
    │      │            }
    │      │          });
    │      │      }
    │      │    }
    │      │  }
    │      │
    │    }, { skip: isResume });
    │
    │  } catch (err) {
    │    // Error handling with more nested logger calls
    │  }
    │
    │  try {
    │    await agent.run();                                           ◄─ LEVEL 2
    │  } catch (err) {
    │    // More error handling
    │  }
    │
  }, { skip: isResume });

  PROBLEMS:
  • 5 levels of nesting
  • Mixed async/await and .then() callbacks
  • Multiple try/catch at different levels
  • Hard to trace all execution paths
  • Logging scope intertwined with business logic
```

### 3.2 Proposed Design - Flat Async Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              PROPOSED: FLAT PIPELINE ARCHITECTURE                            │
└─────────────────────────────────────────────────────────────────────────────┘

  // Pipeline of discrete, testable steps

  async function executeAgent(config: AgentConfig): Promise<void> {
    const context = await initializeContext(config);      // Step 1

    await ensureViewVisible(context);                     // Step 2

    await prepareAgent(context);                          // Step 3

    await runAgentWithLogging(context);                   // Step 4

    await finalizeExecution(context);                     // Step 5
  }


  // Each step is flat and focused:

  ┌─────────────────────────────────────────────────────────────────────┐
  │  async function ensureViewVisible(ctx: Context): Promise<void> {   │
  │    if (ctx.isResume) return;                                       │
  │    if (ctx.runStorage.isViewVisible()) return;                     │
  │                                                                     │
  │    await vscode.commands.executeCommand('texra.progress.show');    │
  │                                                                     │
  │    if (!ctx.runStorage.isViewVisible()) {                          │
  │      await promptShowProgressBoard();  // Separate helper          │
  │    }                                                                │
  │  }                                                                  │
  └─────────────────────────────────────────────────────────────────────┘

  BENEFITS:
  • Maximum 2 levels of nesting
  • Each step is independently testable
  • Clear linear flow
  • Logging is a cross-cutting concern handled by decorator/wrapper
  • Error handling at pipeline level, not scattered throughout
```

---

## 4. Tangled Event Flows

### 4.1 Current Architecture - Event Cascades

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              CURRENT: RETRY REQUEST EVENT CASCADE                            │
└─────────────────────────────────────────────────────────────────────────────┘

  Agent needs retry
       │
       ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │                     RetryRequestCoordinator                          │
  │                                                                      │
  │   waitForUserAction()                                                │
  │         │                                                            │
  │         ├──► emit('updateStreamStatus', { status: 'waiting' })       │
  │         │         │                                                  │
  │         │         └──► StreamStatusEvents handles ──► UI updates     │
  │         │                                                            │
  │         ├──► emit('showRetryRequest', payload)                       │
  │         │         │                                                  │
  │         │         └──► RetryEvents handles ──► Provider callback     │
  │         │                      │                                     │
  │         │                      └──► Webview shows prompt             │
  │         │                                                            │
  │         └──► Await Promise (blocked)                                 │
  │                                                                      │
  └─────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ User clicks Retry
                                    ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │                  ProgressViewMessageHandler                          │
  │                                                                      │
  │   handleRetryAction()                                                │
  │         │                                                            │
  │         └──► retryCoordinator.triggerRetry(stream)                   │
  │                      │                                               │
  │                      ├──► emit('resolveRetryRequest', ...)           │
  │                      │                                               │
  │                      └──► emit('updateStreamStatus', 'resuming')     │
  │                                                                      │
  └─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │            Original Promise Resolves                                 │
  │                                                                      │
  │   Agent continues execution...                                       │
  └─────────────────────────────────────────────────────────────────────┘


  EVENT COUNT: 4 distinct events for one user action
  IMPLICIT ORDERING: Events must arrive in specific sequence
  HIDDEN STATE: Generation numbers track stale requests
```

### 4.2 Proposed Design - Command Pattern

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              PROPOSED: COMMAND-BASED COORDINATION                            │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────┐
  │                       RetryService                                   │
  │                                                                      │
  │  State: Map<streamId, RetryRequest>                                  │
  │                                                                      │
  │  async requestRetry(stream, reason): Promise<RetryResult>            │
  │    │                                                                 │
  │    ├─► Create request with unique ID                                 │
  │    ├─► Store in pending map                                          │
  │    ├─► Notify UI via single channel: ui.showRetry(request)           │
  │    └─► Return Promise that resolves on user action                   │
  │                                                                      │
  │  resolveRetry(requestId, action): void                               │
  │    │                                                                 │
  │    ├─► Validate request exists and is current                        │
  │    ├─► Remove from pending                                           │
  │    └─► Resolve associated Promise                                    │
  │                                                                      │
  └─────────────────────────────────────────────────────────────────────┘
                         │                           ▲
                         │ Single notification       │ Single action
                         ▼                           │
  ┌─────────────────────────────────────────────────────────────────────┐
  │                        UIController                                  │
  │                                                                      │
  │  • Receives showRetry(request) - updates UI                          │
  │  • User clicks → calls retryService.resolveRetry(id, action)         │
  │  • No events, just method calls                                      │
  │                                                                      │
  └─────────────────────────────────────────────────────────────────────┘


  BENEFITS:
  • Single service owns retry state
  • No event cascades - just method calls
  • UI is purely reactive
  • Clear request/response pattern
  • Easy to test in isolation
```

---

## 5. Mixed Concerns

### 5.1 Current Architecture - God Classes

```
┌─────────────────────────────────────────────────────────────────────────────┐
│         CURRENT: MainViewMessageHandler.ts (350+ lines, 15+ concerns)        │
└─────────────────────────────────────────────────────────────────────────────┘

  class MainViewMessageHandler {
    │
    ├── UI Concerns ─────────────────────────────────────────────────────────┐
    │   • Banner display                                                     │
    │   • Theme management                                                   │
    │   • Debug mode toggle                                                  │
    │   • Webview messaging                                                  │
    │                                                                        │
    ├── Business Logic ──────────────────────────────────────────────────────┤
    │   • Agent configuration composition                                    │
    │   • File selection logic                                               │
    │   • Dependency checking                                                │
    │   • Model options computation                                          │
    │                                                                        │
    ├── Data Access ─────────────────────────────────────────────────────────┤
    │   • SecretManager.anyApiKeyExists()                                    │
    │   • Configuration reading                                              │
    │   • File system operations                                             │
    │                                                                        │
    ├── Command Orchestration ───────────────────────────────────────────────┤
    │   • vscode.commands.executeCommand(...)                                │
    │   • Recording management                                               │
    │   • Merge operations                                                   │
    │                                                                        │
    └── Error Handling ──────────────────────────────────────────────────────┘
        • showLoggedErrorMessage()
        • Error dialogs with documentation links


  RESULT: Single file that knows about everything
  TESTING: Requires mocking 10+ dependencies
  CHANGES: Any change risks breaking unrelated functionality
```

### 5.2 Proposed Design - Separation of Concerns

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              PROPOSED: LAYERED MESSAGE HANDLING                              │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────┐
  │  Layer 4: MainViewMessageRouter (UI Layer - thin)                   │
  │                                                                      │
  │  • Routes messages to appropriate handlers                           │
  │  • No business logic                                                 │
  │  • Only knows about message types and handler registry               │
  │                                                                      │
  │  handleMessage(msg) {                                                │
  │    const handler = this.handlers.get(msg.command);                   │
  │    return handler.handle(msg, this.webview);                         │
  │  }                                                                   │
  └─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Layer 3: Feature Handlers (Orchestration)                          │
  │                                                                      │
  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
  │  │ Execution   │  │ File        │  │ Settings    │                  │
  │  │ Handler     │  │ Handler     │  │ Handler     │                  │
  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                  │
  │         │                │                │                          │
  │  • Validates input       │         • Reads config                    │
  │  • Calls services        │         • Updates config                  │
  │  • Returns result        │         • Notifies UI                     │
  └─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Layer 2: Domain Services (Business Logic)                          │
  │                                                                      │
  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
  │  │ AgentConfig │  │ FileListing │  │ Dependency  │                  │
  │  │ Service     │  │ Service     │  │ Checker     │                  │
  │  └─────────────┘  └─────────────┘  └─────────────┘                  │
  │                                                                      │
  │  • Pure business logic                                               │
  │  • No UI dependencies                                                │
  │  • Testable in isolation                                             │
  └─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Layer 1: Data Access (Infrastructure)                              │
  │                                                                      │
  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
  │  │ Secret      │  │ Config      │  │ FileSystem  │                  │
  │  │ Store       │  │ Store       │  │ Access      │                  │
  │  └─────────────┘  └─────────────┘  └─────────────┘                  │
  └─────────────────────────────────────────────────────────────────────┘


  BENEFITS:
  • Each layer has single responsibility
  • Dependencies flow downward only
  • Each component testable in isolation
  • Changes isolated to relevant layer
```

---

## 6. Bidirectional Data Flow

### 6.1 Current Architecture - State Confusion

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              CURRENT: TOOL CONTEXT BIDIRECTIONAL FLOW                        │
└─────────────────────────────────────────────────────────────────────────────┘

                         ┌─────────────────────────────┐
                         │   Global Context Stacks     │
                         │                             │
                         │  fileInteractionStack: []   │
                         │  approvalContextStack: []   │
                         └─────────────────────────────┘
                                ▲           │
                                │           │
                    push/pop    │           │  getCurrentContext()
                                │           │
          ┌─────────────────────┴───────────┴─────────────────────┐
          │                                                        │
          │                                                        │
    ┌─────┴─────┐                                            ┌─────┴─────┐
    │           │                                            │           │
    │  Flow     │  ◄──── Wraps tool execution ────►          │   Tools   │
    │  Runners  │       in context wrappers                  │           │
    │           │                                            │           │
    └─────┬─────┘                                            └─────┬─────┘
          │                                                        │
          │ withToolFileInteractionContext(                        │
          │   tracker,                                             │
          │   async () => {                                        │
          │     // Tool reads from context                         │
          │     const ctx = getCurrentContext();   ◄───────────────┤
          │     // Tool modifies tracker                           │
          │     ctx.tracker.recordEdits(...);      ────────────────►
          │   }                                                    │
          │ )                                                      │
          │                                                        │
          ▼                                                        ▼

  PROBLEMS:
  • Tools implicitly depend on global state
  • Same object is read AND written
  • Hard to trace data flow through context stack
  • Testing requires setting up global state
  • Race conditions possible with async tools
```

### 6.2 Proposed Design - Unidirectional Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              PROPOSED: UNIDIRECTIONAL DATA FLOW                              │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────┐
  │                         ToolRunner                                   │
  │                                                                      │
  │  async runTool(tool: Tool, input: Input): ToolResult {               │
  │    │                                                                 │
  │    │  // Create fresh, immutable context for this run                │
  │    │  const context = ToolContext.create({                           │
  │    │    approvalMode: this.config.approvalMode,                      │
  │    │    workspace: this.workspace.snapshot(),  // Immutable copy     │
  │    │  });                                                            │
  │    │                                                                 │
  │    │  // Tool receives context, returns result                       │
  │    │  const result = await tool.execute(input, context);             │
  │    │       │                                                         │
  │    │       │  ┌─────────────────────────────────────────────┐       │
  │    │       │  │  Tool Implementation                        │       │
  │    │       │  │                                             │       │
  │    │       │  │  execute(input, ctx): ToolResult {          │       │
  │    │       │  │    // Read from context (immutable)         │       │
  │    │       │  │    const mode = ctx.approvalMode;           │       │
  │    │       │  │                                             │       │
  │    │       │  │    // Return changes, don't mutate          │       │
  │    │       │  │    return {                                 │       │
  │    │       │  │      edits: [...],                          │       │
  │    │       │  │      files: [...],                          │       │
  │    │       │  │    };                                       │       │
  │    │       │  │  }                                          │       │
  │    │       │  └─────────────────────────────────────────────┘       │
  │    │       │                                                         │
  │    │       ▼                                                         │
  │    │  // Runner applies changes to workspace                         │
  │    │  this.workspace.applyEdits(result.edits);                       │
  │    │  this.workspace.addFiles(result.files);                         │
  │    │                                                                 │
  │    │  return result;                                                 │
  │  }                                                                   │
  └─────────────────────────────────────────────────────────────────────┘


  DATA FLOW:

    Config ──► ToolRunner ──► Tool (pure function) ──► Result ──► Workspace
                   │                                       │
                   │         (no back-references)          │
                   │                                       │
                   └───────────────────────────────────────┘
                              Apply changes


  BENEFITS:
  • Tools are pure functions (input → output)
  • No hidden dependencies on global state
  • Changes are explicit in return values
  • Easy to test: just pass input, check output
  • No race conditions: each run has isolated context
```

---

## 7. Summary of Refactoring Priorities

### High Priority (Architectural)

| Issue | Impact | Effort | Files Affected |
|-------|--------|--------|----------------|
| Logger/EventBus/Utils cycle | Build, Testing | High | 10+ files |
| BaseToolUseAgent cycles | Maintainability | Medium | 5 files |
| MainViewMessageHandler | Testing, Changes | Medium | 1 large file |
| Tool approval ping-pong | Complexity | High | 6 files |

### Medium Priority (Code Quality)

| Issue | Impact | Effort | Files Affected |
|-------|--------|--------|----------------|
| executeAgent nesting | Readability | Medium | 1 file |
| ProgressView cycles | State bugs | Medium | 4 files |
| Mixed concerns in commands | Testing | Low | 10+ files |
| Bidirectional tool context | Bugs | Medium | 5 files |

### Recommended Refactoring Order

1. **Extract pure type modules** - Break the largest cycles by moving types to separate files
2. **Create service layer** - Extract business logic from handlers into testable services
3. **Simplify approval flow** - Replace event cascade with command pattern
4. **Flatten async chains** - Refactor executeAgent into pipeline steps
5. **Unify state management** - Move to unidirectional data flow for tools

---

## 8. Appendix: File Reference

### Files with Circular Dependencies
- `src/agent/core/AgentDataclass.ts` ↔ `AgentSessionSchema.ts`
- `src/logger/TaskState.ts` ↔ `src/utils/config/configConversion.ts`
- `src/common/errors/` → `src/logger/` → `src/eventBus/` → `src/utils/files/` → cycle
- `src/agent/implementations/BaseToolUseAgent.ts` ↔ multiple toolUse files
- `src/progressView/managers/` ↔ `src/progressView/state/`

### Files with Deep Nesting
- `src/agent/runtime/executeAgent.ts:394-504`
- `src/tools/approval/toolEditApproval.ts:488-549`
- `src/progressView/ProgressViewMessageHandler.ts:370-407`

### Files with Mixed Concerns
- `src/webview/MainViewMessageHandler.ts`
- `src/webview/managers/ExecutionManager.ts`
- `src/commands/api/apiKeyCommands.ts`
- `src/frontend/agents/AgentDirectoryManager.ts`
