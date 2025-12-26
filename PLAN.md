# BaseReflectionAgent → PocketFlow Nodes Refactoring Plan

## Goal

Refactor BaseReflectionAgent's monolithic `executeCurrentRound()` into discrete PocketFlow nodes that:
1. Follow PocketFlow patterns (prep/exec/post)
2. Are DRY and reusable across flows
3. Handle failures gracefully (operations like PDF compilation can fail without retry)
4. Enable flow composition (connect reflection + tool-use flows)

## Current Architecture Problem

`ReflectionRoundNode.exec()` calls `agent.executeCurrentRound()` as a black box, which bundles ~15 operations:

```
executeCurrentRound()
  └── withRoundStage()
      ├── prepareWorkspaceState()     // media, TikZ, texcount
      ├── prepareRoundContext()        // prompt building
      └── runRoundPipeline()           // model call + output handling
          ├── initializeOutputAndPrefill()
          ├── runResponseCycle()
          └── handleRoundCompletion()
              ├── handleOutput()       // XML structure, latexdiff
              └── finalizeRound()      // artifacts, file opening
```

## Proposed Node Architecture

### Phase 1: Reusable Nodes (src/agent/implementations/flows/nodes/)

These nodes can be shared between ReflectionRunFlow and ToolUseRunFlow:

#### 1. MediaPreparationNode

**Purpose**: Process input/output files for media extraction (figures, TikZ, PDFs)

**Why reusable**: Tool-use agents also need media context for vision models.

```typescript
interface MediaPrepNodeInput {
  files: FileLocation[];
  workspaceState: AgentWorkspaceState;
  toolConfig: ToolConfig;
  supportsVision: boolean;
  extraMediaFiles?: FileLocation[];
  mode: 'input' | 'output';  // Determines which operations to run
}

class MediaPreparationNode<Shared> extends Node<Shared> {
  async exec(prepRes: MediaPrepNodeInput): Promise<{ kind: 'success' } | { kind: 'failed'; warning: string }> {
    // Calls latexMediaManager.processInputFiles or processOutputFiles
    // PDF compilation can fail - we catch and log, not retry
  }

  async execFallback(prepRes: MediaPrepNodeInput, error: Error): Promise<{ kind: 'failed'; warning: string }> {
    // Convert error to warning - media prep failure is non-fatal
    return { kind: 'failed', warning: `Media preparation failed: ${error.message}` };
  }

  async post(shared, prepRes, execRes): Promise<string | undefined> {
    // Log warning if failed, but continue flow
    if (execRes.kind === 'failed') {
      shared.agent.logger.warn(execRes.warning);
    }
    return undefined; // Continue to next node
  }
}
```

**Key Design**: `execFallback` returns a warning instead of failing the flow. PDF compilation errors are logged but don't stop the round.

#### 2. TeXCountNode

**Purpose**: Attach TeXCount statistics to workspace state

**Why reusable**: Both reflection and tool-use agents benefit from word count context.

```typescript
interface TeXCountNodeInput {
  files: FileLocation[];
  workspaceState: AgentWorkspaceState;
  enabled: boolean;
}

class TeXCountNode<Shared> extends Node<Shared> {
  async exec(prepRes: TeXCountNodeInput): Promise<{ kind: 'success'; stats: string | null }> {
    if (!prepRes.enabled || prepRes.files.length === 0) {
      return { kind: 'success', stats: null };
    }
    const stats = await getTeXCountStats(prepRes.files.map(f => f.absolutePath));
    return { kind: 'success', stats };
  }

  async execFallback(): Promise<{ kind: 'success'; stats: null }> {
    // TeXCount failure is non-fatal
    return { kind: 'success', stats: null };
  }

  async post(shared, prepRes, execRes): Promise<string | undefined> {
    if (execRes.stats) {
      shared.state.workspaceState.document.texcountStats = execRes.stats;
    }
    return undefined;
  }
}
```

#### 3. AppendMediaMessageNode (for tool-use)

**Purpose**: Append media files to conversation messages

**Why reusable**: Used by tool-use agents when preparing follow-up messages.

```typescript
class AppendMediaMessageNode<Shared> extends Node<Shared> {
  async prep(shared: Shared) {
    return {
      messages: shared.state.conversation,
      mediaFiles: shared.state.workspaceState.media.files,
      modelHandler: shared.agent.modelHandler,
    };
  }

  async exec(prepRes): Promise<{ messages: ProviderMessage[] }> {
    // Model handler appends media to messages
    return { messages: await prepRes.modelHandler.appendMediaToMessages(...) };
  }

  async post(shared, prepRes, execRes): Promise<string | undefined> {
    shared.state.conversation = execRes.messages;
    return undefined;
  }
}
```

### Phase 2: Refactored ReflectionRunFlow

New node structure for ReflectionRunFlow:

```
InitNode → PrepareWorkspaceNode → PrepareContextNode → CycleNode → OutputNode → FinalizeNode
              ↑                                                          │
              └──────────────────── CONTINUE ────────────────────────────┘
```

#### 4. PrepareWorkspaceNode (reflection-specific)

Composes TeXCountNode + MediaPreparationNode:

```typescript
class ReflectionPrepareWorkspaceNode extends Node<ReflectionRunShared> {
  async prep(shared: ReflectionRunShared) {
    const roundIndex = shared.state.currentRound;
    const workspaceState = AgentWorkspaceState.create();
    return { agent: shared.agent, roundIndex, workspaceState };
  }

  async exec(prepRes): Promise<{ workspaceState: AgentWorkspaceState }> {
    // Delegates to shared operations (extracted from prepareWorkspaceState)
    await this.processFiles(prepRes);
    return { workspaceState: prepRes.workspaceState };
  }

  private async processFiles(prepRes): Promise<void> {
    // First round: process input files
    // Subsequent rounds: process previous round's output files
    // Both paths use LatexMediaManager internally
  }

  async execFallback(prepRes, error): Promise<{ workspaceState: AgentWorkspaceState; warning: string }> {
    // Return empty workspace with warning - non-fatal
    return {
      workspaceState: prepRes.workspaceState,
      warning: `Workspace preparation failed: ${error.message}`
    };
  }
}
```

#### 5. PrepareContextNode (reflection-specific)

Builds prompts and messages:

```typescript
class ReflectionPrepareContextNode extends Node<ReflectionRunShared> {
  async prep(shared: ReflectionRunShared) {
    return {
      agent: shared.agent,
      roundIndex: shared.state.currentRound,
      workspaceState: shared.state.workspaceState,
      messages: shared.state.conversation,
    };
  }

  async exec(prepRes): Promise<{
    kind: 'ready' | 'skip';
    stateRound?: ConversationRoundState;
    preparedMessages?: any[];
    prefill?: string;
  }> {
    // Calls promptBuilder.buildInitialPrompts or buildUserRequest
    // Prepends texcount stats
    // Returns skip=true if no content for subsequent rounds
  }
}
```

#### 6. ReflectionCycleNode

Runs the response cycle:

```typescript
class ReflectionCycleNode extends Node<ReflectionRunShared> {
  async exec(prepRes): Promise<CycleExecResult> {
    const result = await runResponseCycle({
      options: prepRes.cycleOptions,
      messages: prepRes.messages,
      outputLocation: prepRes.outputLocation,
      store: prepRes.store,
    });
    // ... convert to result type
  }
}
```

#### 7. ReflectionOutputNode

Handles output processing (can fail gracefully):

```typescript
class ReflectionOutputNode extends Node<ReflectionRunShared> {
  async exec(prepRes): Promise<OutputExecResult> {
    // handleOutput: XML structure, latexdiff
    // handleRoundCompletion: artifacts, file opening
  }

  async execFallback(prepRes, error): Promise<OutputExecResult> {
    // Log error but return partial success if possible
    // Latexdiff failure shouldn't fail the round
    return { kind: 'partial', warning: error.message };
  }
}
```

### Phase 3: Flow Composition

Enable connecting flows:

```typescript
// New interface for composable flows
interface ComposableFlow<Input, Output, Shared> {
  createShared(input: Input): Shared;
  run(shared: Shared): Promise<Output>;
}

// Reflection flow can output to tool-use flow
interface ReflectionOutput {
  conversation: ProviderMessage[];
  workspaceState: AgentWorkspaceState;
  runState: AgentRunState;
}

// Tool-use flow can consume reflection output
class ToolUseRunFlow implements ComposableFlow<ReflectionOutput, ToolUseOutput, ToolUseRunShared> {
  createShared(input: ReflectionOutput): ToolUseRunShared {
    return {
      state: {
        conversation: input.conversation,
        store: createSharedStore({ workspaceState: input.workspaceState, ... }),
        ...
      },
      ...
    };
  }
}
```

## Implementation Steps

### Step 1: Extract Reusable Operations
1. Create `src/agent/implementations/flows/nodes/` directory
2. Extract `TeXCountNode` from `LatexMediaManager.attachTeXCount`
3. Extract `MediaPreparationNode` from `LatexMediaManager.processFiles`
4. Create `AppendMediaMessageNode` for tool-use flows

### Step 2: Create Shared Types
1. Define `WorkspacePreparationInput` interface
2. Define `MediaNodeResult` with graceful failure handling
3. Create shared prep result types

### Step 3: Refactor ReflectionRunFlow
1. Create `ReflectionPrepareWorkspaceNode`
2. Create `ReflectionPrepareContextNode`
3. Create `ReflectionCycleNode`
4. Create `ReflectionOutputNode`
5. Wire nodes in new flow structure

### Step 4: Update BaseReflectionAgent
1. Remove `executeCurrentRound()` method
2. Keep `beginRound()` and `recordRoundResult()` for state management
3. Expose operations as discrete methods for nodes to call

### Step 5: Enable Flow Composition
1. Define `ComposableFlow` interface
2. Add `getFlowOutput()` method to flows
3. Wire reflection → tool-use connection

## Error Handling Strategy

| Operation | Failure Mode | execFallback Behavior |
|-----------|--------------|----------------------|
| PDF compilation | File not compilable | Log warning, continue |
| TikZ extraction | Invalid TikZ | Log warning, continue |
| TeXCount | Tool unavailable | Return null, continue |
| Figure extraction | Files missing | Log debug, continue |
| XML structure | Malformed output | Fail the round |
| Response cycle | API error | Retry via cycle node |
| Latexdiff | No base file | Log warning, continue |

## Files to Create/Modify

### New Files
- `src/agent/implementations/flows/nodes/index.ts`
- `src/agent/implementations/flows/nodes/MediaPreparationNode.ts`
- `src/agent/implementations/flows/nodes/TeXCountNode.ts`
- `src/agent/implementations/flows/nodes/AppendMediaMessageNode.ts`

### Modified Files
- `src/agent/implementations/flows/ReflectionRunFlow.ts` - New node structure
- `src/agent/implementations/BaseReflectionAgent.ts` - Remove bundled method
- `src/latex/LatexMediaManager.ts` - Expose granular operations

## DRY Analysis

### Current Duplication
1. Media message handling in both reflection and tool-use flows
2. TeXCount attachment logic duplicated
3. Workspace preparation patterns similar across agents

### After Refactoring
1. `MediaPreparationNode` shared by both flows
2. `TeXCountNode` reusable with config toggle
3. Common prep result types and patterns

## Testing Strategy

1. Unit test each node in isolation
2. Test graceful failure scenarios (PDF compilation fails)
3. Integration test full flow with mock agent
4. Test flow composition (reflection output → tool-use input)
