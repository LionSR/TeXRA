# Pipeline Agent System Proposal

## Executive Summary

This proposal outlines a **PocketFlow-native** design for a Pipeline Agent System that enables sequential multi-agent workflows with flexible data flow patterns. The design prioritizes extensibility, composability, and alignment with the existing agent architecture.

---

## 1. Current Architecture Analysis

### 1.1 Agent Type Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                         AgentType Enum                          │
├─────────────────────────────────────────────────────────────────┤
│  CoT        │  Direct     │  ToolUse    │  [Pipeline]           │
│  (workflow) │  (workflow) │  (toolUse)  │  (workflow - NEW)     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     AgentCategory Enum                          │
├─────────────────────────────────────────────────────────────────┤
│          Workflow              │           ToolUse              │
│    (CoT, Direct, Pipeline)     │         (Interactive)          │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 PocketFlow Node Pattern

The codebase uses a clean **PocketFlow** pattern with:

```
┌─────────────────────────────────────────────────────────────────┐
│                        BaseNode<Shared>                         │
├─────────────────────────────────────────────────────────────────┤
│  prep(shared) → PrepResult     │  Preparation phase             │
│  exec(prepRes) → ExecResult    │  Execution phase               │
│  post(shared, prep, exec) → Action │  Post-processing + routing │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Flow<Shared>                            │
├─────────────────────────────────────────────────────────────────┤
│  start: BaseNode              │  Entry node                     │
│  _orchestrate(shared)         │  Node chain execution           │
│  getNextNode(action)          │  Action-based routing           │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 Existing Run Flows

| Flow | Phases | Purpose |
|------|--------|---------|
| `ReflectionRunFlow` | IDLE → INIT → ROUNDS → FINALIZE | CoT/Direct agents |
| `ToolUseRunFlow` | IDLE → INIT → PREPARE → CYCLE → FINALIZE | Interactive agents |

---

## 2. Pipeline Architecture Design

### 2.1 Design Philosophy

**Core Principles:**
1. **PocketFlow Native**: Uses the existing node/flow primitives
2. **Compositional**: Pipelines compose existing agents, not replace them
3. **Declarative**: YAML-driven configuration with minimal code
4. **Transparent**: All intermediate outputs visible and saved
5. **Extensible**: Foundation for future parallel/conditional multi-agent patterns

### 2.2 Pipeline Data Flow Patterns

```
┌─────────────────────────────────────────────────────────────────┐
│                  Chain Mode (chainOutputToInput: true)          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  INPUT_A ──► Agent₁ ──► OUTPUT₁ ──► Agent₂ ──► OUTPUT₂         │
│                          │                       │              │
│              (becomes INPUT_A       (becomes INPUT_A            │
│               for Agent₂)            for Agent₃)                │
│                                                                 │
│  Use Case: Sequential transformations                           │
│  Example: polish → proofread → format                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│              Accumulate Mode (chainOutputToInput: false)        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  INPUT_A ──► Agent₁ ──► OUTPUT₁ ──────────────────┐            │
│    │                                               │            │
│    └───────────────────────► Agent₂ ──► OUTPUT₂   │            │
│                                │                   │            │
│                   (has access to both              │            │
│                    INPUT_A and OUTPUT₁)            │            │
│                                                    ▼            │
│  Use Case: Analysis + critique patterns                         │
│  Example: derive interpretation → criticize with original       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 PocketFlow Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PipelineRunFlow                              │
│                      (extends Flow<Shared>)                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  PHASES: IDLE → INIT → STEPS → FINALIZE                            │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    PipelineInitNode                         │   │
│  │  • Validate step configurations                             │   │
│  │  • Initialize pipeline context                              │   │
│  │  • Set up shared state                                      │   │
│  └──────────────────────────┬──────────────────────────────────┘   │
│                             │ STEP                                  │
│                             ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    PipelineStepNode                         │   │
│  │  prep:  • Resolve agent for current step                    │   │
│  │         • Prepare step-specific config overrides            │   │
│  │         • Build pipeline context variables                  │   │
│  │                                                             │   │
│  │  exec:  • Instantiate child agent                           │   │
│  │         • Execute agent.run()                               │   │
│  │         • Capture outputs                                   │   │
│  │                                                             │   │
│  │  post:  • Store step result in pipeline state               │   │
│  │         • Determine next step or finalize                   │   │
│  │         • Log UI separator                                  │   │
│  └──────────────────────────┬──────────────────────────────────┘   │
│                             │ CONTINUE | FINALIZE                   │
│                             ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                  PipelineFinalizeNode                       │   │
│  │  • Aggregate all step outputs                               │   │
│  │  • Compute final pipeline result                            │   │
│  │  • Cleanup resources                                        │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Type System Design

### 3.1 New Types (PipelineTypes.ts)

```typescript
// Pipeline step configuration (per-step in YAML)
export const PipelineStepConfigSchema = z.strictObject({
  /** Agent name to execute for this step */
  agent: z.string().min(1),

  /** Optional instruction override for this step */
  instruction: z.string().optional(),

  /** Optional model override for this step */
  model: z.string().optional(),

  /**
   * Data flow mode:
   * - true: Previous output becomes this step's INPUT_CONTENT
   * - false: Original input preserved, previous outputs in PIPELINE_* vars
   */
  chainOutputToInput: z.boolean().default(true),

  /** Optional step name for logging/display */
  name: z.string().optional(),

  /** Temperature override for this step */
  temperature: z.number().min(0).max(1).optional(),
});

export type PipelineStepConfig = z.infer<typeof PipelineStepConfigSchema>;

// Pipeline agent settings (extends workflow settings)
export const PipelineAgentSettingSchema = AgentWorkflowSettingSchema.extend({
  agentType: z.literal(AgentType.Pipeline),

  /** Ordered list of pipeline steps */
  steps: z.array(PipelineStepConfigSchema).min(1),

  /** Stop on first step failure (default: true) */
  stopOnFailure: z.boolean().default(true),
});

export type PipelineAgentSetting = z.infer<typeof PipelineAgentSettingSchema>;

// Runtime context passed to child agents
export interface PipelineContext {
  /** Zero-based current step index */
  stepIndex: number;

  /** Total number of steps */
  totalSteps: number;

  /** Current step configuration */
  currentStep: PipelineStepConfig;

  /** Results from previous steps (index → output) */
  previousOutputs: Map<number, PipelineStepOutput>;

  /** Original pipeline input (immutable) */
  originalInput: {
    content: string;
    file: string;
    instruction: string;
  };

  /** Pipeline execution ID */
  pipelineExecutionId: ExecutionId;
}

// Output from a single pipeline step
export interface PipelineStepOutput {
  stepIndex: number;
  agentName: string;
  outputFiles: string[];
  outputContent: string | null;
  xmlExports: AgentRuntimeXmlExports;
  success: boolean;
  error?: string;
}

// Complete pipeline execution result
export interface PipelineExecutionResult {
  steps: PipelineStepOutput[];
  finalOutput: PipelineStepOutput | null;
  success: boolean;
  completedSteps: number;
  totalSteps: number;
}
```

### 3.2 Pipeline User Variables

```typescript
// Extended variables available in pipeline prompts
interface PipelineUserVars extends UserVars {
  // Step metadata
  PIPELINE_STEP: number;           // Current step index (0-based)
  PIPELINE_STEP_NAME: string;      // Step name or "Step N"
  PIPELINE_TOTAL_STEPS: number;    // Total pipeline steps
  PIPELINE_CURRENT_AGENT: string;  // Current agent name

  // Original input (always available)
  ORIGINAL_INPUT_CONTENT: string;
  ORIGINAL_INPUT_FILE: string;
  ORIGINAL_INSTRUCTION: string;

  // Previous step outputs (chain mode context)
  PIPELINE_PREVIOUS_OUTPUT: string | null;      // Last step's output
  PIPELINE_PREVIOUS_OUTPUTS: string;            // XML-formatted all outputs
  PIPELINE_STEP_OUTPUTS: Record<number, string>; // Indexed outputs
}
```

---

## 4. Implementation Architecture

### 4.1 Class Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                        BaseAgent<C>                             │
│  (src/agent/implementations/BaseAgent.ts)                       │
├─────────────────────────────────────────────────────────────────┤
│  + modelHandler                                                 │
│  + agentConfig, agentSetting, agentPrompt                       │
│  + context: AgentExecutionContext                               │
│  + userVarChannels                                              │
│  + run(): abstract                                              │
└───────────────────────────────┬─────────────────────────────────┘
                                │
          ┌─────────────────────┴─────────────────────┐
          ▼                                           ▼
┌─────────────────────────┐             ┌─────────────────────────┐
│  BaseReflectionAgent<C> │             │    PipelineAgent<C>     │
│  (CoT, Direct, Merge)   │             │   (NEW - orchestrator)  │
├─────────────────────────┤             ├─────────────────────────┤
│  + roundStates[]        │             │  + steps: StepConfig[]  │
│  + workspaceStates[]    │             │  + stepOutputs[]        │
│  + outputHandler        │             │  + pipelineContext      │
│  + executeCurrentRound()│             │  + executeStep()        │
│  + run() [rounds flow]  │             │  + run() [steps flow]   │
└─────────────────────────┘             └─────────────────────────┘
```

### 4.2 PipelineAgent Implementation

```typescript
// src/agent/implementations/PipelineAgent.ts

export class PipelineAgent<C = unknown> extends BaseAgent<C> {
  protected pipelineSetting: PipelineAgentSetting;
  protected stepOutputs: PipelineStepOutput[] = [];
  protected pipelineContext: PipelineContext;

  constructor(
    modelHandler: IModelHandler<any, any, any, any, C>,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
    context: AgentExecutionContext,
  ) {
    super(modelHandler, agentConfig, agentSetting, agentPrompt, agentPath, context);
    this.pipelineSetting = requirePipelineSetting(agentSetting);

    this.pipelineContext = {
      stepIndex: 0,
      totalSteps: this.pipelineSetting.steps.length,
      currentStep: this.pipelineSetting.steps[0],
      previousOutputs: new Map(),
      originalInput: {
        content: '', // Populated in init
        file: agentConfig.inputFile,
        instruction: agentConfig.instruction,
      },
      pipelineExecutionId: context.executionId,
    };
  }

  public async run(): Promise<void> {
    const lifecycle = createLifecycleState<PipelineRunPhase>('idle');

    await this.executeAgentRunFlow<PipelineRunShared<C>>({
      lifecycle,
      createState: () => ({
        steps: this.pipelineSetting.steps,
        currentStep: 0,
        stepOutputs: [],
        continueSteps: true,
        pipelineContext: this.pipelineContext,
      }),
      createFlow: () => createPipelineRunFlow<C>(),
      extendHooks: (baseHooks) => ({
        ...baseHooks,
        init: async (runStage) => {
          await this.init(runStage, { createStage: true });
          // Load original input content
          this.pipelineContext.originalInput.content =
            await WorkspaceFS.read(this.agentConfig.inputFile);
        },
        createStepAgent: (stepConfig, inputOverride) =>
          this.createStepAgent(stepConfig, inputOverride),
        executeStep: (agent) => this.executeStepAgent(agent),
        onStepComplete: (stepIndex, output) => {
          this.stepOutputs[stepIndex] = output;
          this.pipelineContext.previousOutputs.set(stepIndex, output);
        },
        logStepSeparator: (stepIndex, agentName) =>
          this.logger.separator(`Step ${stepIndex + 1}: ${agentName}`),
      }),
    });
  }

  protected async createStepAgent(
    stepConfig: PipelineStepConfig,
    inputOverride?: string,
  ): Promise<IAgent> {
    // Compute effective input based on chain mode
    const effectiveInput = stepConfig.chainOutputToInput && inputOverride
      ? inputOverride
      : this.agentConfig.inputFile;

    // Build step-specific config
    const stepAgentConfig: Partial<AgentConfig> = {
      agent: stepConfig.agent,
      model: stepConfig.model ?? this.agentConfig.model,
      instruction: stepConfig.instruction ?? this.agentConfig.instruction,
      inputFile: effectiveInput,
      // Preserve other config fields
      referenceFile: this.agentConfig.referenceFile,
      auxiliaryFile: this.agentConfig.auxiliaryFile,
    };

    // Create child agent with pipeline context
    const { agent } = await prepareAgentInstance({
      agentName: stepConfig.agent,
      configPayload: stepAgentConfig,
      executionId: this.executionId,
      contextFactory: (init) => new AgentExecutionContext({
        ...init,
        // Pass pipeline context for variable injection
        pipelineContext: this.buildStepContext(stepConfig),
      }),
    });

    return agent;
  }

  protected buildStepContext(stepConfig: PipelineStepConfig): PipelineContext {
    return {
      ...this.pipelineContext,
      currentStep: stepConfig,
    };
  }
}
```

### 4.3 Pipeline Run Flow

```typescript
// src/agent/implementations/flows/PipelineRunFlow.ts

export const PIPELINE_RUN_PHASE = {
  IDLE: 'idle',
  INIT: 'init',
  STEPS: 'steps',
  FINALIZE: 'finalize',
} as const;

interface PipelineStepPrep<C> {
  agent: PipelineAgent<C>;
  stepConfig: PipelineStepConfig;
  stepIndex: number;
  shouldFinalize: boolean;
  previousOutput: string | null;
}

interface PipelineStepExec<C> extends PipelineStepPrep<C> {
  childAgent?: IAgent;
  stepOutput?: PipelineStepOutput;
  error?: unknown;
}

class PipelineStepNode<C> extends BaseNode<PipelineRunShared<C>> {
  async prep(shared: PipelineRunShared<C>): Promise<PipelineStepPrep<C>> {
    const { agent, state } = shared;
    const shouldFinalize =
      state.currentStep >= state.steps.length ||
      !state.continueSteps ||
      agent.isInterruptionRequested();

    const stepConfig = state.steps[state.currentStep];
    const previousOutput = state.currentStep > 0
      ? state.stepOutputs[state.currentStep - 1]?.outputContent ?? null
      : null;

    return {
      agent,
      stepConfig,
      stepIndex: state.currentStep,
      shouldFinalize,
      previousOutput,
    };
  }

  async exec(prepRes: PipelineStepPrep<C>): Promise<PipelineStepExec<C>> {
    if (prepRes.shouldFinalize) {
      return prepRes;
    }

    try {
      // Log step separator
      await shared.hooks.logStepSeparator(
        prepRes.stepIndex,
        prepRes.stepConfig.agent,
      );

      // Create child agent with appropriate input
      const inputFile = prepRes.stepConfig.chainOutputToInput && prepRes.previousOutput
        ? await this.writeTemporaryInput(prepRes.previousOutput, prepRes.stepIndex)
        : null;

      const childAgent = await shared.hooks.createStepAgent(
        prepRes.stepConfig,
        inputFile,
      );

      // Execute child agent
      await childAgent.run();

      // Capture output
      const stepOutput = await this.captureStepOutput(
        childAgent,
        prepRes.stepIndex,
        prepRes.stepConfig.agent,
      );

      return { ...prepRes, childAgent, stepOutput };
    } catch (error) {
      return { ...prepRes, error };
    }
  }

  async post(
    shared: PipelineRunShared<C>,
    prepRes: PipelineStepPrep<C>,
    execRes: PipelineStepExec<C>,
  ): Promise<string | undefined> {
    if (prepRes.shouldFinalize) {
      return FlowTransition.FINALIZE;
    }

    if (execRes.error) {
      if (shared.state.pipelineContext.stopOnFailure) {
        failLifecycle(shared.lifecycle, execRes.error);
        return FlowTransition.FINALIZE;
      }
      // Log error but continue
      shared.agent.logger.error(`Step ${prepRes.stepIndex} failed`, execRes.error);
    }

    if (execRes.stepOutput) {
      shared.hooks.onStepComplete(prepRes.stepIndex, execRes.stepOutput);
      shared.state.stepOutputs.push(execRes.stepOutput);
    }

    shared.state.currentStep += 1;

    if (shared.state.currentStep >= shared.state.steps.length) {
      return FlowTransition.FINALIZE;
    }

    return FlowTransition.CONTINUE;
  }
}

export function createPipelineRunFlow<C>(): Flow<PipelineRunShared<C>> {
  const stepNode = new PipelineStepNode<C>();
  const finalizeNode = createAgentFinalizeNode<PipelineRunShared<C>, EndGroupStatus>({
    finalizePhase: 'finalize',
    computeStatus: ({ lifecycle }) => (lifecycle.error ? 'error' : 'stopped'),
    runFinalize: async ({ hooks }, status) => await hooks.end(status),
    runCleanup: async ({ hooks }) => await hooks.cleanup(),
    onSuccess: ({ lifecycle }) => completeLifecycle(lifecycle),
  });

  return createAgentRunFlow<PipelineRunShared<C>>({
    init: {
      phase: 'init',
      onSuccess: (shared) => {
        beginLifecyclePhase(shared.lifecycle, 'steps');
        return FlowTransition.STEP;
      },
    },
    finalize: finalizeNode,
    links: ({ init }) => [
      { from: init, on: FlowTransition.STEP, to: stepNode },
      { from: stepNode, on: FlowTransition.CONTINUE, to: stepNode },
      { from: stepNode, on: FlowTransition.FINALIZE },
    ],
  });
}
```

---

## 5. User Variable Integration

### 5.1 Extended buildUserVars

```typescript
// src/agent/utils/userVars.ts

export async function buildUserVars(
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  agentPrompt: AgentPrompt,
  agentPath: string,
  modelHandler: IModelHandler,
  logger: AgentLogger,
  pipelineContext?: PipelineContext,  // NEW PARAMETER
): Promise<UserVars> {
  // ... existing variable building ...

  // Add pipeline-specific variables if in pipeline context
  if (pipelineContext) {
    Object.assign(userVars, buildPipelineVars(pipelineContext));
  }

  return userVars;
}

function buildPipelineVars(ctx: PipelineContext): UserVars {
  const vars: UserVars = {
    // Step metadata
    PIPELINE_STEP: ctx.stepIndex,
    PIPELINE_STEP_NAME: ctx.currentStep.name ?? `Step ${ctx.stepIndex + 1}`,
    PIPELINE_TOTAL_STEPS: ctx.totalSteps,
    PIPELINE_CURRENT_AGENT: ctx.currentStep.agent,
    IS_PIPELINE_STEP: true,

    // Original input (always available)
    ORIGINAL_INPUT_CONTENT: ctx.originalInput.content,
    ORIGINAL_INPUT_FILE: ctx.originalInput.file,
    ORIGINAL_INSTRUCTION: ctx.originalInput.instruction,
  };

  // Previous outputs
  if (ctx.previousOutputs.size > 0) {
    const lastOutput = ctx.previousOutputs.get(ctx.stepIndex - 1);
    vars.PIPELINE_PREVIOUS_OUTPUT = lastOutput?.outputContent ?? null;
    vars.PIPELINE_PREVIOUS_AGENT = lastOutput?.agentName ?? null;

    // All previous outputs as XML
    vars.PIPELINE_PREVIOUS_OUTPUTS = formatPreviousOutputsXml(ctx.previousOutputs);

    // Indexed access
    vars.PIPELINE_STEP_OUTPUTS = Object.fromEntries(
      Array.from(ctx.previousOutputs.entries())
        .map(([idx, out]) => [idx, out.outputContent])
    );
  }

  return vars;
}
```

---

## 6. YAML Configuration Examples

### 6.1 Derive-Criticize Pipeline

```yaml
# resources/agents/derive_criticize.yaml
name: derive_criticize
description: Derive interpretation then critically analyze it

settings:
  agentType: pipeline
  outputExt: tex

  steps:
    - agent: polish
      name: derive
      instruction: |
        Derive the core interpretation and meaning of this text.
        Focus on extracting the key arguments and supporting evidence.
      chainOutputToInput: true

    - agent: correct
      name: criticize
      instruction: |
        Critically analyze this interpretation:

        **Original Text:**
        {{ ORIGINAL_INPUT_CONTENT }}

        **Derived Interpretation:**
        {{ PIPELINE_PREVIOUS_OUTPUT }}

        Identify strengths, weaknesses, and gaps in the interpretation.
      chainOutputToInput: false  # Access both original and derived

prompts:
  systemPrompt: |
    You are a pipeline orchestrator for derive-then-criticize workflows.
  userPrefix: ""
  userRequest: ""  # Pipeline agents don't use traditional prompts
```

### 6.2 Polish-Proofread-Format Pipeline

```yaml
# resources/agents/polish_proofread_format.yaml
name: polish_proofread_format
description: Three-stage document improvement pipeline

settings:
  agentType: pipeline
  outputExt: tex
  stopOnFailure: true

  steps:
    - agent: polish
      name: polish
      temperature: 0.3
      chainOutputToInput: true

    - agent: correct
      name: proofread
      instruction: Focus on grammar, spelling, and punctuation
      chainOutputToInput: true

    - agent: correct
      name: format
      instruction: |
        Ensure consistent LaTeX formatting:
        - Proper spacing around equations
        - Consistent citation format
        - Clean section structure
      chainOutputToInput: true

prompts:
  systemPrompt: ""
  userPrefix: ""
  userRequest: ""
```

### 6.3 Multi-Perspective Analysis Pipeline

```yaml
# resources/agents/multi_perspective.yaml
name: multi_perspective
description: Analyze from multiple perspectives then synthesize

settings:
  agentType: pipeline
  outputExt: tex

  steps:
    - agent: polish
      name: technical_analysis
      instruction: Analyze from a technical/methodological perspective
      chainOutputToInput: false

    - agent: polish
      name: theoretical_analysis
      instruction: |
        Analyze from a theoretical perspective.

        For reference, here is the technical analysis:
        {{ PIPELINE_STEP_OUTPUTS.0 }}
      chainOutputToInput: false

    - agent: correct
      name: synthesis
      instruction: |
        Synthesize the following analyses into a coherent critique:

        **Technical Analysis:**
        {{ PIPELINE_STEP_OUTPUTS.0 }}

        **Theoretical Analysis:**
        {{ PIPELINE_STEP_OUTPUTS.1 }}

        **Original Document:**
        {{ ORIGINAL_INPUT_CONTENT }}
      chainOutputToInput: false

prompts:
  systemPrompt: ""
  userPrefix: ""
  userRequest: ""
```

---

## 7. Future Extensibility

### 7.1 Multi-Agent Patterns Roadmap

```
┌─────────────────────────────────────────────────────────────────┐
│                    Multi-Agent Evolution                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Phase 1: Pipeline (Sequential)     ◄── THIS PROPOSAL          │
│  ├── Chain mode                                                 │
│  ├── Accumulate mode                                            │
│  └── Step-level overrides                                       │
│                                                                 │
│  Phase 2: Parallel Execution                                    │
│  ├── ParallelBatchFlow integration                              │
│  ├── Fan-out/fan-in patterns                                    │
│  └── Concurrent agent execution                                 │
│                                                                 │
│  Phase 3: Conditional Branching                                 │
│  ├── Output-based routing                                       │
│  ├── Confidence thresholds                                      │
│  └── Dynamic agent selection                                    │
│                                                                 │
│  Phase 4: Hierarchical Agents                                   │
│  ├── Meta-agents that create sub-agents                         │
│  ├── Recursive decomposition                                    │
│  └── Dynamic pipeline construction                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Extension Points

The Pipeline architecture provides clean extension points:

1. **New Step Types**: Extend `PipelineStepConfigSchema` for conditional, parallel, or loop steps
2. **Custom Data Transforms**: Hook into `onStepComplete` for output transformations
3. **Dynamic Routing**: Override `post()` in `PipelineStepNode` for conditional branching
4. **Aggregation Patterns**: Add reducer functions for parallel step outputs

---

## 8. Implementation Phases

### Phase 1: Core Pipeline (MVP)
- [ ] Add `AgentType.Pipeline` to enum
- [ ] Create `PipelineTypes.ts` with schemas
- [ ] Implement `PipelineAgent` class
- [ ] Create `PipelineRunFlow` with step node
- [ ] Extend `buildUserVars` with pipeline context
- [ ] Add `derive_criticize.yaml` example

### Phase 2: Integration
- [ ] Update `getAgentClass()` factory
- [ ] Add pipeline to agent registry sources
- [ ] Implement step output file management
- [ ] Add UI separators between steps
- [ ] Test with existing agents as steps

### Phase 3: Polish
- [ ] Error recovery options (retry, skip, abort)
- [ ] Step-level progress tracking
- [ ] Pipeline execution history
- [ ] Documentation and examples

---

## 9. File Change Summary

### New Files
| File | Purpose |
|------|---------|
| `src/agent/core/PipelineTypes.ts` | Schemas and types |
| `src/agent/implementations/PipelineAgent.ts` | Main agent class |
| `src/agent/implementations/flows/PipelineRunFlow.ts` | Flow definition |
| `resources/agents/derive_criticize.yaml` | Example config |

### Modified Files
| File | Changes |
|------|---------|
| `src/agent/core/AgentDataclass.ts` | Add `AgentType.Pipeline` |
| `src/agent/implementations/index.ts` | Export `PipelineAgent` |
| `src/agent/runtime/executeAgent.ts` | Add pipeline to factory |
| `src/agent/utils/userVars.ts` | Add pipeline context param |
| `src/agent/runtime/AgentExecutionContext.ts` | Optional pipeline context |

---

## 10. Diagram: Complete Pipeline Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Pipeline Execution Flow                          │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  User Request                                                            │
│       │                                                                  │
│       ▼                                                                  │
│  ┌─────────────────┐                                                     │
│  │ executeAgent()  │ ◄── agent: "derive_criticize"                       │
│  └────────┬────────┘                                                     │
│           │                                                              │
│           ▼                                                              │
│  ┌─────────────────┐                                                     │
│  │ prepareAgent    │ ◄── Detects agentType: pipeline                     │
│  │ Instance()      │     Returns PipelineAgent                           │
│  └────────┬────────┘                                                     │
│           │                                                              │
│           ▼                                                              │
│  ┌─────────────────┐                                                     │
│  │ PipelineAgent   │                                                     │
│  │    .run()       │                                                     │
│  └────────┬────────┘                                                     │
│           │                                                              │
│           ▼                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    PipelineRunFlow                              │    │
│  ├─────────────────────────────────────────────────────────────────┤    │
│  │                                                                 │    │
│  │  ┌─────────────┐     ┌──────────────┐     ┌─────────────────┐  │    │
│  │  │  InitNode   │────►│  StepNode    │────►│  FinalizeNode   │  │    │
│  │  └─────────────┘     │  (loops)     │     └─────────────────┘  │    │
│  │                      └──────┬───────┘                          │    │
│  │                             │                                   │    │
│  │         ┌───────────────────┼───────────────────┐              │    │
│  │         ▼                   ▼                   ▼              │    │
│  │  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐       │    │
│  │  │  Step 0:    │     │  Step 1:    │     │  Step N:    │       │    │
│  │  │  "derive"   │     │  "critic"   │     │   ...       │       │    │
│  │  │  (polish)   │     │  (correct)  │     │             │       │    │
│  │  └──────┬──────┘     └──────┬──────┘     └─────────────┘       │    │
│  │         │                   │                                   │    │
│  │         ▼                   ▼                                   │    │
│  │  ┌─────────────┐     ┌─────────────┐                           │    │
│  │  │ Child Agent │     │ Child Agent │  ◄── Receives PIPELINE_*  │    │
│  │  │   .run()    │     │   .run()    │      variables in context │    │
│  │  └──────┬──────┘     └──────┬──────┘                           │    │
│  │         │                   │                                   │    │
│  │         ▼                   ▼                                   │    │
│  │  ┌─────────────┐     ┌─────────────┐                           │    │
│  │  │ Output:     │────►│ Output:     │                           │    │
│  │  │ derived.tex │     │ critique.tex│                           │    │
│  │  └─────────────┘     └─────────────┘                           │    │
│  │                                                                 │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Discussion Points

1. **Should pipelines support nested pipelines?** A pipeline step that references another pipeline agent could enable complex hierarchical workflows.

2. **Step parallelization**: Should we allow marking steps as parallelizable (e.g., `parallel: true`) for Phase 2?

3. **Output merging**: For accumulate mode, should we provide built-in merge strategies (concatenate, XML wrap, custom)?

4. **Retry semantics**: Individual step retries vs pipeline-level retry?

5. **Dynamic steps**: Should pipelines support Jinja2 conditionals in step lists (e.g., skip steps based on input content)?
