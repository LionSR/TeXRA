# BaseReflectionAgent → Pure PocketFlow Refactoring Plan (v3)

## Implementation Status ✅ PHASE 1 COMPLETE

**Date**: 2025-12-26
**Branch**: `claude/refactor-agent-flow-logic-YxmGB`

### Phase 1: Pure PocketFlow Migration ✅

1. ✅ **Services Interface** - `ReflectionServices` interface defined with all dependencies
2. ✅ **Services Getter** - `BaseReflectionAgent.services` getter implemented
3. ✅ **New Nodes Created**:
   - `TeXCountNode` - Computes TeXCount stats using shared helper
   - `MediaPreparationNode` - Extracts media using shared helper
   - `PrepareContextNode` - Builds prompts and messages
   - `ResponseCycleCompositionNode` - Composes ResponseCycleFlow as sub-flow
   - `OutputNode` - Handles output processing and latexdiff
   - `RoundCompleteNode` - Tracks round completion, creates fresh workspace state
4. ✅ **Flow Wiring** - `createReflectionFlow()` wires all nodes with transitions
5. ✅ **Agent Updated** - `run()` creates and runs flow, syncs state back
6. ✅ **DRY Helpers** - Shared helper functions in `helpers.ts`:
   - `getFilesForRound()` - Consolidated file determination logic
   - `prependTexCountStats()` - Unified texcount stats prepending
7. ✅ **Agent Method Delegates** - `getOutputFileLocation()` and `shouldEnsureXmlStructure()` exposed via services
8. ✅ **Shallow Module Eliminated** - `PrepareWorkspaceNode` merged into other nodes
9. ✅ **Native Services in PocketFlow** - First-class services support in BaseNode:
   - Added `_services` property and `services` getter to BaseNode
   - Added `Svc` type parameter to all node/flow classes
   - Flow propagates services to nodes via `setServices()`
   - Nodes access via `this.services` instead of `this._params.services`
   - Proper separation: `shared` (mutable state), `params` (per-batch), `services` (immutable)
10. ✅ **Legacy Code Removed** - ~500 lines of dead code removed from BaseReflectionAgent:
    - Removed dead fields: `isRoundActive`, `currentRoundIndex`, `currentMessages`, etc.
    - Removed dead methods: `beginRound()`, `executeCurrentRound()`, `runRoundPipeline()`, etc.
    - Deleted orphaned `ReflectionRunFlow.ts`

### Phase 2: Round Completion Native PocketFlow (Planned)

**Analysis Summary** (from deep dive):

**Current Architecture Issues:**

1. **OutputHandler is stateful** - Maintains `rounds: Map<number, RoundData>` separately from flow state
2. **Two sources of truth** - `OutputHandler.rounds` and `shared.state.roundOutputs`
3. **Events not consolidated** - Separate `addOutputFiles` and `updateMissingOutputs` events
4. **XML extraction post-flow** - `computeRuntimeXmlExports()` runs after flow, not as node

**Proposed Improvements:**

1. **Make OutputHandler more stateless**

   ```typescript
   // Current (stateful)
   outputHandler.processOutputFiles(location, round);
   const output = outputHandler.getRoundArtifacts(round);

   // Proposed (stateless, return directly)
   const output = outputHandler.processAndGetArtifacts(location, round);
   ```

2. **Consolidate events to single 'roundCompleted'**

   ```typescript
   bus.emit('roundCompleted', {
     stream, storageKey, round,
     output: RoundOutput,      // Full output including xmlSummary
     missingFiles?: string[]
   })
   ```

3. **Add XmlExtractionNode before FinalizeNode**

   ```
   RoundCompleteNode → XmlExtractionNode → FinalizeNode
   ```

   - Pure node for XML summary computation
   - Stored in `shared.state.xmlExports`
   - Eliminates post-flow processing

4. **Latexdiff as explicit node** (optional)
   ```
   OutputNode → LatexdiffNode → RoundCompleteNode
   ```

**Tool-Use vs Reflection (Key Differences):**

- Tool-use: Session-based with implicit turns, checkpoint persistence
- Reflection: Workflow-based with explicit rounds, artifact collection
- Tool-use does NOT need: latexdiff, XML processing, round artifacts, media extraction
- Common need: Both use PocketFlow with prep/exec/post pattern

### Phase 3: Consolidation & Consistency (Planned)

**Analysis of `shared.agent` Pattern:**

- ✅ Work nodes do NOT access `shared.agent` (pure)
- Only lifecycle nodes (StandardInitNode/StandardFinalizeNode) use it
- Type system allows misuse, but runtime is pure
- **Recommendation**: Keep pattern, improve documentation

**Analysis of `shared.hooks` Pattern:**

- Only 1 hook exists: `resetPromptBuilder()`
- Only used once at flow initialization
- Could be simplified to direct agent call
- **Recommendation**: Inline to `shared.agent.resetPromptBuilder()` or add to IFlowAgent

**Shallow Modules Identified:**

- `prependTexCountStats()` helper is trivial (1-line ternary)
- Can be inlined at 2 call sites in PrepareContextNode
- `getFilesForRound()` is well-designed (NOT shallow)

**ToolUseRunFlow Inconsistencies:**

- Uses hooks pattern instead of native services pattern
- Nodes typed as `Node<ToolUseRunShared<C>>` (no services type)
- Access via `shared.agent`, `shared.hooks` instead of `this.services`
- **Needs same refactoring as ReflectionFlow** (4 nodes + 1 finalize node)

**Proposed Consolidation:**

1. **Inline shallow helper**

   ```typescript
   // Remove prependTexCountStats(), inline at call sites
   const prefixWithStats = texcountStats
     ? `${texcountStats}${userPrefix}`
     : userPrefix;
   ```

2. **Simplify hooks to direct agent calls**

   ```typescript
   // In ReflectionInitNode.beforeStart():
   shared.agent.resetPromptBuilder(); // Instead of shared.hooks.resetPromptBuilder()
   ```

3. **Apply services pattern to ToolUseRunFlow**
   - Define `ToolUseServices<C>` interface
   - Convert nodes to 3-parameter type: `Node<Shared, Params, Services>`
   - Use `flow.setServices()` pattern

### Code Review Findings (Addressed)

- ✅ **Output location calculation** - Fixed via service delegate
- ✅ **XML structure polymorphism** - Fixed via service delegate
- ✅ **Workspace state reset per round** - Fixed in RoundCompleteNode.post()
- ✅ **File determination duplication** - Fixed via `getFilesForRound()` helper
- ✅ **TeXCount prepending duplication** - Fixed via `prependTexCountStats()` helper

### Remaining DRY Opportunities (Future Work)

1. **Base files determination** - Similar logic in BaseReflectionAgent constructor and OutputNode
2. **Extra media files collection** - Similar logic with slight behavioral differences

---

## Phase 4: Lifecycle Consolidation & Round Groups (Analysis)

**Date**: 2025-12-26
**Status**: Analysis Complete, Implementation Pending

### Interconnected Issues Discovered

These issues are interconnected and should be addressed together:

#### Issue 1: Phase Tracking is Dead Code

`lifecycle.phase` is **written** in 4 places but **never read**:

```typescript
// Written (but never consumed):
lifecycle.begin('init'); // StandardInitNode
lifecycle.begin(nextPhase); // StandardInitNode
lifecycle.begin('cycle'); // ToolUseCycleNode
lifecycle.setPhase('finalize'); // StandardFinalizeNode

// The getter exists but is never called:
lifecycle.phase; // ← NEVER READ
```

**Conclusion**: Phase tracking can be eliminated entirely.

#### Issue 2: Round Groups Were Removed

Old code (commit before `4c90f35`):

```typescript
return await this.withRoundStage(`r${roundIndex}`, async () => {
  // All round work happened inside this stage
});
```

This created collapsible `r0`, `r1`, `r2`... groups in Progress View. The PocketFlow refactor removed this - now all operations run under a single "Run" stage.

**`withRoundStage()` in BaseAgent:309-317 is now DEAD CODE** - never called.

#### Issue 3: StandardInitNode/StandardFinalizeNode are Redundant

These nodes are pure delegation wrappers:

```typescript
// StandardInitNode.exec() - just calls agent methods
async exec(prepRes) {
  prepRes.lifecycle.begin('init');       // ← Sets phase (never read)
  await prepRes.agent.startAndInitRun(); // ← Delegation
  await prepRes.agent.initializeClient(); // ← Delegation
  return { kind: 'success' };
}

// StandardFinalizeNode.exec() - just calls agent methods
async exec(context) {
  context.lifecycle.setPhase('finalize'); // ← Sets phase (never read)
  await context.agent.endRun(status);     // ← Delegation
  await context.agent.cleanupRun();       // ← Delegation
  context.lifecycle.complete();           // ← Sets status
}
```

The agent already owns these methods. The nodes add indirection without value.

#### Issue 4: lifecycle.fail() Duplicates try/catch

Current dual error patterns:

```typescript
// Pattern A: lifecycle.fail() + FINALIZE routing
lifecycle.fail(error);
return FlowTransition.FINALIZE;
// ... later in agent.run() ...
if (lifecycle.error) throw lifecycle.error;

// Pattern B: Native throw
throw error; // Caught by execFallback
```

This is redundant. Native `throw` + `catch` already handles error propagation.

### Proposed Solution: Agent-owns-Lifecycle + RoundFlow

#### Part 1: Agent-owns-Lifecycle

Move lifecycle management to `Agent.run()`:

```typescript
// BaseAgent.run() - single pattern for all agents
async run(): Promise<void> {
  // === INIT (was StandardInitNode) ===
  await this.startAndInitRun();
  await this.initializeClient();

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;
  try {
    await this.beforeFlowStart?.();  // Hook: resetPromptBuilder() etc.

    const flow = createFlow();
    flow.setServices(this.services);
    await flow.run(shared);

  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    // === FINALIZE (was StandardFinalizeNode) ===
    await this.beforeFlowEnd?.();  // Hook: clearPersistedSnapshot() etc.
    this.endRunStage(status);      // UI status goes here
    this.cleanup();
  }
}
```

**Benefits**:

- Eliminates `AgentLifecycle` class (91 lines)
- Eliminates `StandardInitNode` (153 lines)
- Eliminates `StandardFinalizeNode` (177 lines)
- Native try/catch IS the lifecycle
- `endRun(status)` still sends correct status to UI

#### Part 2: RoundFlow Sub-flow (Restores Round Groups)

Create a `RoundFlow` sub-flow that wraps each round in a log stage:

```
Current ReflectionFlow:
InitNode → TeXCount → Media → PrepContext → ResponseCycle → Output → RoundComplete
               ↑                                                          ↓
               └────────────────── loops back ────────────────────────────┘

Proposed ReflectionFlow:
Agent.run() → RoundCompositionNode (runs RoundFlow) → Agent.finally()
                      ↓
              ┌───────────────────────────────────────────────────┐
              │ RoundFlow (creates r0, r1, r2... stages):         │
              │   logger.stage(`r${round}`) wraps:                │
              │     TeXCount → Media → PrepContext → ...→ Output  │
              │                                           ↓       │
              │                                   check continue  │
              │                                           ↓       │
              │                                    loop or exit   │
              └───────────────────────────────────────────────────┘
```

**Implementation**:

```typescript
class RoundCompositionNode<C> extends Node<...> {
  private roundFlow = createRoundFlow<C>();

  async exec(prepRes): Promise<RoundResult> {
    let round = 0;
    while (true) {
      // Create round stage (restores r0, r1, r2... in UI)
      const stage = await this.services.logger.stage(`r${round}`);

      await stage.run(async () => {
        this.roundFlow.setServices(this.services);
        await this.roundFlow.run(roundShared);
      });

      if (!shouldContinue) break;
      round++;
    }
    return result;
  }
}
```

### Files to Delete (Consolidation)

| File                      | Lines | Reason                        |
| ------------------------- | ----- | ----------------------------- |
| `AgentLifecycle.ts`       | 91    | Replace with try/catch        |
| `StandardInitNode.ts`     | 153   | Inline in agent.run()         |
| `StandardFinalizeNode.ts` | 177   | Inline in agent.run() finally |
| `withRoundStage()`        | 9     | Dead code                     |

**Total reduction: ~430 lines, 3 files deleted**

### Files to Create (RoundFlow)

| File                      | Purpose                                  |
| ------------------------- | ---------------------------------------- |
| `RoundFlow.ts`            | Round execution sub-flow                 |
| `RoundCompositionNode.ts` | Composes RoundFlow, creates round stages |

### Migration Path

**Step 1**: Inline lifecycle in agent.run()

- Move init from StandardInitNode to agent.run() before flow
- Move finalize from StandardFinalizeNode to agent.run() finally
- Keep nodes as pass-through initially for compatibility

**Step 2**: Create RoundFlow

- Extract round nodes into RoundFlow
- Create RoundCompositionNode
- Wire round stage creation

**Step 3**: Remove standard nodes

- Update ReflectionFlow to start at RoundCompositionNode
- Update ToolUseRunFlow similarly
- Delete StandardInitNode and StandardFinalizeNode

**Step 4**: Simplify error handling

- Change nodes to throw errors instead of lifecycle.fail()
- Remove lifecycle.fail(), lifecycle.status, lifecycle.error
- Delete AgentLifecycle class

**Step 5**: Cleanup

- Remove withRoundStage() from BaseAgent
- Simplify IFlowAgent interface
- Update documentation

### UI Status Flow (Unchanged)

The key insight is that UI status flows through `agent.endRun(status)`:

```
agent.endRun(status)
    ↓
runStage.end(status)
    ↓
logger.endGroup(groupId, status)
    ↓
VSCodeTransport.emitGroupFinished({status})
    ↓
Progress View receives status
```

This path remains identical whether status is computed in StandardFinalizeNode or in agent.run() catch block.

---

## Core Problem

We're mixing two abstraction levels:

```
ReflectionRoundNode.exec()
  → agent.executeCurrentRound()           // Agent method
    → agent.runRoundPipeline()            // Agent method
      → runResponseCycle()                // Function wrapper
        → ResponseCycleFlow               // PocketFlow (4 nodes)
```

This is **hybrid architecture** - nodes calling agent methods that internally run flows.

## Solution: Pure Flow Architecture

**Agent = Service Provider** (config, handlers, state)
**Flow = Execution Engine** (all logic lives here)
**Nodes = Discrete Operations** (use agent's services)

### The ResponseCycleFlow Pattern

ResponseCycleFlow already does this correctly:

- Services injected via `_params.services`
- Nodes access `modelHandler`, `logger`, `store` from services
- No agent methods called - nodes do the work directly

### Apply Same Pattern to Reflection

```typescript
// Agent provides services, not execution
interface ReflectionServices {
  modelHandler: IModelHandler;
  outputHandler: IOutputHandler;
  latexMediaManager: LatexMediaManager;
  promptBuilder: PromptBuilder;
  fileService: TaskRunFileService;
  logger: AgentLogger;
  config: AgentConfig;
  setting: AgentWorkflowSetting;
  prompt: AgentPrompt;
}

// Flow uses services via params (like ResponseCycleFlow)
type ReflectionFlowParams = { services: ReflectionServices };
```

## New Flow Architecture

### Option A: Inline All Nodes

Flatten ResponseCycleFlow into ReflectionFlow:

```
ReflectionFlow:
  InitNode
  → PrepareWorkspaceNode      // TeXCount + Media
  → PrepareContextNode        // Prompts + Messages
  → ResponsePrepNode          // From ResponseCycleFlow
  → ResponseInvocationNode    // From ResponseCycleFlow
  → ResponseProcessNode       // From ResponseCycleFlow
  → ResponseContinuationNode  // From ResponseCycleFlow (loops back)
  → OutputNode                // Latexdiff, artifacts
  → RoundCompleteNode         // Record result, check continue
  → FinalizeNode
```

**Pros:** Single flat flow, easy to trace
**Cons:** ResponseCycleFlow nodes become reflection-specific

### Option B: Compose Sub-Flows

ReflectionFlow contains ResponseCycleFlow as a sub-flow:

```
ReflectionFlow:
  InitNode
  → PrepareWorkspaceNode
  → PrepareContextNode
  → ResponseCycleSubFlow     // Composed, not called via function
  → OutputNode
  → RoundCompleteNode
  → FinalizeNode
```

**Pros:** ResponseCycleFlow stays reusable, cleaner composition
**Cons:** Need sub-flow composition pattern

### Recommendation: Option B (Compose Sub-Flows)

PocketFlow supports flow composition. The key change is:

- Don't call `runResponseCycle()` function
- Compose `ResponseCycleFlow` directly into `ReflectionFlow`

## Detailed Node Design

### Services Structure

```typescript
// Base services shared across nodes
interface BaseAgentServices {
  modelHandler: IModelHandler;
  logger: AgentLogger;
  config: AgentConfig;
  setting: AgentWorkflowSetting;
  context: AgentExecutionContext;
}

// Reflection-specific services (extends base)
interface ReflectionServices extends BaseAgentServices {
  outputHandler: IOutputHandler;
  latexMediaManager: LatexMediaManager;
  promptBuilder: PromptBuilder;
  fileService: TaskRunFileService;
  prompt: AgentPrompt;
}

// Params for flow injection
interface ReflectionFlowParams {
  services: ReflectionServices;
}
```

### Shared State Structure

```typescript
interface ReflectionFlowState {
  // Round tracking
  currentRound: number;
  totalRounds: number;

  // Per-round state (reset each round)
  workspaceState: AgentWorkspaceState;
  context: RoundContext | null;

  // Accumulated state
  conversation: ProviderMessage[];
  runState: AgentRunState;
  roundStates: ConversationRoundState[];
  roundOutputs: RoundOutput[];
}

interface ReflectionFlowShared {
  state: ReflectionFlowState;
  lifecycle: AgentLifecycle<ReflectionPhase>;
  retryState: RetryState;
}
```

### Node Implementations

#### PrepareWorkspaceNode

Uses `latexMediaManager` from services directly:

```typescript
class PrepareWorkspaceNode extends BaseNode<
  ReflectionFlowShared,
  ReflectionFlowParams
> {
  async prep(shared: ReflectionFlowShared) {
    const { fileService, config } = this._params.services;
    const { currentRound } = shared.state;

    // Pure data extraction
    const files =
      currentRound === 0
        ? [
            fileService.createLocation(config.inputFile),
            ...config.inputFiles.map((f) => fileService.createLocation(f)),
          ]
        : this.getPreviousOutputFiles(shared);

    return { files, currentRound };
  }

  async exec(prepRes: PrepResult) {
    const { latexMediaManager, config, modelHandler } = this._params.services;
    const workspaceState = AgentWorkspaceState.create();

    // TeXCount (graceful failure)
    if (config.toolConfig.attachTeXCount) {
      try {
        const stats = await getTeXCountStats(prepRes.files);
        workspaceState.document.texcountStats = stats;
      } catch {
        // Non-fatal
      }
    }

    // Media (graceful failure)
    if (modelHandler.capabilities.supportsVision) {
      try {
        await latexMediaManager.processInputFiles(
          prepRes.files,
          workspaceState,
          config.toolConfig,
          true,
        );
      } catch {
        // Non-fatal
      }
    }

    return { kind: 'success', workspaceState };
  }

  async post(shared, prepRes, execRes) {
    shared.state.workspaceState = execRes.workspaceState;
    return undefined;
  }
}
```

#### PrepareContextNode

Uses `promptBuilder` and `modelHandler` from services:

```typescript
class PrepareContextNode extends BaseNode<
  ReflectionFlowShared,
  ReflectionFlowParams
> {
  async prep(shared: ReflectionFlowShared) {
    return {
      currentRound: shared.state.currentRound,
      workspaceState: shared.state.workspaceState,
      conversation: shared.state.conversation,
    };
  }

  async exec(prepRes: ContextPrepInput) {
    const { promptBuilder, modelHandler } = this._params.services;

    // Build prompts
    const prompts =
      prepRes.currentRound === 0
        ? await promptBuilder.buildInitialPrompts()
        : await promptBuilder.buildUserRequest(prepRes.currentRound);

    if (!prompts.userRequest?.trim()) {
      return { kind: 'skip' };
    }

    // Prepend texcount
    const texcountStats = prepRes.workspaceState.document.texcountStats;
    const userPrefix = texcountStats
      ? `${texcountStats}${prompts.userPrefix}`
      : prompts.userPrefix;

    // Build messages via model handler
    const messages = await modelHandler.initializeMessages(
      userPrefix,
      prompts.userRequest,
      prepRes.workspaceState.media.files,
      prompts.systemPrompt,
    );

    return {
      kind: 'ready',
      context: { messages, prefill: prompts.prefill },
    };
  }

  async post(shared, prepRes, execRes) {
    if (execRes.kind === 'skip') {
      shared.state.currentRound += 1;
      return FlowTransition.CONTINUE;
    }

    shared.state.context = execRes.context;
    return undefined;
  }
}
```

#### ResponseCycleCompositionNode

Instead of calling `runResponseCycle()`, compose the flow:

```typescript
class ResponseCycleCompositionNode extends BaseNode<
  ReflectionFlowShared,
  ReflectionFlowParams
> {
  private cycleFlow: Flow<ResponseCycleShared, ResponseCycleParams>;

  constructor() {
    super();
    this.cycleFlow = createResponseCycleFlow();
  }

  async prep(shared: ReflectionFlowShared) {
    const { currentRound, context, workspaceState, runState } = shared.state;
    const { setting, config, fileService } = this._params.services;

    // Create shared store for cycle
    const store = createSharedStore({
      roundIndex: currentRound,
      roundState: new ConversationRoundState(currentRound),
      runState,
      workspaceState,
    });

    // Build output location
    const outputLocation = this.getOutputLocation(currentRound);

    return { context, store, outputLocation };
  }

  async exec(prepRes: CycleExecInput) {
    const services = this._params.services;

    // Build cycle options from our services
    const cycleOptions = {
      modelHandler: services.modelHandler,
      logger: services.logger,
      agentSetting: services.setting,
      agentPrompt: services.prompt,
      agentConfig: services.config,
      client: services.modelHandler.getClient(),
      // ... other options
    };

    // Create cycle shared state
    const cycleShared: ResponseCycleShared = {
      state: {
        messages: prepRes.context.messages,
        outputLocation: prepRes.outputLocation,
        endTurn: false,
        shouldStop: false,
        // ... initial state
      },
      retryState: createRetryState(),
    };

    // Inject services and run sub-flow
    this.cycleFlow.setParams({
      services: { options: cycleOptions, store: prepRes.store },
    });
    await this.cycleFlow.run(cycleShared);

    return {
      kind: 'success',
      endTurn: cycleShared.state.endTurn,
      store: prepRes.store,
      messages: cycleShared.state.messages,
    };
  }

  async post(shared, prepRes, execRes) {
    // Update conversation with cycle result
    shared.state.conversation = execRes.messages;
    shared.state.runState = execRes.store.run;

    if (!execRes.endTurn) {
      shared.lifecycle.fail(new Error('Cycle did not complete'));
      return FlowTransition.FINALIZE;
    }

    return undefined;
  }
}
```

#### OutputNode

Uses `outputHandler` from services:

```typescript
class OutputNode extends BaseNode<ReflectionFlowShared, ReflectionFlowParams> {
  async exec(prepRes: OutputPrepInput) {
    const { outputHandler } = this._params.services;

    // Handle output processing
    try {
      await outputHandler.processOutputFiles(
        prepRes.outputLocation,
        prepRes.currentRound,
      );

      // Handle latexdiff
      if (outputHandler.hasRoundOutputs(prepRes.currentRound)) {
        const mapping = outputHandler.getRoundMapping(prepRes.currentRound);
        await outputHandler.diffManager.handleLatexdiffofOutput(
          prepRes.currentRound,
          mapping,
        );
      }

      return { kind: 'success' };
    } catch (error) {
      // Non-fatal - log and continue
      return { kind: 'degraded', warning: error.message };
    }
  }
}
```

### Flow Wiring

```typescript
export function createReflectionFlow(): Flow<
  ReflectionFlowShared,
  ReflectionFlowParams
> {
  const initNode = new ReflectionInitNode();
  const prepWorkspaceNode = new PrepareWorkspaceNode();
  const prepContextNode = new PrepareContextNode();
  const responseCycleNode = new ResponseCycleCompositionNode();
  const outputNode = new OutputNode();
  const roundCompleteNode = new RoundCompleteNode();
  const finalizeNode = new ReflectionFinalizeNode();

  // Wire linear flow
  initNode.next(prepWorkspaceNode);
  prepWorkspaceNode.next(prepContextNode);
  prepContextNode.next(responseCycleNode);
  responseCycleNode.next(outputNode);
  outputNode.next(roundCompleteNode);

  // Wire branches
  initNode.on(FlowTransition.FINALIZE, finalizeNode);
  prepContextNode.on(FlowTransition.CONTINUE, prepWorkspaceNode);
  roundCompleteNode.on(FlowTransition.CONTINUE, prepWorkspaceNode);
  roundCompleteNode.on(FlowTransition.FINALIZE, finalizeNode);

  return new Flow(initNode);
}
```

## Agent Changes

### Before: Agent Does Execution

```typescript
class BaseReflectionAgent {
  // Methods that DO work
  async executeCurrentRound() { ... }
  async runRoundPipeline() { ... }
  async prepareWorkspaceState() { ... }
  async prepareRoundContext() { ... }
  async handleOutput() { ... }
}
```

### After: Agent Provides Services

```typescript
class BaseReflectionAgent {
  // Services exposed for nodes
  get services(): ReflectionServices {
    return {
      modelHandler: this.modelHandler,
      outputHandler: this.outputHandler,
      latexMediaManager: this.latexMediaManager,
      promptBuilder: this.getPromptBuilder(),
      fileService: this.fileService,
      logger: this.logger,
      config: this.agentConfig,
      setting: this.agentSetting,
      prompt: this.agentPrompt,
      context: this.context,
    };
  }

  // State management only
  roundStates: ConversationRoundState[] = [];
  roundOutputs: RoundOutput[] = [];

  // Lifecycle
  async run(): Promise<void> {
    const flow = createReflectionFlow();

    const shared: ReflectionFlowShared = {
      state: this.createInitialState(),
      lifecycle: new AgentLifecycle('idle'),
      retryState: createRetryState(),
    };

    flow.setParams({ services: this.services });
    await flow.run(shared);

    // Extract results
    this.roundStates = shared.state.roundStates;
    this.roundOutputs = shared.state.roundOutputs;
  }
}
```

## Comparison: Before vs After

| Aspect            | Before (Hybrid)             | After (Pure Flow)               |
| ----------------- | --------------------------- | ------------------------------- |
| Execution logic   | In agent methods            | In nodes                        |
| ResponseCycleFlow | Called via function wrapper | Composed as sub-flow            |
| Services access   | `this.modelHandler`         | `_params.services.modelHandler` |
| State management  | Agent fields + flow state   | Flow state only                 |
| Testability       | Mock entire agent           | Mock services only              |
| Composability     | Agents can't connect        | Flows can compose               |

## Implementation Steps

### Step 1: Define Services Interface

1. Extract `ReflectionServices` interface from BaseReflectionAgent
2. Add `services` getter to agent

### Step 2: Create New Nodes

1. `PrepareWorkspaceNode` - uses latexMediaManager service
2. `PrepareContextNode` - uses promptBuilder service
3. `ResponseCycleCompositionNode` - composes ResponseCycleFlow
4. `OutputNode` - uses outputHandler service
5. `RoundCompleteNode` - tracks round completion

### Step 3: Wire New Flow

1. Create `createReflectionFlow()` function
2. Wire nodes with transitions

### Step 4: Update Agent

1. Add `services` getter
2. Update `run()` to create and run flow
3. Remove execution methods (keep only state/config)

### Step 5: Cleanup

1. Remove `executeCurrentRound()`
2. Remove `runRoundPipeline()`
3. Remove `prepareWorkspaceState()`
4. Remove `prepareRoundContext()` variants
5. Remove `handleOutput()`

## Benefits

1. **Pure PocketFlow**: No hybrid agent/flow mixing
2. **Composable**: Flows can be connected (reflection → tool-use)
3. **Testable**: Mock services, not entire agent
4. **Consistent**: Same pattern as ResponseCycleFlow
5. **Reusable**: ResponseCycleFlow stays independent
6. **Observable**: All execution in nodes with clear phases

---

## Phase 5: Option 3 Refactoring - PrepareContext First (Completed)

**Date**: 2025-12-26
**Status**: ✅ Complete

### Problem Statement

The original flow order was:
```
TeXCountNode → MediaPreparationNode → PrepareContextNode → ResponseCycle → ...
```

Issues:
1. **TeXCount as entry point** - Not all workflows use TeXCount, yet it's always first
2. **Scattered responsibility** - TeXCount and Media store data in `workspaceState`, PrepareContext reads it
3. **Tight coupling** - PrepareContext must know about workspaceState.document.texcountStats and workspaceState.media.files

### Solution: Option 3 Architecture

New flow order:
```
PrepareContextNode → TeXCountNode → MediaPreparationNode → ResponseCycle → ...
```

Each node handles its own contribution:
- **PrepareContext**: Builds base messages (no texcount stats, no media)
- **TeXCount**: Enriches messages by prepending stats to user content
- **Media**: Enriches messages by adding media files to user message

### Implementation Challenges

This was **significantly harder than expected** due to provider-specific message structures:

#### Challenge 1: Provider-Specific Message Formats

Each provider has different message structures:

| Provider | User Message Format |
|----------|---------------------|
| **Anthropic** | `{ role: 'user', content: ContentBlockParam[] }` where content is array of text/image blocks |
| **OpenAI** | `{ role: 'user', content: string \| ChatCompletionContentPart[] }` with polymorphic content |
| **Google** | `{ role: 'user', parts: Part[] }` with `parts` not `content` |
| **OpenAI Response** | `{ role: 'user', content: ResponseInputMessageContentList }` with `input_text` types |

#### Challenge 2: Required New ModelHandler Methods

Had to add 2 new abstract methods to `IModelHandler` and implement in all 4 handlers:

```typescript
// IModelHandler additions
prependTextToUserMessage(messages: M[], text: string): void;
addMediaToUserMessage(messages: M[], mediaFiles: FileLocation[]): Promise<void>;
```

Each implementation had to:
1. Search backwards for last user message
2. Handle content polymorphism (string vs array)
3. Use provider-specific type guards
4. Handle null/undefined safety for optional fields (e.g., Google's `msg.parts`)

#### Challenge 3: Type Safety Issues

TypeScript errors encountered:
- `TS18048: 'msg.parts' is possibly 'undefined'` (Google handler)
- `TS2339: Property 'createFormattedMediaParts' does not exist` (wrong method name)
- `TS2552: Cannot find name 'ChatCompletionContentPartText'` (type doesn't exist in OpenAI SDK)

Fixes required:
- Add null checks: `if (msg.role === 'user' && msg.parts)`
- Use correct method names: `createMediaMessage()` not `createFormattedMediaParts()`
- Use inline type assertions instead of nonexistent types

#### Challenge 4: No Similar Existing Methods

Investigated whether similar methods already existed. Found related but distinct methods:
- `createUserFollowUpMessages()` - **adds new messages**, doesn't modify existing
- `createRoundMessages()` - **creates new messages** for a round
- `addContinueMessageWithPrefill()` - for truncated response continuation

The new methods serve a unique purpose: **post-build message enrichment** - modifying already-constructed messages in place.

### Files Modified

**Model Handler Interface & Base:**
- `src/agent/modelHandlers/types/IModelHandler.ts` - Added 2 new methods
- `src/agent/modelHandlers/ModelHandler.ts` - Added abstract methods

**Handler Implementations:**
- `src/agent/modelHandlers/modelHandlerAnthropic.ts` - ~70 lines added
- `src/agent/modelHandlers/modelHandlerOpenAI.ts` - ~70 lines added
- `src/agent/modelHandlers/modelHandlerGoogleGenAI.ts` - ~45 lines added
- `src/agent/modelHandlers/modelHandlerOpenAIResponse.ts` - ~60 lines added

**Flow Nodes:**
- `src/agent/implementations/flows/reflection/nodes/PrepareContextNode.ts` - Removed texcount/media handling
- `src/agent/implementations/flows/reflection/nodes/TeXCountNode.ts` - Now calls prependTextToUserMessage
- `src/agent/implementations/flows/reflection/nodes/MediaPreparationNode.ts` - Now calls addMediaToUserMessage

**Flow Wiring:**
- `src/agent/implementations/flows/reflection/ReflectionFlow.ts` - Reordered node connections

### Lessons Learned

1. **Provider abstraction is leaky** - Message format differences force per-provider implementations
2. **Type systems can fight you** - OpenAI's types don't export `ChatCompletionContentPartText`, requiring inline type assertions
3. **Mutation vs creation** - Modifying existing messages is harder than creating new ones
4. **Investigation prevents duplication** - Subagent search confirmed no existing similar methods

### Alternatives Considered

| Approach | Pros | Cons |
|----------|------|------|
| **Option 1: ContentContributions pattern** | Clean separation | Adds new types to state |
| **Option 2: Swap Media and TeXCount order** | Minimal change | Doesn't achieve "PrepareContext first" |
| **Option 3: Message enrichment methods** ✅ | True separation, nodes self-contained | Required 4 new handler implementations |

Option 3 was chosen because it properly separates concerns - each node is fully responsible for its contribution to the final messages.

### Future Consolidation: Shared Message Initialization

Both Reflection and Tool-Use flows call `modelHandler.initializeMessages()` similarly:

```typescript
// Reflection (PrepareContextNode)
const messages = await modelHandler.initializeMessages(userPrefix, userRequest, undefined, systemPrompt);

// Tool-use (BaseToolUseAgent.prepareInitialState)
const messages = await modelHandler.initializeMessages(userPrefix, userRequest, undefined,
  systemPrompt ? `${systemPrompt}\n${instructionSuffix}` : instructionSuffix);
```

The only difference is tool-use appends `TOOL_USE_INSTRUCTIONS` to the system prompt.

**Decision**: Deferred - duplication is only ~3 lines. Benefit is marginal.

---

## Phase 6: Hydration System Analysis

**Date**: 2025-12-26
**Status**: Analysis Complete - Identified as Technical Debt

### Problem Statement

The hydration system is confusing with multiple interrelated methods:
- `hydrateOutputState()` - Entry point in BaseReflectionAgent
- `hydrateFromArtifacts()` - Worker in OutputHandler
- `awaitPendingHydration()` - Synchronization primitive

### What Hydration Does

When resuming a reflection agent run, hydration:
1. Restores output files from previous rounds
2. Switches storage context (keys, paths)
3. Makes round state available for continued execution

### Call Flow Diagram

```
executeAgent.ts (resume path, line ~450)
    │
    ▼
BaseReflectionAgent.hydrateOutputState()
    ├── fileService.updateRunContext(executionId)
    ├── context.updateStorageKey(storageKey)
    ├── outputHandler.hydrateFromArtifacts(storageKey, rounds)
    │   └── setActiveRun(targetKey)
    │       └── fileService.prepareRunWorkspace()
    └── For each round:
        └── outputHandler.getRoundArtifacts(round)
            └── this.roundOutputs[round] = output
    │
    ▼
BaseReflectionAgent.run() (line 376)
    └── awaitPendingHydration()  ← Blocks until hydration complete
        └── await this.hydrationPromise
```

### Identified Issues

#### Issue 1: Dual Sources of Truth ⚠️ MODERATE
```typescript
// OutputHandler stores:
private rounds: Map<number, RoundData>;

// BaseReflectionAgent also stores:
public roundOutputs: RoundOutput[] = [];
```
Two separate caches of the same data. `getRoundArtifacts()` copies from one to the other.

#### Issue 2: Promise Race Condition ⚠️ LOW PROBABILITY
```typescript
// In hydrateOutputState():
this.hydrationPromise = hydration;
try {
  await hydration;
} finally {
  if (this.hydrationPromise === hydration) {  // Reference equality check
    this.hydrationPromise = null;
  }
}
```
If two resume operations happen simultaneously, cleanup could race. Unlikely in practice.

#### Issue 3: Temporal Coupling ⚠️ ANTI-PATTERN
- `hydrateOutputState()` called in executeAgent.ts
- `awaitPendingHydration()` called at start of agent.run()
- Correctness depends on two methods in different files called in specific order
- If `awaitPendingHydration()` is removed, system breaks silently

#### Issue 4: Confusing Naming
| Current Name | Problem | Better Name |
|--------------|---------|-------------|
| `hydrateOutputState` | Too generic | `resumeFromSavedRounds` |
| `hydrateFromArtifacts` | Exposes internal detail | Make private, or `restoreRoundsCache` |
| `awaitPendingHydration` | Sounds like a condition | `waitForResumeComplete` |

### Complexity Metrics

| Metric | Value | Assessment |
|--------|-------|------------|
| Methods involved | 3 primary + 5 secondary | High |
| Call depth | 5-6 levels | High |
| State mutations | 6 locations | High |
| Sources of truth | 2 (OutputHandler.rounds + roundOutputs[]) | Anti-pattern |
| Temporal coupling | Yes (executeAgent → run → awaitPending) | Anti-pattern |

**Overall Complexity Score: 6.5/10** - Not spaghetti, but unnecessarily indirect.

### Root Cause

The system was designed for **runtime state persistence** (tracking rounds during a single execution), not **resumption** (restore from previously saved state). Hydration was retrofitted onto existing architecture without redesigning the data flow.

### Recommendations

**High Priority:**
1. Fix promise race condition (add version counter or make non-reentrant)
2. Add hydration validation (verify data matches current stream)

**Medium Priority:**
3. Consolidate into single `resumeFromSavedState()` method
4. Make OutputHandler more stateless (return directly instead of store-then-retrieve)
5. Remove temporal coupling by having hydration set a flag checked in run()

**Low Priority:**
6. Rename methods to use "Resume" terminology instead of "Hydrate"
7. Consider explicit hydration phase in agent lifecycle

---

## Phase 7: Service Passing Pattern Analysis

**Date**: 2025-12-26
**Status**: Analysis Complete

### Problem Statement

`modelHandler: this.modelHandler` is passed in multiple places:
- `BaseAgent.buildCycleOptions()`
- `BaseReflectionAgent.services` getter
- `BaseToolUseAgent.services` getter

### Current Pattern

Each agent defines a `services` getter that includes modelHandler and other dependencies:

```typescript
// BaseReflectionAgent.services
return {
  modelHandler: this.modelHandler,
  outputHandler: this.outputHandler,
  latexMediaManager: this.latexMediaManager,
  promptBuilder: this.getPromptBuilder(),
  fileService: this.fileService,
  logger: this.logger,
  config: this.agentConfig,
  setting: this.agentSetting,
  // ... more
};

// BaseToolUseAgent.services
return {
  modelHandler: this.modelHandler,
  logger: this.logger,
  context: this.context,
  // ... more
};
```

### Why This Pattern Exists

1. **Service Injection** - Flows need access to agent's services without tight coupling
2. **Immutability** - Fresh services object created each access (no stale references)
3. **Testability** - Can mock services without mocking entire agent

### Potential Simplifications

#### Option A: Base Services Interface
```typescript
interface BaseFlowServices<C> {
  modelHandler: IModelHandler<any, any, any, any, C>;
  logger: AgentLogger;
  context: AgentExecutionContext;
}

interface ReflectionServices<C> extends BaseFlowServices<C> {
  outputHandler: IOutputHandler;
  // ... reflection-specific
}
```

#### Option B: Services Factory in BaseAgent
```typescript
// BaseAgent
protected get baseServices() {
  return {
    modelHandler: this.modelHandler,
    logger: this.logger,
    context: this.context,
  };
}

// BaseReflectionAgent
public get services(): ReflectionServices<C> {
  return {
    ...this.baseServices,  // Spread common services
    outputHandler: this.outputHandler,
    // ... reflection-specific
  };
}
```

#### Option C: Keep Current (Explicit)
Each agent explicitly lists all services. Repetitive but clear.

### Recommendation

**Option B (Services Factory)** is best balance of DRY and clarity.

**Priority**: Low - current pattern works and is readable. The repetition is minimal (~3 lines per agent type).
