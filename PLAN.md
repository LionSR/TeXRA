# BaseReflectionAgent → PocketFlow Nodes Refactoring Plan (v2)

## Goal

Refactor BaseReflectionAgent to be truly PocketFlow-native:
1. Follow prep/exec/post separation strictly
2. Consolidate TeXCount and media logic in ONE place (not two)
3. Handle failures gracefully (PDF compilation can fail without retry)
4. Use balanced 5-node architecture (not over-engineered)

## Current Problems

### Problem 1: Logic Lives in Two Places

**TeXCount:**
1. `LatexMediaManager.attachTeXCount()` (line 89-99) - **computes** stats
2. `BaseReflectionAgent.prependTexcountStats()` (line 699-705) - **prepends** to messages

**Media Preparation:**
1. `LatexMediaManager.processInputFiles/processOutputFiles()` - **extracts** media
2. `BaseReflectionAgent.prepareWorkspaceState()` (line 747-811) - **orchestrates** which files

### Problem 2: Monolithic executeCurrentRound()

```
executeCurrentRound() bundles ~15 operations:
  └── withRoundStage()
      ├── prepareWorkspaceState()     // media, TikZ, texcount
      ├── prepareRoundContext()       // prompt building + texcount prepending
      └── runRoundPipeline()          // model call + output handling
```

### Problem 3: PocketFlow Violations

- prep() does heavy I/O (should be pure data extraction)
- State mutations scattered across methods
- Error handling is all-or-nothing (entire round fails if PDF compilation fails)

## Proposed Architecture: 5-Node Flow

```
InitNode → PrepareWorkspaceNode → PrepareContextNode → RoundNode → FinalizeNode
                                                         ↓↑ CONTINUE
```

### Why 5 Nodes (Not More)

Following ToolUseRunFlow pattern (Init → Prepare → Cycle → Wait → Finalize):
- One node per **major phase with distinct error handling**
- Not one node per operation (over-engineering)
- Each node is independently testable

## Node Specifications

### Node 1: InitNode (existing StandardInitNode)

No changes needed. Already PocketFlow-native.

### Node 2: PrepareWorkspaceNode

**Responsibility:** ALL workspace preparation (media + texcount consolidated here)

**Key Design Decision:** TeXCount computation AND attachment happens here, not split across two places.

```typescript
interface WorkspacePrepResult {
  kind: 'success' | 'degraded';
  workspaceState: AgentWorkspaceState;
  warning?: string;
}

class PrepareWorkspaceNode extends Node<ReflectionRunShared> {
  async prep(shared: ReflectionRunShared): Promise<WorkspacePrepInput> {
    // Pure data extraction - NO I/O
    const roundIndex = shared.state.currentRound;
    const agent = shared.agent;

    // Determine which files to process based on round
    const files = roundIndex === 0
      ? agent.getInputFiles()      // First round: input files
      : agent.getPreviousOutputFiles(roundIndex - 1);  // Subsequent: previous outputs

    return {
      files,
      roundIndex,
      toolConfig: agent.toolConfig,
      supportsVision: agent.modelHandler.capabilities.supportsVision,
      extraMediaFiles: roundIndex === 0 ? agent.getConfiguredMediaFiles() : [],
    };
  }

  async exec(prepRes: WorkspacePrepInput): Promise<WorkspacePrepResult> {
    const workspaceState = AgentWorkspaceState.create();

    // 1. TeXCount (can fail gracefully)
    if (prepRes.toolConfig.attachTeXCount && prepRes.files.length > 0) {
      try {
        const stats = await getTeXCountStats(prepRes.files);
        workspaceState.document.texcountStats = stats;
      } catch (error) {
        // Non-fatal - continue without stats
        return {
          kind: 'degraded',
          workspaceState,
          warning: `TeXCount failed: ${error.message}`
        };
      }
    }

    // 2. Media extraction (can fail gracefully)
    if (prepRes.supportsVision) {
      try {
        await latexMediaManager.processFiles(
          prepRes.files,
          workspaceState,
          prepRes.toolConfig,
          prepRes.supportsVision,
          { extraMediaFiles: prepRes.extraMediaFiles }
        );
      } catch (error) {
        return {
          kind: 'degraded',
          workspaceState,
          warning: `Media extraction failed: ${error.message}`
        };
      }
    }

    return { kind: 'success', workspaceState };
  }

  async execFallback(
    prepRes: WorkspacePrepInput,
    error: Error
  ): Promise<WorkspacePrepResult> {
    // Total failure - return empty workspace with warning
    return {
      kind: 'degraded',
      workspaceState: AgentWorkspaceState.create(),
      warning: `Workspace preparation failed: ${error.message}`,
    };
  }

  async post(
    shared: ReflectionRunShared,
    _prepRes: WorkspacePrepInput,
    execRes: WorkspacePrepResult,
  ): Promise<string | undefined> {
    // Store result in shared state (single mutation point)
    shared.state.workspaceState = execRes.workspaceState;

    if (execRes.warning) {
      shared.agent.logger.warn(execRes.warning);
    }

    return undefined; // Continue to PrepareContextNode
  }
}
```

### Node 3: PrepareContextNode

**Responsibility:** Build prompts and messages (INCLUDING texcount prepending)

**Key Design Decision:** Reads texcount from workspaceState (computed by PrepareWorkspaceNode), prepends to messages.

```typescript
interface ContextPrepResult =
  | { kind: 'ready'; context: RoundContext }
  | { kind: 'skip' };  // No content for this round

class PrepareContextNode extends Node<ReflectionRunShared> {
  async prep(shared: ReflectionRunShared): Promise<ContextPrepInput> {
    // Pure data extraction
    return {
      roundIndex: shared.state.currentRound,
      workspaceState: shared.state.workspaceState,  // From PrepareWorkspaceNode
      messages: shared.state.conversation,
      agent: shared.agent,
    };
  }

  async exec(prepRes: ContextPrepInput): Promise<ContextPrepResult> {
    const { roundIndex, workspaceState, agent } = prepRes;

    // Build prompts via agent method
    const promptData = roundIndex === 0
      ? await agent.buildFirstRoundPrompts()
      : await agent.buildSubsequentRoundPrompts(roundIndex);

    if (promptData.skip) {
      return { kind: 'skip' };
    }

    // Prepend texcount stats (SINGLE PLACE - not in agent anymore)
    const texcountStats = workspaceState.document.texcountStats;
    const userContent = texcountStats
      ? `${texcountStats}${promptData.userContent}`
      : promptData.userContent;

    // Build messages via model handler
    const preparedMessages = await agent.modelHandler.initializeMessages(
      userContent,
      promptData.userRequest,
      workspaceState.media.files,
      promptData.systemPrompt,
    );

    return {
      kind: 'ready',
      context: {
        stateRound: new ConversationRoundState(roundIndex),
        preparedMessages,
        prefill: promptData.prefill,
      },
    };
  }

  async post(
    shared: ReflectionRunShared,
    _prepRes: ContextPrepInput,
    execRes: ContextPrepResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'skip') {
      // Skip this round, continue to next
      shared.state.currentRound += 1;
      return FlowTransition.CONTINUE;
    }

    shared.state.context = execRes.context;
    return undefined; // Continue to RoundNode
  }
}
```

### Node 4: RoundNode (combines Cycle + Output)

**Responsibility:** Execute model cycle AND handle output

**Key Design Decision:** Keep cycle and output together because:
- Output processing depends on cycle result
- Matches ToolUseCycleFlow pattern
- One retry scope for the core operation

```typescript
type RoundExecResult =
  | { kind: 'success'; result: ReflectionRoundResult }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: Error };

class RoundNode extends Node<ReflectionRunShared> {
  constructor() {
    super(1, 0); // maxRetries=1 (no retry), wait=0
  }

  async prep(shared: ReflectionRunShared): Promise<RoundPrepInput> {
    const { currentRound, workspaceState, context, conversation } = shared.state;

    // Check termination conditions
    const shouldFinalize =
      currentRound >= shared.state.totalRounds ||
      shared.agent.isInterruptionRequested();

    if (!shouldFinalize) {
      // Initialize round context in agent (state management)
      shared.agent.beginRound(currentRound, shared.state.runState, conversation);
    }

    return {
      shouldFinalize,
      roundIndex: currentRound,
      context: context!,
      workspaceState,
      agent: shared.agent,
    };
  }

  async exec(prepRes: RoundPrepInput): Promise<RoundExecResult> {
    if (prepRes.shouldFinalize) {
      return { kind: 'finalize' };
    }

    // Run response cycle via agent
    const cycleResult = await prepRes.agent.runResponseCycle(
      prepRes.context,
      prepRes.workspaceState,
    );

    if (cycleResult.userCancelled) {
      return { kind: 'cancelled' };
    }

    // Handle output (can fail gracefully)
    try {
      const output = await prepRes.agent.handleRoundOutput(
        prepRes.roundIndex,
        cycleResult,
      );
      return { kind: 'success', result: { ...cycleResult, output } };
    } catch (error) {
      // Output handling failed but cycle succeeded - return partial
      prepRes.agent.logger.warn(`Output handling failed: ${error.message}`);
      return { kind: 'success', result: { ...cycleResult, output: null } };
    }
  }

  async execFallback(prepRes: RoundPrepInput, error: Error): Promise<RoundExecResult> {
    return { kind: 'error', error };
  }

  async post(
    shared: ReflectionRunShared,
    prepRes: RoundPrepInput,
    execRes: RoundExecResult,
  ): Promise<string | undefined> {
    switch (execRes.kind) {
      case 'finalize':
        return FlowTransition.FINALIZE;

      case 'cancelled':
        shared.lifecycle.fail(new Error('User cancelled'));
        return FlowTransition.FINALIZE;

      case 'error':
        shared.lifecycle.fail(execRes.error);
        return FlowTransition.FINALIZE;

      case 'success':
        // Record round result
        shared.agent.recordRoundResult(execRes.result);

        // Update flow state
        shared.state.runState = execRes.result.runState;
        shared.state.conversation = execRes.result.messages;
        shared.state.currentRound += 1;

        // Check if should continue
        if (
          shared.agent.isInterruptionRequested() ||
          shared.state.currentRound >= shared.state.totalRounds ||
          !execRes.result.shouldContinue
        ) {
          return FlowTransition.FINALIZE;
        }

        return FlowTransition.CONTINUE;
    }
  }
}
```

### Node 5: FinalizeNode (existing StandardFinalizeNode)

No changes needed. Already PocketFlow-native.

## Flow Wiring

```typescript
export function createReflectionRunFlow(): Flow<ReflectionRunShared> {
  const initNode = new ReflectionInitNode();
  const prepWorkspaceNode = new PrepareWorkspaceNode();
  const prepContextNode = new PrepareContextNode();
  const roundNode = new RoundNode();
  const finalizeNode = new StandardFinalizeNode<ReflectionRunShared>('finalize');

  // Wire linear flow
  initNode.next(prepWorkspaceNode);
  prepWorkspaceNode.next(prepContextNode);
  prepContextNode.next(roundNode);

  // Wire branches
  initNode.on(FlowTransition.FINALIZE, finalizeNode);
  prepContextNode.on(FlowTransition.CONTINUE, prepWorkspaceNode);  // Skip round
  roundNode.on(FlowTransition.CONTINUE, prepWorkspaceNode);        // Next round
  roundNode.on(FlowTransition.FINALIZE, finalizeNode);

  return new Flow<ReflectionRunShared>(initNode);
}
```

## Consolidation: Where Logic Lives NOW vs AFTER

### TeXCount

| Aspect | BEFORE (2 places) | AFTER (1 place) |
|--------|-------------------|-----------------|
| Compute stats | `LatexMediaManager.attachTeXCount()` | `PrepareWorkspaceNode.exec()` |
| Store in state | `LatexMediaManager` | `PrepareWorkspaceNode.post()` |
| Prepend to message | `BaseReflectionAgent.prependTexcountStats()` | `PrepareContextNode.exec()` |

**Result:** TeXCount still flows through two nodes, but the LOGIC is clear:
- PrepareWorkspaceNode: Compute + Store
- PrepareContextNode: Read + Apply

### Media

| Aspect | BEFORE (2 places) | AFTER (1 place) |
|--------|-------------------|-----------------|
| Decide which files | `BaseReflectionAgent.prepareWorkspaceState()` | `PrepareWorkspaceNode.prep()` |
| Extract/compile | `LatexMediaManager.processInputFiles()` | `PrepareWorkspaceNode.exec()` |
| Store in state | `LatexMediaManager` via workspaceState | `PrepareWorkspaceNode.post()` |

**Result:** All media logic consolidated in PrepareWorkspaceNode.

## Changes to BaseReflectionAgent

### Methods to KEEP (called by nodes)

```typescript
// State management
beginRound(roundIndex, runState, messages): void
recordRoundResult(result): void

// Prompt building (simplified - no texcount prepending)
buildFirstRoundPrompts(): Promise<PromptData>
buildSubsequentRoundPrompts(roundIndex): Promise<PromptData>

// Cycle execution (simplified - workspaceState passed in)
runResponseCycle(context, workspaceState): Promise<CycleResult>
handleRoundOutput(roundIndex, cycleResult): Promise<RoundOutput>

// File accessors
getInputFiles(): FileLocation[]
getPreviousOutputFiles(roundIndex): FileLocation[]
getConfiguredMediaFiles(): FileLocation[]
```

### Methods to REMOVE

```typescript
// Removed - logic moved to PrepareWorkspaceNode
prepareWorkspaceState(): Promise<void>

// Removed - logic moved to PrepareContextNode
prependTexcountStats(content, workspaceState): string

// Removed - split into buildXxxPrompts + PrepareContextNode
prepareRoundContext(): Promise<{...}>
prepareFirstRoundContext(): Promise<{...}>
prepareSubsequentRoundContext(): Promise<{...}>

// Removed - orchestrated by flow
executeCurrentRound(): Promise<ReflectionRoundResult>
```

## Error Handling Strategy

| Node | Operation | Failure Mode | Behavior |
|------|-----------|--------------|----------|
| PrepareWorkspaceNode | TeXCount | Tool unavailable | `kind: 'degraded'`, continue |
| PrepareWorkspaceNode | PDF compile | File not compilable | `kind: 'degraded'`, continue |
| PrepareWorkspaceNode | TikZ extract | Invalid TikZ | `kind: 'degraded'`, continue |
| PrepareWorkspaceNode | Figure extract | Files missing | `kind: 'degraded'`, continue |
| PrepareContextNode | Prompt build | Invalid config | Fail round |
| RoundNode | Response cycle | API error | Fail round |
| RoundNode | Output handling | Latexdiff fails | Log warning, return partial |

## Implementation Steps

### Step 1: Create Node Files
1. `src/agent/implementations/flows/nodes/PrepareWorkspaceNode.ts`
2. `src/agent/implementations/flows/nodes/PrepareContextNode.ts`
3. `src/agent/implementations/flows/nodes/RoundNode.ts`
4. `src/agent/implementations/flows/nodes/index.ts`

### Step 2: Add Agent Accessor Methods
1. `getInputFiles()` - extract from prepareWorkspaceState
2. `getPreviousOutputFiles(roundIndex)` - extract from prepareWorkspaceState
3. `getConfiguredMediaFiles()` - extract from prepareWorkspaceState
4. `buildFirstRoundPrompts()` - extract from prepareFirstRoundContext
5. `buildSubsequentRoundPrompts()` - extract from prepareSubsequentRoundContext

### Step 3: Update ReflectionRunFlow
1. Replace ReflectionRoundNode with new 3-node structure
2. Update flow wiring
3. Update ReflectionRunState type

### Step 4: Remove Old Methods
1. Remove `executeCurrentRound()`
2. Remove `prepareWorkspaceState()`
3. Remove `prependTexcountStats()`
4. Remove `prepareRoundContext()` and variants

### Step 5: Update LatexMediaManager
1. Remove `attachTeXCount()` from `processFiles()` internal call
2. Expose `getTeXCountStats()` as standalone (already exists in texcount.ts)
3. Keep `processInputFiles/processOutputFiles` for media extraction only

## Files Changed

### New Files
- `src/agent/implementations/flows/nodes/PrepareWorkspaceNode.ts`
- `src/agent/implementations/flows/nodes/PrepareContextNode.ts`
- `src/agent/implementations/flows/nodes/RoundNode.ts`
- `src/agent/implementations/flows/nodes/index.ts`

### Modified Files
- `src/agent/implementations/flows/ReflectionRunFlow.ts` - new 5-node structure
- `src/agent/implementations/BaseReflectionAgent.ts` - add accessors, remove bundled methods
- `src/latex/LatexMediaManager.ts` - remove texcount from processFiles (optional)

## Testing Strategy

1. **Unit tests per node:**
   - PrepareWorkspaceNode: Test degraded mode on failures
   - PrepareContextNode: Test skip detection
   - RoundNode: Test all result kinds

2. **Integration tests:**
   - Full flow with mock agent
   - Graceful degradation (PDF fails, flow continues)
   - Round skipping behavior

3. **Regression tests:**
   - Existing reflection agent behavior preserved
   - Output artifacts identical
