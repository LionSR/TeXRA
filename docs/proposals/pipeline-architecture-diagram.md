# Pipeline Agent Architecture Diagrams

## 1. High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              TeXRA Agent System                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │                           Agent Type Layer                                  │   │
│  ├─────────────────────────────────────────────────────────────────────────────┤   │
│  │                                                                             │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │   │
│  │  │    Direct    │  │     CoT      │  │   ToolUse    │  │   Pipeline   │    │   │
│  │  │    Agent     │  │    Agent     │  │    Agent     │  │    Agent     │    │   │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │   │
│  │         │                 │                 │                 │            │   │
│  │         └─────────────────┴─────────────────┴─────────────────┘            │   │
│  │                                     │                                       │   │
│  └─────────────────────────────────────┼───────────────────────────────────────┘   │
│                                        │                                           │
│  ┌─────────────────────────────────────┼───────────────────────────────────────┐   │
│  │                           Flow Layer (PocketFlow)                           │   │
│  ├─────────────────────────────────────┴───────────────────────────────────────┤   │
│  │                                                                             │   │
│  │  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────────┐   │   │
│  │  │ ReflectionRunFlow │  │  ToolUseRunFlow   │  │   PipelineRunFlow     │   │   │
│  │  │   (rounds-based)  │  │  (cycle-based)    │  │    (steps-based)      │   │   │
│  │  └─────────┬─────────┘  └─────────┬─────────┘  └───────────┬───────────┘   │   │
│  │            │                      │                        │               │   │
│  │            └──────────────────────┴────────────────────────┘               │   │
│  │                                   │                                         │   │
│  │                        ┌──────────┴──────────┐                              │   │
│  │                        │  BaseNode / Flow    │                              │   │
│  │                        │    Primitives       │                              │   │
│  │                        └─────────────────────┘                              │   │
│  │                                                                             │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Pipeline Agent Class Hierarchy

```
                    ┌─────────────────────────────────────┐
                    │           IAgent Interface          │
                    │  ─────────────────────────────────  │
                    │  + config: AgentConfig              │
                    │  + run(): Promise<void>             │
                    │  + interrupt(): void                │
                    │  + getExecutionContext()            │
                    └──────────────────┬──────────────────┘
                                       │
                                       │ implements
                                       ▼
                    ┌─────────────────────────────────────┐
                    │          BaseAgent<C>               │
                    │  ─────────────────────────────────  │
                    │  # modelHandler: IModelHandler      │
                    │  # agentConfig: AgentConfig         │
                    │  # agentSetting: AgentSetting       │
                    │  # context: AgentExecutionContext   │
                    │  # userVarChannels                  │
                    │  ─────────────────────────────────  │
                    │  + init(): Promise<void>            │
                    │  + run(): abstract                  │
                    │  # buildCycleBaseOptions()          │
                    │  # executeAgentRunFlow()            │
                    └──────────────────┬──────────────────┘
                                       │
               ┌───────────────────────┼───────────────────────┐
               │                       │                       │
               ▼                       ▼                       ▼
┌──────────────────────────┐ ┌──────────────────┐ ┌──────────────────────────┐
│  BaseReflectionAgent<C>  │ │ BaseToolUseAgent │ │     PipelineAgent<C>     │
│  ────────────────────────│ │  ──────────────  │ │  ──────────────────────  │
│  # roundStates[]         │ │  # activeState   │ │  # pipelineSetting       │
│  # workspaceStates[]     │ │  # toolRegistry  │ │  # stepOutputs[]         │
│  # outputHandler         │ │                  │ │  # pipelineContext       │
│  ────────────────────────│ │                  │ │  ──────────────────────  │
│  + beginRound()          │ │  + appendFollow  │ │  + createStepAgent()     │
│  + executeCurrentRound() │ │  + waitForFollow │ │  + executeStepAgent()    │
│  + recordRoundResult()   │ │                  │ │  + buildStepContext()    │
│  + run() [uses          │ │  + run() [uses   │ │  + run() [uses           │
│   ReflectionRunFlow]    │ │   ToolUseFlow]   │ │   PipelineRunFlow]       │
└──────────┬───────────────┘ └──────────────────┘ └──────────────────────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
┌──────────┐ ┌──────────┐
│ DirectAg │ │  CoTAg   │
│ (1 round)│ │ (N rnds) │
└──────────┘ └──────────┘
```

## 3. Pipeline Data Flow Patterns

### 3.1 Chain Mode (Sequential Transformation)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    Chain Mode: chainOutputToInput = true                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│     ORIGINAL                                                                    │
│     INPUT.tex                                                                   │
│         │                                                                       │
│         │  INPUT_CONTENT                                                        │
│         ▼                                                                       │
│    ┌─────────────┐        ┌─────────────┐        ┌─────────────┐               │
│    │   Step 0    │        │   Step 1    │        │   Step 2    │               │
│    │   polish    │        │  proofread  │        │   format    │               │
│    │             │        │             │        │             │               │
│    │ INPUT_CONTENT       │ INPUT_CONTENT       │ INPUT_CONTENT               │
│    │ = original  │        │ = step0.out │        │ = step1.out │               │
│    └──────┬──────┘        └──────┬──────┘        └──────┬──────┘               │
│           │                      │                      │                       │
│           ▼                      ▼                      ▼                       │
│    ┌─────────────┐        ┌─────────────┐        ┌─────────────┐               │
│    │ step0_out   │───────►│ step1_out   │───────►│ step2_out   │  = FINAL     │
│    │   .tex      │        │   .tex      │        │   .tex      │               │
│    └─────────────┘        └─────────────┘        └─────────────┘               │
│                                                                                 │
│    Each step receives the previous step's output as its input.                 │
│    Variables available:                                                         │
│      - INPUT_CONTENT: previous step output (or original for step 0)            │
│      - ORIGINAL_INPUT_CONTENT: always the original                             │
│      - PIPELINE_PREVIOUS_OUTPUT: same as INPUT_CONTENT                         │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Accumulate Mode (Reference Previous)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                  Accumulate Mode: chainOutputToInput = false                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│     ORIGINAL INPUT.tex                                                          │
│         │                                                                       │
│         │                                                                       │
│         ├──────────────────────┬──────────────────────┐                        │
│         │                      │                      │                        │
│         │  INPUT_CONTENT       │  INPUT_CONTENT       │  INPUT_CONTENT         │
│         │  = original          │  = original          │  = original            │
│         ▼                      ▼                      ▼                        │
│    ┌─────────────┐        ┌─────────────┐        ┌─────────────┐               │
│    │   Step 0    │        │   Step 1    │        │   Step 2    │               │
│    │   derive    │        │  critique   │        │  synthesize │               │
│    │             │        │             │        │             │               │
│    │ No previous │        │ Has access  │        │ Has access  │               │
│    │ outputs     │        │ to step 0   │        │ to 0 and 1  │               │
│    └──────┬──────┘        └──────┬──────┘        └──────┬──────┘               │
│           │                      │                      │                       │
│           ▼                      ▼                      ▼                       │
│    ┌─────────────┐        ┌─────────────┐        ┌─────────────┐               │
│    │ derive_out  │        │ critique_out│        │ synthesis   │               │
│    │   .tex      │        │   .tex      │        │   .tex      │               │
│    └──────┬──────┘        └──────┬──────┘        └─────────────┘               │
│           │                      │                                              │
│           │                      │                                              │
│           └──────────────────────┴─────────────────────────────────────────────►│
│                                                                                 │
│    Variables available in Step 2:                                               │
│      - INPUT_CONTENT: original input                                            │
│      - ORIGINAL_INPUT_CONTENT: original input                                   │
│      - PIPELINE_PREVIOUS_OUTPUT: step 1 output                                  │
│      - PIPELINE_STEP_OUTPUTS.0: step 0 output                                   │
│      - PIPELINE_STEP_OUTPUTS.1: step 1 output                                   │
│      - PIPELINE_PREVIOUS_OUTPUTS: XML of all previous outputs                   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 4. PocketFlow Node Execution Pattern

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      PocketFlow Node Lifecycle                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                           ┌─────────────────────────────────────────────┐      │
│                           │            Shared State                     │      │
│                           │  ─────────────────────────────────────────  │      │
│                           │  • agent: PipelineAgent                     │      │
│                           │  • state: { currentStep, stepOutputs, ... } │      │
│                           │  • lifecycle: { phase, status, error }      │      │
│                           │  • hooks: { init, end, cleanup, ... }       │      │
│                           └──────────────────┬──────────────────────────┘      │
│                                              │                                  │
│                                              ▼                                  │
│    ┌─────────────────────────────────────────────────────────────────────┐     │
│    │                     PipelineStepNode                                │     │
│    ├─────────────────────────────────────────────────────────────────────┤     │
│    │                                                                     │     │
│    │   ┌─────────────────────────────────────────────────────────────┐  │     │
│    │   │  1. PREP PHASE                                              │  │     │
│    │   │  ───────────────────────────────────────────────────────    │  │     │
│    │   │  Input:  shared (full state access)                         │  │     │
│    │   │  Output: PrepResult                                         │  │     │
│    │   │                                                             │  │     │
│    │   │  • Determine if should finalize                             │  │     │
│    │   │  • Get current step config                                  │  │     │
│    │   │  • Get previous output for chaining                         │  │     │
│    │   │  • Check for interruption                                   │  │     │
│    │   └─────────────────────────────────────────────────────────────┘  │     │
│    │                              │                                      │     │
│    │                              ▼                                      │     │
│    │   ┌─────────────────────────────────────────────────────────────┐  │     │
│    │   │  2. EXEC PHASE                                              │  │     │
│    │   │  ───────────────────────────────────────────────────────    │  │     │
│    │   │  Input:  PrepResult (from prep phase)                       │  │     │
│    │   │  Output: ExecResult                                         │  │     │
│    │   │                                                             │  │     │
│    │   │  • Create child agent with step config                      │  │     │
│    │   │  • Execute child agent: await agent.run()                   │  │     │
│    │   │  • Capture output files and content                         │  │     │
│    │   │  • Handle errors                                            │  │     │
│    │   └─────────────────────────────────────────────────────────────┘  │     │
│    │                              │                                      │     │
│    │                              ▼                                      │     │
│    │   ┌─────────────────────────────────────────────────────────────┐  │     │
│    │   │  3. POST PHASE                                              │  │     │
│    │   │  ───────────────────────────────────────────────────────    │  │     │
│    │   │  Input:  shared, PrepResult, ExecResult                     │  │     │
│    │   │  Output: Action (routing decision)                          │  │     │
│    │   │                                                             │  │     │
│    │   │  • Store step output in shared state                        │  │     │
│    │   │  • Increment step counter                                   │  │     │
│    │   │  • Return action:                                           │  │     │
│    │   │    - CONTINUE → next step                                   │  │     │
│    │   │    - FINALIZE → end pipeline                                │  │     │
│    │   └─────────────────────────────────────────────────────────────┘  │     │
│    │                                                                     │     │
│    └─────────────────────────────────────────────────────────────────────┘     │
│                                              │                                  │
│                              ┌───────────────┴───────────────┐                 │
│                              │                               │                 │
│                    ┌─────────┴─────────┐         ┌──────────┴──────────┐      │
│                    ▼                   ▼         ▼                     ▼      │
│              ┌─────────┐         ┌─────────┐   ┌─────────────────────────┐    │
│              │ CONTINUE│         │ FINALIZE│   │ Flow.getNextNode(action)│    │
│              │         │         │         │   │ routes to appropriate   │    │
│              │ → self  │         │ → final │   │ successor node          │    │
│              │  (loop) │         │   node  │   └─────────────────────────┘    │
│              └─────────┘         └─────────┘                                   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 5. Pipeline Run Flow State Machine

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        Pipeline Run Flow State Machine                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                              ┌─────────┐                                        │
│                              │  IDLE   │                                        │
│                              │         │                                        │
│                              └────┬────┘                                        │
│                                   │ run()                                       │
│                                   ▼                                             │
│                              ┌─────────┐                                        │
│                              │  INIT   │                                        │
│                              │         │                                        │
│                              │ • Load original input                            │
│                              │ • Build pipeline context                         │
│                              │ • Validate step configs                          │
│                              └────┬────┘                                        │
│                                   │ success                                     │
│                                   ▼                                             │
│    ┌──────────────────────────────────────────────────────────────────────┐    │
│    │                            STEPS                                     │    │
│    │  ────────────────────────────────────────────────────────────────── │    │
│    │                                                                      │    │
│    │       ┌─────────┐      ┌─────────┐      ┌─────────┐                 │    │
│    │       │ Step 0  │ ────►│ Step 1  │ ────►│ Step N  │                 │    │
│    │       │         │      │         │      │         │                 │    │
│    │       │ polish  │      │ correct │      │  ...    │                 │    │
│    │       └────┬────┘      └────┬────┘      └────┬────┘                 │    │
│    │            │                │                │                       │    │
│    │            │ CONTINUE       │ CONTINUE       │ last step             │    │
│    │            ▼                ▼                │ or error              │    │
│    │       [next step]      [next step]          │                       │    │
│    │                                              │                       │    │
│    │                                              │ FINALIZE              │    │
│    └──────────────────────────────────────────────┼───────────────────────┘    │
│                                                   │                             │
│                                                   ▼                             │
│                              ┌─────────────────────────────┐                   │
│                              │         FINALIZE            │                   │
│                              │                             │                   │
│                              │ • Aggregate step outputs    │                   │
│                              │ • Compute final result      │                   │
│                              │ • Cleanup resources         │                   │
│                              │ • Log completion            │                   │
│                              └─────────────────────────────┘                   │
│                                                                                 │
│    ════════════════════════════════════════════════════════════════════════    │
│                                                                                 │
│    Error Handling:                                                              │
│    ─────────────────                                                            │
│    stopOnFailure: true  → Step error → FINALIZE (with error)                   │
│    stopOnFailure: false → Step error → Log & CONTINUE to next step             │
│                                                                                 │
│    Interruption:                                                                │
│    ─────────────────                                                            │
│    User interrupt → Graceful stop → FINALIZE (with partial results)            │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 6. Variable Injection Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        Variable Injection Flow                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│    ┌─────────────────────────────────────────────────────────────────────────┐ │
│    │                        PipelineContext                                  │ │
│    │  ─────────────────────────────────────────────────────────────────────  │ │
│    │  stepIndex: 1                                                           │ │
│    │  totalSteps: 3                                                          │ │
│    │  currentStep: { agent: "correct", chainOutputToInput: false }           │ │
│    │  originalInput: { content: "...", file: "input.tex", instruction: "..." }│ │
│    │  previousOutputs: Map { 0 → { outputContent: "...", ... } }             │ │
│    └────────────────────────────────────┬────────────────────────────────────┘ │
│                                         │                                       │
│                                         ▼                                       │
│    ┌─────────────────────────────────────────────────────────────────────────┐ │
│    │                      buildUserVars()                                    │ │
│    │  ─────────────────────────────────────────────────────────────────────  │ │
│    │                                                                         │ │
│    │  Base Variables (from agentConfig):                                     │ │
│    │    MODEL, INSTRUCTION, INPUT_CONTENT, INPUT_FILE, ...                   │ │
│    │                                                                         │ │
│    │  + Pipeline Variables (from pipelineContext):                           │ │
│    │    PIPELINE_STEP: 1                                                     │ │
│    │    PIPELINE_STEP_NAME: "critique"                                       │ │
│    │    PIPELINE_TOTAL_STEPS: 3                                              │ │
│    │    PIPELINE_CURRENT_AGENT: "correct"                                    │ │
│    │    IS_PIPELINE_STEP: true                                               │ │
│    │    ORIGINAL_INPUT_CONTENT: "..."                                        │ │
│    │    ORIGINAL_INPUT_FILE: "input.tex"                                     │ │
│    │    ORIGINAL_INSTRUCTION: "..."                                          │ │
│    │    PIPELINE_PREVIOUS_OUTPUT: "... output from step 0 ..."               │ │
│    │    PIPELINE_PREVIOUS_OUTPUTS: "<outputs>...</outputs>"                  │ │
│    │    PIPELINE_STEP_OUTPUTS: { 0: "..." }                                  │ │
│    │                                                                         │ │
│    └────────────────────────────────────┬────────────────────────────────────┘ │
│                                         │                                       │
│                                         ▼                                       │
│    ┌─────────────────────────────────────────────────────────────────────────┐ │
│    │                       PromptBuilder                                     │ │
│    │  ─────────────────────────────────────────────────────────────────────  │ │
│    │                                                                         │ │
│    │  Template (from YAML):                                                  │ │
│    │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│    │  │  Analyze this interpretation critically:                        │   │ │
│    │  │                                                                 │   │ │
│    │  │  **Original:**                                                  │   │ │
│    │  │  {{ ORIGINAL_INPUT_CONTENT }}                                   │   │ │
│    │  │                                                                 │   │ │
│    │  │  **Interpretation (Step {{ PIPELINE_STEP - 1 }}):**             │   │ │
│    │  │  {{ PIPELINE_PREVIOUS_OUTPUT }}                                 │   │ │
│    │  └─────────────────────────────────────────────────────────────────┘   │ │
│    │                              │                                          │ │
│    │                              ▼ Jinja2 render                            │ │
│    │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│    │  │  Analyze this interpretation critically:                        │   │ │
│    │  │                                                                 │   │ │
│    │  │  **Original:**                                                  │   │ │
│    │  │  The quick brown fox jumps over the lazy dog...                 │   │ │
│    │  │                                                                 │   │ │
│    │  │  **Interpretation (Step 0):**                                   │   │ │
│    │  │  This text demonstrates pangram characteristics...              │   │ │
│    │  └─────────────────────────────────────────────────────────────────┘   │ │
│    │                                                                         │ │
│    └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 7. Future Multi-Agent Evolution

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        Multi-Agent Evolution Roadmap                            │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  PHASE 1: PIPELINE (Sequential)  ◄───── CURRENT PROPOSAL                       │
│  ═══════════════════════════════════════════════════════                       │
│                                                                                 │
│    INPUT ──► Agent₁ ──► Agent₂ ──► Agent₃ ──► OUTPUT                           │
│                                                                                 │
│    Features:                                                                    │
│    • Chain mode (output → input)                                                │
│    • Accumulate mode (all outputs accessible)                                   │
│    • Step-level config overrides                                                │
│                                                                                 │
│  ─────────────────────────────────────────────────────────────────────────────  │
│                                                                                 │
│  PHASE 2: PARALLEL (Fan-out/Fan-in)                                            │
│  ═══════════════════════════════════════════════════════                       │
│                                                                                 │
│              ┌──► Agent₁ ───┐                                                  │
│              │              │                                                  │
│    INPUT ────┼──► Agent₂ ───┼──► Reducer ──► OUTPUT                            │
│              │              │                                                  │
│              └──► Agent₃ ───┘                                                  │
│                                                                                 │
│    Features:                                                                    │
│    • ParallelBatchFlow integration                                              │
│    • Custom reducer functions                                                   │
│    • Concurrent execution                                                       │
│                                                                                 │
│  ─────────────────────────────────────────────────────────────────────────────  │
│                                                                                 │
│  PHASE 3: CONDITIONAL (Branching)                                              │
│  ═══════════════════════════════════════════════════════                       │
│                                                                                 │
│                     ┌──► Agent₂ ──► OUTPUT₁                                    │
│                     │                                                          │
│    INPUT ──► Agent₁ ┼──► Agent₃ ──► OUTPUT₂  (based on Agent₁ output)          │
│                     │                                                          │
│                     └──► Agent₄ ──► OUTPUT₃                                    │
│                                                                                 │
│    Features:                                                                    │
│    • Output-based routing                                                       │
│    • Confidence thresholds                                                      │
│    • Dynamic agent selection                                                    │
│                                                                                 │
│  ─────────────────────────────────────────────────────────────────────────────  │
│                                                                                 │
│  PHASE 4: HIERARCHICAL (Meta-Agents)                                           │
│  ═══════════════════════════════════════════════════════                       │
│                                                                                 │
│                    ┌─────────────────────────────────────┐                     │
│                    │           Meta-Agent                 │                     │
│                    │  ─────────────────────────────────  │                     │
│                    │  Analyzes task, creates sub-agents  │                     │
│                    └─────────────────┬───────────────────┘                     │
│                                      │                                          │
│              ┌───────────────────────┼───────────────────────┐                 │
│              ▼                       ▼                       ▼                 │
│        ┌─────────┐             ┌─────────┐             ┌─────────┐            │
│        │ Pipeline│             │ Parallel│             │  Single │            │
│        │  Agent  │             │  Agent  │             │  Agent  │            │
│        └─────────┘             └─────────┘             └─────────┘            │
│                                                                                 │
│    Features:                                                                    │
│    • Recursive decomposition                                                    │
│    • Dynamic pipeline construction                                              │
│    • Self-organizing agent networks                                             │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 8. Integration with Existing System

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        Integration Points                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                      executeAgent.ts                                    │   │
│  │  ─────────────────────────────────────────────────────────────────────  │   │
│  │                                                                         │   │
│  │  function getAgentClass(settings: AgentSetting): AgentConstructor {     │   │
│  │    const agentTypeMapping: Record<string, AgentConstructor> = {         │   │
│  │      direct: DirectAgent,                                               │   │
│  │      CoT: CoTAgent,                                                     │   │
│  │      toolUse: BaseToolUseAgent,                                         │   │
│  │      pipeline: PipelineAgent,  // ◄── NEW ENTRY                         │   │
│  │    };                                                                   │   │
│  │    return agentTypeMapping[settings.agentType] || DirectAgent;          │   │
│  │  }                                                                      │   │
│  │                                                                         │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                      AgentDataclass.ts                                  │   │
│  │  ─────────────────────────────────────────────────────────────────────  │   │
│  │                                                                         │   │
│  │  export enum AgentType {                                                │   │
│  │    CoT = 'CoT',                                                         │   │
│  │    Direct = 'direct',                                                   │   │
│  │    ToolUse = 'toolUse',                                                 │   │
│  │    Pipeline = 'pipeline',  // ◄── NEW ENTRY                             │   │
│  │  }                                                                      │   │
│  │                                                                         │   │
│  │  export const AgentSettingSchema = z.union([                            │   │
│  │    AgentWorkflowSettingSchema,                                          │   │
│  │    AgentToolUseSettingSchema,                                           │   │
│  │    PipelineAgentSettingSchema,  // ◄── NEW ENTRY (lazy import)          │   │
│  │  ]);                                                                    │   │
│  │                                                                         │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                      userVars.ts                                        │   │
│  │  ─────────────────────────────────────────────────────────────────────  │   │
│  │                                                                         │   │
│  │  export async function buildUserVars(                                   │   │
│  │    agentConfig: AgentConfig,                                            │   │
│  │    agentSetting: AgentSetting,                                          │   │
│  │    agentPrompt: AgentPrompt,                                            │   │
│  │    agentPath: string,                                                   │   │
│  │    modelHandler: IModelHandler,                                         │   │
│  │    logger: AgentLogger,                                                 │   │
│  │    pipelineContext?: PipelineContext,  // ◄── NEW PARAMETER             │   │
│  │  ): Promise<UserVars> {                                                 │   │
│  │    // ... existing logic ...                                            │   │
│  │                                                                         │   │
│  │    if (pipelineContext) {                                               │   │
│  │      Object.assign(userVars, buildPipelineVars(pipelineContext));       │   │
│  │    }                                                                    │   │
│  │                                                                         │   │
│  │    return userVars;                                                     │   │
│  │  }                                                                      │   │
│  │                                                                         │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                   AgentExecutionContext.ts                              │   │
│  │  ─────────────────────────────────────────────────────────────────────  │   │
│  │                                                                         │   │
│  │  export interface AgentExecutionContextInit {                           │   │
│  │    streamId: StreamTabId;                                               │   │
│  │    executionId?: ExecutionId;                                           │   │
│  │    agentCategory?: AgentCategory;                                       │   │
│  │    pipelineContext?: PipelineContext;  // ◄── NEW OPTIONAL FIELD        │   │
│  │  }                                                                      │   │
│  │                                                                         │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```
