# BaseReflectionAgent → Pure PocketFlow Refactoring Plan (v3)

## Implementation Status ✅ COMPLETE

**Date**: 2025-12-26
**Branch**: `claude/refactor-agent-flow-logic-YxmGB`

### Completed Steps

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
