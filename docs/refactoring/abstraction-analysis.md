# Code Duplication and Abstraction Overhead Analysis

This document identifies code duplication patterns, abstraction overhead, and "spaghetti" code paths that violate the single source of truth principle. Each finding includes specific file:line references and refactoring recommendations.

## Executive Summary

| Category | High Priority | Medium Priority | Low Priority |
|----------|---------------|-----------------|--------------|
| Model Handlers | 2 | 3 | 2 |
| Agent Flows | 1 | 1 | 2 |
| Output/Display | 2 | 3 | 2 |
| Webviews | 2 | 3 | 2 |
| Commands/Utils | 0 | 2 | 4 |
| Runtime/State | 1 | 2 | 4 |

**Estimated Total Impact:** 500-700 lines of duplicated code that can be consolidated.

---

## 1. MODEL HANDLERS - Highest Duplication Density

### 1.1 [HIGH] Streaming with Reasoning Content

**Problem:** 3 handlers duplicate ~200 lines of streaming aggregation logic.

| File | Lines | Pattern |
|------|-------|---------|
| `src/agent/modelHandlers/modelHandlerOpenAI.ts` | 267-371 | Base streaming implementation |
| `src/agent/modelHandlers/modelHandlerKimi.ts` | 50-190 | 80% overlap with OpenAI |
| `src/agent/modelHandlers/modelHandlerOpenRouter.ts` | 110-206 | Similar with reasoning_details |

**Code Pattern (repeated):**
```typescript
thinking.append()
output.append()
streamingAggregator.handleChunk()
// Provider-specific reasoning extraction
```

**Refactoring:** Create `OpenAICompatibleStreamingHandler` in `src/agent/modelHandlers/support/`:
- Extract common streaming loop
- Providers override only `extractReasoningDelta()` callback
- **Savings:** ~150-200 LOC

### 1.2 [HIGH] Thinking Block Processing

**Problem:** 5 handlers have nearly identical thinking block extraction.

| File | Lines | Method |
|------|-------|--------|
| `modelHandlerOpenAI.ts` | 1188-1225 | `extractReasoningFromMessage()` + `processThinkingBlock()` |
| `modelHandlerGoogleGenAI.ts` | 1125-1173 | Google-specific extraction |
| `modelHandlerXAI.ts` | 24-78 | Direct field access |
| `modelHandlerKimi.ts` | 47-48 | Inherits but has custom streaming |
| `modelHandlerOpenRouter.ts` | 215-235 | Custom `extractReasoningFromMessage()` |

**Refactoring:** Extract to `ReasoningExtractors` strategy pattern:
```typescript
// src/agent/modelHandlers/support/ReasoningExtractors.ts
export const ReasoningExtractors = {
  openai: (msg) => msg?.reasoning_content,
  openrouter: (msg) => extractTextFromReasoningDetails(msg?.reasoning_details),
  xai: (msg) => msg?.reasoning_content,
};
```
**Savings:** ~100 LOC

### 1.3 [MEDIUM] Tool Call Normalization

**Problem:** Identical tool call normalization in multiple handlers.

| File | Lines | Description |
|------|-------|-------------|
| `modelHandlerOpenAI.ts` | 1244-1310 | `normalizeToolCall()` + `extractToolUse()` |
| `modelHandlerGoogleGenAI.ts` | 1175-1215 | Similar pattern |
| `modelHandlerOpenAIResponse.ts` | 1309-1370 | Responses API variant |

**Refactoring:** Extract `ToolCallNormalizer` utility to `src/agent/modelHandlers/utils/`.
**Savings:** ~60 LOC

### 1.4 [MEDIUM] Client Initialization

**Problem:** All handlers repeat API key + base URL + client creation.

| File | Lines |
|------|-------|
| `modelHandlerAnthropic.ts` | 300-307 |
| `modelHandlerOpenAI.ts` | 130-143 |
| `modelHandlerGoogleGenAI.ts` | 338-353 |

**Refactoring:** Create `ClientFactory` helper.
**Savings:** ~40 LOC

---

## 2. AGENT FLOWS - Well-Structured with Minor Issues

### 2.1 [HIGH] Duplicate Finalization Logic

**Problem:** Two separate finalization functions doing nearly the same thing.

| Location | Lines | Function |
|----------|-------|----------|
| `src/agent/core/flows/CycleServices.ts` | 176-186 | `finalizeRound()` |
| `src/agent/core/flows/CycleServices.ts` | 209-224 | `finalizeToolUseCycle()` |

**Difference:** Only whether usage goes through `round` object or directly to `usageAccumulator`.

**Impact Files:**
- `ResponseCycleFlow.ts:699` - uses `finalizeRound()`
- `ToolUseCycleFlow.ts:603` - uses `finalizeToolUseCycle()`
- `ResponseCycleNode.ts:226-231` - fallback finalization

**Refactoring:** Create unified `finalizeAgentCycle()` function.
**Savings:** ~20 LOC, clearer single source of truth

### 2.2 [LOW] Unused Local Interface

**Location:** `src/agent/implementations/flows/reflection/nodes/ResponseCycleNode.ts:57-61`

```typescript
interface CycleStateSlices {
  round: ConversationRoundState;
  run: AgentRunState;
  workspace: AgentWorkspaceState;
}
```

**Problem:** Never used - the shared `CycleStateSlices` from CycleServices is used instead.

**Refactoring:** Delete lines 57-61.

### 2.3 [LOW] Reset State Wrapper

**Location:** `src/agent/core/flows/ToolUseCycleFlow.ts:168-179`

**Problem:** `resetToolUseState()` is only called from one location (line 239).

**Refactoring:** Inline into `ToolUsePrepNode.post()`.

---

## 3. OUTPUT/DISPLAY SYSTEMS

### 3.1 [HIGH] File Path Extraction (4 Implementations)

**Problem:** Same path extraction logic reimplemented across managers.

| File | Function | Lines |
|------|----------|-------|
| `src/agent/output/displayUtils.ts` | `getFileDirectory()` | 11-16 |
| `src/agent/output/LatexDiffManager.ts` | `getDisplayLabel()` | 115-121 |
| `src/agent/output/LatexDiffManager.ts` | `getWorkingDirectory()` | 84-87 |
| `src/agent/output/FileLineageCalculator.ts` | `getBaseName()` | 178-184 |

**Duplicate Pattern:**
```typescript
// Repeated 4x with slight variations
location.kind === 'workspace' || location.kind === 'runStorage'
  ? location.relativePath
  : location.absolutePath
```

**Refactoring:** Consolidate into `FileLocationUtils`:
```typescript
// src/agent/output/FileLocationUtils.ts
export function getEffectivePath(location: FileLocation): string
export function getBaseName(location: FileLocation): string
export function getDirectory(location: FileLocation): string
```
**Savings:** ~40 LOC

### 3.2 [HIGH] Post-Processing Workflow Duplication

**Location:** `src/agent/output/OutputFileProcessor.ts`

**Problem:** `processMultipleOutputs()` (49-105) and `processSingleOutput()` (107-194) follow identical pattern:

1. Process with xmlManager
2. Indent LaTeX files
3. Replace input commands
4. Set round outputs
5. Capture XML summary
6. Handle cleanup on failure

**Refactoring:** Extract common `processOutputWithWorkflow()` method.
**Savings:** ~50 LOC

### 3.3 [MEDIUM] XML Processing Pipeline

**Location:** `src/agent/output/XmlOutputManager.ts`

**Problem:** `splitScratchpadOutputXml()` (202-280) and `splitScratchpadMultipleOutputXml()` (348-371) share:
- CDATA wrapping logic
- XMLParser configuration (identical 7 lines)
- Fallback extraction strategy

**Refactoring:** Extract `createAndParseXml()` utility.
**Savings:** ~30 LOC

### 3.4 [MEDIUM] Stage/Scope Wrapping (3 Patterns)

**Problem:** Three different patterns for wrapping async operations with logging:

| File | Lines | Pattern |
|------|-------|---------|
| `OutputHandler.ts` | 193-202 | `withOutputStage()` |
| `OutputFileProcessor.ts` | 289-290 | `stage?.within(run)` |
| `LatexDiffManager.ts` | 350-354 | `stage?.within(execute)` |

**Refactoring:** Standardize on single approach.

---

## 4. WEBVIEW SYSTEMS

### 4.1 [HIGH] Banner Message Handlers (6 Duplicates)

**Location:** `src/webview/MainViewMessageHandler.ts:221-289`

**Problem:** Six identical handler implementations:
```typescript
[COMMAND.SHOW_X_BANNER]: async (m) => {
  const view = this.getActiveView();
  view?.webview.postMessage(m);
},
[COMMAND.HIDE_X_BANNER]: async (m) => {
  const view = this.getActiveView();
  view?.webview.postMessage(m);
},
```

**Refactoring:** Create generic banner handler in `BaseViewMessageHandler`:
```typescript
protected createBannerHandler() {
  return async (m) => this.getActiveView()?.webview.postMessage(m);
}
```
**Savings:** ~25 LOC

### 4.2 [HIGH] Null Check Pattern (16+ Instances)

**Location:** `src/webview/managers/FileManager.ts`

**Problem:** `getWebview()` null check repeated at lines 60, 80, 96, 116, 180, 213, etc.

**Refactoring:** Add to `BaseWebviewManager`:
```typescript
protected async postMessageSafe(message: any): Promise<void> {
  this.getWebview()?.webview.postMessage(message);
}

protected async withWebview<T>(
  callback: (webview: vscode.WebviewView) => Promise<T>
): Promise<T | undefined>
```
**Savings:** ~60 LOC

### 4.3 [MEDIUM] Provider showView() Methods

**Location:**
- `src/historyView/HistoryViewProvider.ts:44-68`
- `src/profileView/ProfileViewProvider.ts:46-74`

**Problem:** Nearly identical `showView()` implementations with same:
- View existence check
- Panel creation
- Webview options setting

**Refactoring:** Add template method to `BaseWebviewProvider`.
**Savings:** ~30 LOC

---

## 5. RUNTIME/STATE MANAGEMENT

### 5.1 [HIGH] Three-Layer Initialization Wrapper

**Location:** `src/agent/runtime/executeAgent.ts:147-251`

**Problem:** `prepareFlowExecution()` is a ~100 line wrapper that:
1. Resolves agent definition
2. Loads settings and prompts
3. Creates model handler
4. Builds user variables
5. Creates usage monitor
6. Delegates to `createToolUseFlowContext` or `createReflectionFlowContext`

**Current flow:**
```
executeAgent() → prepareFlowExecution() → createToolUseFlowContext()
```

**Better flow:**
```
executeAgent() → createToolUseFlowContext() (with resolved inputs)
```

**Refactoring:** Move agent resolution into dedicated functions, flow context factories accept resolved values directly.
**Savings:** ~50 LOC of glue code

### 5.2 [MEDIUM] Service Accessor Duplication

**Problem:** Services define redundant convenience aliases.

| File | Lines | Duplicates |
|------|-------|------------|
| `BaseFlowServices.ts` | 106-109 | `logger`, `context` |
| `ReflectionServices.ts` | 36-85 | Same accessors |
| `ToolUseServices.ts` | 53-75 | Same accessors |

**Pattern:**
```typescript
// logger is literally just executionContext.logger
// context is just an alias for executionContext
```

**Refactoring:** Use getter functions or access directly from `executionContext`.

### 5.3 [MEDIUM] Mutable StorageKey

**Location:** `src/agent/runtime/AgentExecutionContext.ts:54-162`

**Problem:** `storageKey` is mutable in an otherwise immutable identity object:
```typescript
private _identity: {
  readonly executionId: ExecutionId;
  storageKey: StorageKey;  // ← MUTABLE
  readonly streamTabId: StreamTabId;
};
```

Only workflow agents call `updateStorageKey()` once during task group creation. Line 155-159 logs a warning if called multiple times.

**Refactoring:** Use callback pattern or lazy initialization instead of mutation.

---

## 6. COMMANDS/UTILS - Generally Well-Consolidated

### 6.1 [MEDIUM] FileOpResult Display Pattern

**Problem:** Two nearly identical result display functions.

| File | Lines | Function |
|------|-------|----------|
| `src/commands/housekeeping/packCommands.ts` | 66-96 | `showPackResult()` |
| `src/commands/housekeeping/cleanCommands.ts` | 24-43 | `showCleanResult()` |

**Refactoring:** Extract to shared `FileOpResultHandler` utility.
**Savings:** ~30 LOC

### 6.2 [MEDIUM] Webview HTML Templates

**Location:** `src/commands/wolfram/wolframScriptCommands.ts`

**Problem:** Two nearly identical HTML templates at lines 130-187 and 268-331.

**Refactoring:** Create `createResultWebviewPanel()` utility in `@frontend/webview`.
**Savings:** ~80 LOC

### 6.3 [LOW] ZodError Formatting

**Problem:** Two different Zod error formatting approaches.

| File | Lines | Pattern |
|------|-------|---------|
| `packCommands.ts` | 58-64 | `formatZodError()` with path |
| `executeCommand.ts` | 81-82 | Inline `.map((i) => i.message).join('; ')` |

**Refactoring:** Extract `formatZodError()` to `@utils/text/stringUtils`.

---

## Refactoring Priority Roadmap

### Phase 1: High Impact, Low Effort (Week 1)
1. **Model Handlers Streaming** - Extract `OpenAICompatibleStreamingHandler`
2. **Banner Handlers** - Create generic handler in `BaseViewMessageHandler`
3. **File Path Extraction** - Create `FileLocationUtils`
4. **Finalization Logic** - Unify `finalizeAgentCycle()`

### Phase 2: Medium Impact (Week 2)
1. **Thinking Block Processing** - Create `ReasoningExtractors`
2. **Post-Processing Workflow** - Extract common method
3. **Webview Null Checks** - Add `BaseWebviewManager` helpers
4. **Provider showView()** - Add template method

### Phase 3: Cleanup (Week 3)
1. **Tool Call Normalization** - Extract utility
2. **XML Processing** - Consolidate pipeline
3. **FileOpResult Display** - Shared handler
4. **Unused Interfaces** - Delete dead code

---

## Architecture Diagram: Current vs. Target

### Current State (Spaghetti Points)
```
ModelHandler
├── OpenAI ──┬── streaming logic (duplicated)
├── Kimi ────┤   ~200 lines each
├── OpenRouter┘
│
├── reasoning extraction (5 implementations)
└── tool normalization (3 implementations)

OutputProcessor
├── processMultiple ──┬── same workflow
└── processSingle ────┘   duplicated

Webview Handlers
├── MainView ──┬── banner handlers (6x)
├── ProgressView   │   null checks (16x)
└── HistoryView────┘
```

### Target State (Single Source of Truth)
```
ModelHandler
├── OpenAICompatibleStreamingHandler (shared)
├── ReasoningExtractors (strategy pattern)
└── ToolCallNormalizer (utility)

OutputProcessor
└── processWithWorkflow (unified)

BaseViewMessageHandler
├── createBannerHandler (factory)
└── withActiveView (helper)

BaseWebviewManager
├── postMessageSafe
└── withWebview
```

---

## Metrics

| Metric | Before | After (Est.) |
|--------|--------|--------------|
| Duplicate LOC | ~700 | ~200 |
| Files with duplication | 25+ | 10 |
| Abstraction layers (model handlers) | 3-4 | 2 |
| Abstraction layers (output) | 3 | 2 |
| Single sources of truth violations | 12 | 3 |
