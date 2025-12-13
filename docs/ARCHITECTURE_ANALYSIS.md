# TeXRA Architecture Analysis: SSOT & SoC Improvements

## Executive Summary

This document provides a deep analysis of Single Source of Truth (SSOT) and Separation of Concerns (SoC) issues in the TeXRA codebase, with prioritized recommendations for improving maintainability.

---

## Architecture Overview Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CURRENT ARCHITECTURE                                │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                         COMMANDS (src/commands/)                          │   │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐ │   │
│  │  │agent/       │ │latex/       │ │api/         │ │housekeeping/        │ │   │
│  │  │ ⚠ 18 agent  │ │ ⚠ Mixed     │ │ ⚠ Cascading │ │ ⚠ Business logic    │ │   │
│  │  │   imports   │ │   UI/logic  │ │   commands  │ │   in handlers       │ │   │
│  │  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘ └──────────┬──────────┘ │   │
│  └─────────┼───────────────┼───────────────┼───────────────────┼────────────┘   │
│            │               │               │                   │                 │
│            ▼               ▼               ▼                   ▼                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                           AGENT SYSTEM (src/agent/)                       │   │
│  │                                                                           │   │
│  │  ┌─────────────────────────────────────────────────────────────────────┐ │   │
│  │  │                     CORE (src/agent/core/)                          │ │   │
│  │  │  IAgent ◄── AgentConfig ◄── AgentState                              │ │   │
│  │  │             ⚠ DUAL SOURCE:                                          │ │   │
│  │  │             - agentType (legacy)                                    │ │   │
│  │  │             - session.agentType (current)                           │ │   │
│  │  └─────────────────────────────────────────────────────────────────────┘ │   │
│  │                                                                           │   │
│  │  ┌─────────────────────────────────────────────────────────────────────┐ │   │
│  │  │              IMPLEMENTATIONS (src/agent/implementations/)           │ │   │
│  │  │                                                                     │ │   │
│  │  │     BaseAgent (378 lines)                                           │ │   │
│  │  │         │                                                           │ │   │
│  │  │         ├── BaseReflectionAgent (933 lines) ⚠ GOD CLASS            │ │   │
│  │  │         │       ├── DirectAgent                                     │ │   │
│  │  │         │       ├── CoTAgent      ⚠ handleOutput() duplication     │ │   │
│  │  │         │       └── MergeAgent                                      │ │   │
│  │  │         │                                                           │ │   │
│  │  │         └── BaseToolUseAgent                                        │ │   │
│  │  │                 └── 10 files coordinating session ⚠ FRAGMENTED     │ │   │
│  │  └─────────────────────────────────────────────────────────────────────┘ │   │
│  │                                                                           │   │
│  │  ┌─────────────────────────────────────────────────────────────────────┐ │   │
│  │  │                MODEL HANDLERS (src/agent/modelHandlers/)            │ │   │
│  │  │                                                                     │ │   │
│  │  │     ModelHandler<M,U,R,T,C,Resp> (abstract)                         │ │   │
│  │  │         ⚠ 16 ABSTRACT METHODS - too many concerns                  │ │   │
│  │  │         │                                                           │ │   │
│  │  │         ├── ModelHandlerOpenAI (1399 lines)                         │ │   │
│  │  │         │       ├── ModelHandlerKimi                                │ │   │
│  │  │         │       ├── ModelHandlerDeepSeek                            │ │   │
│  │  │         │       └── ModelHandlerXAI                                 │ │   │
│  │  │         │                                                           │ │   │
│  │  │         ├── ModelHandlerAnthropic (1940 lines)                      │ │   │
│  │  │         │                                                           │ │   │
│  │  │         └── ModelHandlerGoogleGenAI (1400 lines)                    │ │   │
│  │  │                                                                     │ │   │
│  │  │         ⚠ DUPLICATED: normalizeUsage() across all handlers         │ │   │
│  │  └─────────────────────────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                         MODEL SYSTEM (src/model/)                         │   │
│  │                                                                           │   │
│  │  ModelConfig.ts ─────────────────── ModelRegistry.ts                     │   │
│  │  ⚠ NO ZOD SCHEMA                    ⚠ NO CONFLICT DETECTION             │   │
│  │  (violates CLAUDE.md)                                                     │   │
│  │                                      ┌────────────────────────────────┐  │   │
│  │                                      │ 11 Provider Files              │  │   │
│  │                                      │ ⚠ CRITICAL: gemini25f         │  │   │
│  │                                      │    defined TWICE               │  │   │
│  │                                      │ ⚠ 1 missing `satisfies`       │  │   │
│  │                                      └────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                    SHARED CODE (common/utils/frontend/)                   │   │
│  │                                                                           │   │
│  │   src/common/              src/utils/              src/frontend/          │   │
│  │   ┌──────────┐             ┌──────────┐            ┌──────────┐          │   │
│  │   │state/    │◄────────────│config/   │            │agents/   │          │   │
│  │   │errors/   │             │files/    │ ⚠ 7+ FS   │files/    │          │   │
│  │   │webview/  │─────────────│system/   │   CLASSES  │latex/    │          │   │
│  │   │history/  │             │text/     │            │ui/       │          │   │
│  │   └────┬─────┘             └──────────┘            └────┬─────┘          │   │
│  │        │                                                │                 │   │
│  │        │     ⚠ DEPENDENCY VIOLATION                    │                 │   │
│  │        └───────────────────────────────────────────────►│                 │   │
│  │                common/webview/ imports @frontend                          │   │
│  │                                                                           │   │
│  │   ⚠ 3 COMPETING STATE SYSTEMS:                                           │   │
│  │   1. VS Code Memento (common/state/)                                      │   │
│  │   2. In-Memory Transient (utils/pendingStateManager)                      │   │
│  │   3. Persistent Maps (progressView/persistence/)                          │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Issue Categories

### Legend
- 🔴 **CRITICAL** - Data integrity/correctness issues
- 🟠 **HIGH** - Significant maintainability burden
- 🟡 **MEDIUM** - Code quality concerns
- ⚪ **LOW** - Minor improvements

---

## 1. Single Source of Truth (SSOT) Violations

### 🔴 CRITICAL: Duplicate Model Name

**Location:** `src/model/providers/googleModels.ts:71,91`

```typescript
// Line 71
gemini25f: {
    name: 'gemini25f',  // ← First definition
    ...
}

// Line 91
gemini25f0617: {
    name: 'gemini25f',  // ← DUPLICATE NAME (should be 'gemini25f0617')
    ...
}
```

**Impact:** 77 model keys but only 76 unique names. Model lookups by name are unreliable.

**Fix:** Change line 91 to `name: 'gemini25f0617'`

---

### 🟠 HIGH: No Zod Schema for ModelConfig

**Location:** `src/model/ModelConfig.ts:55-91`

```typescript
// CURRENT: Plain TypeScript interfaces
export interface ModelCapabilities { ... }
export interface ModelConfig { ... }

// SHOULD BE: Zod schema-first (per CLAUDE.md)
const ModelCapabilitiesSchema = z.object({
  supportsFunctionCalling: z.boolean(),
  ...
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;
```

**Impact:**
- No runtime validation when loading model configs
- Inconsistent with codebase guidelines (CLAUDE.md requires Zod SSOT)
- Type-only checking misses malformed data

---

### 🟠 HIGH: Registry Merging Without Conflict Detection

**Location:** `src/model/ModelRegistry.ts:30-42`

```typescript
export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  ...ANTHROPIC_MODELS,      // Could silently override
  ...OPENAI_MODELS,         // Could silently override
  ...GOOGLE_MODELS,         // ← gemini25f conflict here
  // ... 8 more spreads
};
```

**Impact:** Silent data loss when provider files have conflicting keys.

**Fix:** Add validation:
```typescript
function mergeWithConflictDetection(...providers: Record<string, ModelConfig>[]): Record<string, ModelConfig> {
  const result: Record<string, ModelConfig> = {};
  for (const provider of providers) {
    for (const [key, value] of Object.entries(provider)) {
      if (result[key]) {
        throw new Error(`Duplicate model key: ${key}`);
      }
      result[key] = value;
    }
  }
  return result;
}
```

---

### 🟡 MEDIUM: Dual AgentType Source

**Location:** `src/agent/core/AgentConfig.ts`

```typescript
const AgentConfigSchema = z.object({
  agentType: z.enum(AgentType).optional(),          // ← Legacy
  session: AgentSessionDescriptorSchema.optional(),  // ← Current SSOT
  // ...
}).transform((config) => ({
  ...config,
  session: resolveAgentSessionDescriptor(
    config.session?.agentType ?? config.agentType,  // ← Fallback chain
    config.session?.agentCategory,
  ),
}));
```

**Impact:** Two sources for agent classification; transform normalizes but legacy field remains.

**Fix:** Deprecate and remove `agentType` field after migration.

---

### 🟡 MEDIUM: Hardcoded Model References

**Locations:**
- `src/frontend/media/audio.ts:188` - hardcoded `'gpt4o'`
- `src/latex/textConnection.ts:101` - hardcoded `'gpt41'`
- `src/latex/textConnection.ts:152` - hardcoded `'sonnet37'`

**Fix:** Use configuration or constants from ModelRegistry.

---

## 2. Separation of Concerns (SoC) Violations

### 🟠 HIGH: God Class - BaseReflectionAgent

**Location:** `src/agent/implementations/BaseReflectionAgent.ts` (933 lines)

```
┌─────────────────────────────────────────────────────────────┐
│                   BaseReflectionAgent                        │
│                      (933 lines)                            │
├─────────────────────────────────────────────────────────────┤
│  ⚠ MIXED RESPONSIBILITIES:                                  │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐                   │
│  │ Round Loop      │  │ File I/O        │                   │
│  │ Orchestration   │  │ Management      │                   │
│  └─────────────────┘  └─────────────────┘                   │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐                   │
│  │ Output          │  │ Prompt          │                   │
│  │ Handling        │  │ Building        │                   │
│  └─────────────────┘  └─────────────────┘                   │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐                   │
│  │ Workspace       │  │ Hydration/      │                   │
│  │ State Mgmt      │  │ Persistence     │                   │
│  └─────────────────┘  └─────────────────┘                   │
│                                                             │
│  ┌─────────────────┐                                        │
│  │ Media           │                                        │
│  │ Handling        │                                        │
│  └─────────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
```

**Recommended Extraction:**
```
BaseReflectionAgent (orchestration only)
    │
    ├── RoundOrchestrator
    │       └── Manages round loop lifecycle
    │
    ├── OutputOrchestrator
    │       └── Handles output file management
    │
    ├── WorkspaceStateManager
    │       └── Tracks workspace file changes
    │
    └── HydrationManager
            └── Serialization/deserialization
```

---

### 🟠 HIGH: ModelHandler - Too Many Abstract Methods

**Location:** `src/agent/modelHandlers/ModelHandler.ts`

```
ModelHandler<M, U, R, T, C, Resp>
│
├── 16 ABSTRACT METHODS (mixed concerns):
│
│   RESPONSE HANDLING (4)
│   ├── createResponse()
│   ├── extractResponse()
│   ├── shouldContinue()
│   └── computePrice()
│
│   MESSAGE BUILDING (6)
│   ├── initializeMessages()
│   ├── createRoundMessages()
│   ├── addContinueMessageWithPrefill()
│   ├── addContinueMessageWithoutPrefill()
│   ├── updateMessageContentWithPrefill()
│   └── updateMessageContentWithoutPrefill()
│
│   TOOL HANDLING (3)
│   ├── extractToolCall()
│   ├── createToolUseFollowUpMessages()
│   └── createUserFollowUpMessages()
│
│   MEDIA/OTHER (3)
│   ├── createMediaContent()
│   ├── processThinkingBlock()
│   └── normalizeUsage()
```

**Recommended Refactoring:** Group by concern with composition:

```typescript
interface ResponseProcessor { ... }      // 4 methods
interface MessageBuilder { ... }         // 6 methods
interface ToolProcessor { ... }          // 3 methods
interface MediaProcessor { ... }         // 3 methods

class ModelHandler {
  constructor(
    private response: ResponseProcessor,
    private messages: MessageBuilder,
    private tools: ToolProcessor,
    private media: MediaProcessor
  ) {}
}
```

---

### 🟠 HIGH: Commands Embed Business Logic

**Location:** `src/commands/agent/agentCreatorCommands.ts` (191-324)

```
┌──────────────────────────────────────────────────────────┐
│              agentCreatorCommands.ts                      │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ⚠ EMBEDDED IN COMMAND HANDLER:                         │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ 145 lines of YAML templates                        │ │
│  │ (hardcoded agent definitions)                       │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Direct Anthropic API calls                          │ │
│  │ const anthropic = new Anthropic({ apiKey });       │ │
│  │ const response = await anthropic.messages.create() │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Agent YAML validation                               │ │
│  │ File system operations                              │ │
│  │ Configuration prompts                               │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Should Extract:**
- `AgentTemplateService` - Template management
- `AgentGeneratorService` - AI-based generation
- `AgentYamlValidator` - Validation logic

---

### 🟠 HIGH: Tool-Use Session Fragmentation

**Location:** `src/agent/toolUse/` (10+ coordinating files)

```
┌─────────────────────────────────────────────────────────────┐
│                TOOL-USE SESSION (Current)                    │
│                                                             │
│  ⚠ NO UNIFIED SESSION CONTEXT                              │
│                                                             │
│  ┌──────────────────┐    ┌──────────────────┐               │
│  │ToolUseSession    │    │ToolUseFollowUp   │               │
│  │  Lifecycle       │    │  Queue           │               │
│  │                  │    │                  │               │
│  │ - followUps      │    │ - messages       │               │
│  │ - store          │    │ - waitPromises   │               │
│  │ - persistence    │    │                  │               │
│  └────────┬─────────┘    └────────┬─────────┘               │
│           │                       │                         │
│  ┌────────▼─────────┐    ┌────────▼─────────┐               │
│  │ToolUseSnapshot   │    │ToolUseFollowUp   │               │
│  │  Store           │    │  Coordinator     │               │
│  └──────────────────┘    └──────────────────┘               │
│                                                             │
│  ┌──────────────────┐    ┌──────────────────┐               │
│  │AgentSharedStore  │    │StreamStatus      │               │
│  │  Registry        │    │  Service         │               │
│  └──────────────────┘    └──────────────────┘               │
└─────────────────────────────────────────────────────────────┘
```

**Recommended:** Introduce `ToolUseSessionContext`:

```typescript
interface ToolUseSessionContext {
  lifecycle: SessionLifecycle;
  persistence: SessionPersistence;
  followUps: FollowUpManager;
  status: StatusTracker;
}
```

---

### 🟠 HIGH: Extensive Dependency Direction Violations

The codebase has **significant layering violations** where lower-level modules import from higher-level modules, creating tight coupling and circular dependency risks.

#### Expected Layering (Top → Bottom)

```
┌─────────────────────────────────────────────────────────────────┐
│                    EXPECTED DEPENDENCY FLOW                      │
│                                                                  │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│   │  commands/  │  │  webview/   │  │progressView/│  TOP LAYER  │
│   │             │  │             │  │ historyView/│  (UI/Entry) │
│   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│          │                │                │                     │
│          ▼                ▼                ▼                     │
│   ┌───────────────────────────────────────────────────────────┐ │
│   │                      agent/                                │ │
│   │               (core business logic)                        │ │
│   └─────────────────────────┬─────────────────────────────────┘ │
│                             │                                    │
│          ┌──────────────────┼──────────────────┐                │
│          ▼                  ▼                  ▼                 │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│   │   model/    │    │   tools/    │    │   latex/    │         │
│   │             │    │             │    │             │         │
│   └──────┬──────┘    └──────┬──────┘    └──────┬──────┘         │
│          │                  │                  │                 │
│          ▼                  ▼                  ▼                 │
│   ┌───────────────────────────────────────────────────────────┐ │
│   │                     frontend/                              │ │
│   │              (extension-host services)                     │ │
│   └─────────────────────────┬─────────────────────────────────┘ │
│                             │                                    │
│                             ▼                                    │
│   ┌───────────────────────────────────────────────────────────┐ │
│   │                      common/                               │ │
│   │                 (shared backend code)                      │ │
│   └─────────────────────────┬─────────────────────────────────┘ │
│                             │                                    │
│                             ▼                                    │
│   ┌───────────────────────────────────────────────────────────┐ │
│   │           utils/ / logger/ / eventBus/                     │ │
│   │                 (pure utilities)                           │ │  BOTTOM
│   └───────────────────────────────────────────────────────────┘ │  LAYER
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

#### Violation Category 1: @agent imports @frontend (6 files)

| File | Import | Issue |
|------|--------|-------|
| `agent/index/agentRegistry.ts:26` | `@frontend/agents/AgentDirectoryManager` | Agent layer depends on frontend |
| `agent/runtime/executeAgent.ts:41` | `@frontend/ui/instruction` | Runtime depends on UI |
| `agent/modelHandlers/ModelHandler.ts:12` | `@frontend/secretManager` | Core handler needs secrets |
| `agent/output/OutputHandler.ts:17-18` | `@frontend/latex/openBuild`, `@frontend/ui/instruction` | Output depends on UI |
| `agent/utils/userVars.ts:13` | `@frontend/files/vars` | Agent utils depends on frontend |

**Impact:** Agent system cannot be tested or used without frontend. Creates hidden UI dependencies in business logic.

---

#### Violation Category 2: @model imports @frontend (1 file)

| File | Import | Issue |
|------|--------|-------|
| `model/computeModelOptions.ts:4` | `@frontend/secretManager` | Model config depends on secrets |

**Impact:** Model configuration cannot be computed without frontend initialization.

---

#### Violation Category 3: @common imports @frontend (1 file)

| File | Import | Issue |
|------|--------|-------|
| `common/webview/BaseViewContentProvider.ts:6` | `@frontend/webview/html` | Common depends on frontend |

**Impact:** Shared webview base class pulls in frontend-specific code.

---

#### Violation Category 4: @utils imports @frontend (1 file)

| File | Import | Issue |
|------|--------|-------|
| `utils/prompt/PromptBuilder.ts:4` | `@frontend/files/rules` | Utility depends on frontend file rules |

**Impact:** Prompt building cannot be done without frontend initialization.

---

#### Violation Category 5: @common imports @agent (3 files)

| File | Import | Issue |
|------|--------|-------|
| `common/constants/runIds.ts:14` | `@agent/types/IdentifierTypes` | Constants depend on agent types |
| `common/history/AgentHistoryManager.ts:5,7` | `@agent/core/AgentConfig`, `@agent/types/IdentifierTypes` | History manager depends on agent |

**Impact:** Common layer tightly coupled to agent layer.

---

#### Violation Category 6: @replacement imports @frontend (1 file)

| File | Import | Issue |
|------|--------|-------|
| `replacement/helpers.ts:5` | `@frontend/ui/messageUtils` | Just for `capitalize()` function |

**Impact:** Replacement engine pulls in UI utilities for a simple string function.

---

#### Violation Category 7: Circular Dependency - @agent ↔ @tools

```
┌─────────────────────────────────────────────────────────────────┐
│                    CIRCULAR DEPENDENCY                           │
│                                                                  │
│     ┌─────────────────────┐      ┌─────────────────────┐        │
│     │      @agent/        │◄─────│      @tools/        │        │
│     │                     │      │                     │        │
│     │  - core/ToolTypes   │      │  - registry.ts      │        │
│     │  - toolUse/*        │      │  - fileInteractions │        │
│     │  - types/*          │      │  - todo/TodoTool    │        │
│     │                     │─────►│  - core/base        │        │
│     │  Uses: getDefault   │      │  - approval/*       │        │
│     │    ToolRegistry()   │      │                     │        │
│     │  Uses: ToolFile     │      │  Uses: ITool,       │        │
│     │    Attachment       │      │    ToolDefinition,  │        │
│     └─────────────────────┘      │    toolResult       │        │
│                                  └─────────────────────┘        │
│                                                                  │
│  @agent imports from @tools:                                     │
│  - BaseToolUseAgent.ts:43 → getDefaultToolRegistry               │
│  - modelHandlerAnthropic.ts:64 → ToolFileAttachment              │
│  - modelHandlerOpenAI.ts:45 → ToolFileAttachment                 │
│  - ModelHandler.ts:22 → ToolFileAttachment                       │
│  - core/ToolTypes.ts:19 → ToolResult                             │
│  - core/flows/ToolUseCycleFlow.ts:41 → withToolEditApprovalCtx   │
│                                                                  │
│  @tools imports from @agent:                                     │
│  - registry.ts:2-3 → ITool, IToolRegistry, createToolRegistry    │
│  - fileInteractions.ts:2 → getCurrentToolFileInteractionContext  │
│  - todo/TodoTool.ts:13 → getCurrentToolFileInteractionContext    │
│  - core/base.ts:7-8 → ITool, ToolDefinition, toolResult          │
│  - approval/*.ts → StreamTabId, ExecutionId                      │
└─────────────────────────────────────────────────────────────────┘
```

**Impact:** Cannot load one module without the other. Affects tree-shaking, testing isolation, and build order.

---

#### Violation Category 8: @logger imports @agent (5 imports)

| File | Import | Issue |
|------|--------|-------|
| `logger/AgentUsageReporter.ts:2-4` | `@agent/types/*`, `@agent/core/AgentDataclass` | Logger depends on agent types |
| `logger/AgentLogger.ts:5` | `@agent/types/UsageTypes` | Logger depends on agent |
| `logger/streamUtils.ts:5-8` | `@agent/index`, `@agent/core/AgentDataclass`, `@agent/types/*` | Stream utils depend on agent |
| `logger/TaskState.ts:2` | `@agent/core/AgentConfig` | Task state depends on agent config |

**Impact:** Logger cannot function without agent system. Creates initialization order dependencies.

---

#### Violation Category 9: @eventBus imports @agent, @logger, @common

| File | Imports |
|------|---------|
| `eventBus/types.ts:5` | `@agent/types/IdentifierTypes` |
| `eventBus/ProgressEventBus.ts:5-11` | `@agent/*` (4 imports), `@common/*` (1), `@logger/*` (2) |

**Impact:** Event bus depends on multiple higher layers. Should only depend on utils.

---

#### Violation Category 10: @latex imports @agent (6 imports)

| File | Import | Issue |
|------|--------|-------|
| `latex/latexdiff.ts:8` | `@agent/output/types` | LaTeX diff depends on agent types |
| `latex/textConnection.ts:6-7` | `@agent/modelHandlers/*` | Text connection uses model handlers directly |
| `latex/LatexMediaManager.ts:5-6` | `@agent/core/*` | Media manager depends on agent core |
| `latex/latexdiff/diffCommandExecutor.ts:2` | `@agent/types/ResultTypes` | Diff executor depends on agent |

**Impact:** LaTeX processing cannot be extracted or tested without agent system.

---

#### Bidirectional Dependencies (common ↔ utils)

```
┌─────────────────────────────────────────────────────────────────┐
│                  BIDIRECTIONAL DEPENDENCY                        │
│                                                                  │
│     ┌─────────────────────┐      ┌─────────────────────┐        │
│     │      @common/       │◄─────│      @utils/        │        │
│     │                     │      │                     │        │
│     │  - errors/          │      │  - commandUtils.ts  │        │
│     │                     │─────►│  - xmlUtils.ts      │        │
│     │  Uses: getConfig,   │      │  - promptUtils.ts   │        │
│     │    extractError     │      │  - execUtils.ts     │        │
│     │                     │      │  - taskRunStorage   │        │
│     │  files/fileTypeUtils│      │  - fileMappingUtils │        │
│     │  errors/sdkError    │      │  - textEnhancement  │        │
│     └─────────────────────┘      └─────────────────────┘        │
│                                                                  │
│  @common imports from @utils:                                    │
│  - files/fileTypeUtils.ts:5 → getConfig                          │
│  - errors/sdkErrorUtils.ts:34 → extractErrorMessage, isObject    │
│                                                                  │
│  @utils imports from @common:                                    │
│  - commandUtils.ts:5 → showLoggedErrorMessage                    │
│  - xmlUtils.ts:7 → toErrorMessage                                │
│  - promptUtils.ts:11 → toErrorMessage                            │
│  - execUtils.ts:9 → toErrorMessage                               │
│  - taskRunStorage.ts:15 → toErrorMessage                         │
│  - fileMappingUtils.ts:5 → toErrorMessage                        │
│  - textEnhancementUtils.ts:9 → getSdkErrorMessage                │
└─────────────────────────────────────────────────────────────────┘
```

**Impact:** Cannot establish clear layer hierarchy. Both depend on each other.

---

#### Summary: Dependency Violation Counts

| Source Module | Violating Imports | Severity |
|---------------|-------------------|----------|
| `@agent → @frontend` | 6 files | 🟠 HIGH |
| `@agent ↔ @tools` | 10+ files (circular) | 🔴 CRITICAL |
| `@logger → @agent` | 5 files | 🟠 HIGH |
| `@eventBus → @agent` | 5+ imports | 🟠 HIGH |
| `@latex → @agent` | 6 imports | 🟡 MEDIUM |
| `@common ↔ @utils` | 9 files (bidirectional) | 🟡 MEDIUM |
| `@model → @frontend` | 1 file | 🟡 MEDIUM |
| `@common → @frontend` | 1 file | 🟡 MEDIUM |
| `@utils → @frontend` | 1 file | 🟡 MEDIUM |
| `@replacement → @frontend` | 1 file | ⚪ LOW |
| `@common → @agent` | 3 files | 🟡 MEDIUM |

**Total Violations: 40+ import statements across 30+ files**

---

#### Recommended Fixes

1. **Extract shared types to `@shared/`** module that all layers can depend on (✅ DONE)
2. **Create `@core/` module** for shared interfaces (ITool, IAgent, etc.)
3. **Move `SecretManager` to `@common/`** or create `@secrets/` module
4. **Extract `capitalize()` to `@utils/text/`** (trivial fix)
5. **Split `@logger/` into:**
   - `@logger/core/` - no dependencies
   - `@logger/agent/` - agent-specific logging
6. **Resolve @agent ↔ @tools circular dependency:**
   - Move `ITool`, `ToolDefinition`, `ToolResult` to `@shared/tools` (✅ interfaces moved)
   - Tools should only depend on `@shared/`, not `@agent/`

---

### 🟡 MEDIUM: File System Abstraction Proliferation

**Location:** `src/utils/files/`

```
┌─────────────────────────────────────────────────────────┐
│                   7+ FS CLASSES                         │
│                                                         │
│     BaseFS (abstract)                                   │
│         │                                               │
│         ├── AbsoluteFS                                  │
│         │                                               │
│         └── RelativeFS (abstract)                       │
│                 │                                       │
│                 ├── WorkspaceFS                         │
│                 ├── StorageFS                           │
│                 └── GlobalStorageFS                     │
│                                                         │
│     FlexibleFS (separate, wraps others)                 │
│                                                         │
│  ⚠ ISSUE: Too many abstractions                        │
│  ⚠ Users must know which FS to use                     │
└─────────────────────────────────────────────────────────┘
```

**Recommended:** Reduce to 3-4 with clear factory:

```typescript
class FileSystemFactory {
  workspace(): IFileSystem;     // For project files
  storage(): IFileSystem;       // For extension storage
  absolute(): IFileSystem;      // For arbitrary paths
}
```

---

### 🟡 MEDIUM: Three Competing State Systems

```
┌─────────────────────────────────────────────────────────────┐
│                   STATE MANAGEMENT                           │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │ VS Code Memento │  │ In-Memory       │  │ Persistent   │ │
│  │ (common/state)  │  │ (utils/pending) │  │ Maps (pV)    │ │
│  ├─────────────────┤  ├─────────────────┤  ├──────────────┤ │
│  │ Persistent      │  │ Transient       │  │ Persistent   │ │
│  │ Workspace/      │  │ Lost on reload  │  │ Serialized   │ │
│  │ Global scope    │  │ Between commands│  │ Maps         │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
│                                                             │
│  ⚠ No coordination between systems                         │
│  ⚠ Initialization order matters                            │
│  ⚠ No dependency injection                                 │
└─────────────────────────────────────────────────────────────┘
```

**Recommended:** Consolidate under unified StateService:

```typescript
interface StateService {
  workspace: PersistentStore;   // VS Code memento
  session: TransientStore;      // In-memory
  maps: MapStore;               // Persistent maps
}
```

---

## 3. Code Duplication

### 🟡 MEDIUM: normalizeUsage() Duplication

**Locations:**
- `ModelHandlerOpenAI.ts:1004-1043`
- `ModelHandlerAnthropic.ts:1384-1450`
- `ModelHandlerGoogleGenAI.ts:861-920`

All implement identical logic:
1. Extract token counts
2. Calculate cached tokens
3. Compute pricing

**Fix:** Extract to utility:
```typescript
// src/agent/modelHandlers/utils/tokenCalculator.ts
function calculateNormalizedUsage(
  rawUsage: ProviderUsage,
  pricing: ModelPricing,
  tokenExtractor: TokenExtractor
): NormalizedUsage { ... }
```

---

### 🟡 MEDIUM: DirectAgent/CoTAgent handleOutput()

Both override `handleOutput()` with near-identical code, differing only in XML validation condition.

**Fix:** Strategy pattern:
```typescript
interface OutputValidationStrategy {
  validate(output: string): ValidationResult;
}

class XmlValidationStrategy implements OutputValidationStrategy { ... }
class NoValidationStrategy implements OutputValidationStrategy { ... }
```

---

## 4. Recommended Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            PROPOSED ARCHITECTURE                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                         COMMANDS (thin layer)                             │   │
│  │                                                                           │   │
│  │  Commands only handle:                                                    │   │
│  │  - Input validation (Zod schemas)                                         │   │
│  │  - Delegate to services                                                   │   │
│  │  - Return results                                                         │   │
│  └─────────────────────────────────────────────────────────────────────────┬─┘   │
│                                                                            │     │
│                                                                            ▼     │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                      SERVICES (NEW LAYER)                                 │   │
│  │                                                                           │   │
│  │  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐             │   │
│  │  │AgentExecution   │ │AgentGenerator   │ │ConfigValidator  │             │   │
│  │  │  Service        │ │  Service        │ │  Service        │             │   │
│  │  └─────────────────┘ └─────────────────┘ └─────────────────┘             │   │
│  │                                                                           │   │
│  │  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐             │   │
│  │  │UICoordinator    │ │EventBusAdapter  │ │StateService     │             │   │
│  │  │  Service        │ │  (typed events) │ │  (unified)      │             │   │
│  │  └─────────────────┘ └─────────────────┘ └─────────────────┘             │   │
│  └─────────────────────────────────────────────────────────────────────────┬─┘   │
│                                                                            │     │
│                                                                            ▼     │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                         AGENT SYSTEM                                      │   │
│  │                                                                           │   │
│  │  BaseAgent (lifecycle only)                                               │   │
│  │      │                                                                    │   │
│  │      ├── ReflectionAgentOrchestrator                                      │   │
│  │      │       ├── RoundOrchestrator                                        │   │
│  │      │       ├── OutputOrchestrator                                       │   │
│  │      │       └── HydrationManager                                         │   │
│  │      │                                                                    │   │
│  │      └── ToolUseSessionContext                                            │   │
│  │              ├── LifecycleManager                                         │   │
│  │              ├── PersistenceManager                                       │   │
│  │              └── FollowUpManager                                          │   │
│  │                                                                           │   │
│  │  ModelHandler (composition-based)                                         │   │
│  │      ├── ResponseProcessor                                                │   │
│  │      ├── MessageBuilder                                                   │   │
│  │      ├── ToolProcessor                                                    │   │
│  │      └── UsageCalculator (shared)                                         │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                         MODEL SYSTEM                                      │   │
│  │                                                                           │   │
│  │  ModelConfigSchema (Zod) ──► ModelConfig (type)                          │   │
│  │                                                                           │   │
│  │  ModelRegistry                                                            │   │
│  │      ├── validateUniqueness()                                             │   │
│  │      └── mergeProviders()                                                 │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                         CORE (consolidated)                               │   │
│  │                                                                           │   │
│  │  core/                                                                    │   │
│  │  ├── state/        (unified state management)                             │   │
│  │  ├── config/       (validated configuration)                              │   │
│  │  ├── errors/       (error pipeline)                                       │   │
│  │  └── files/        (3-4 FS abstractions)                                  │   │
│  │                                                                           │   │
│  │  utils/            (pure utilities)                                       │   │
│  │  ├── text/                                                                │   │
│  │  ├── system/                                                              │   │
│  │  └── prompt/                                                              │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Priority Action Items

### Immediate (Bug Fixes)

| Priority | Issue | Location | Action |
|----------|-------|----------|--------|
| 🔴 | Duplicate model name | `googleModels.ts:91` | Change to `'gemini25f0617'` |
| 🟠 | Missing `satisfies` | `openaiDeepResearchModels.ts` | Add type assertion |

### Short-Term (SSOT)

| Priority | Issue | Location | Action |
|----------|-------|----------|--------|
| 🟠 | No Zod for ModelConfig | `ModelConfig.ts` | Add Zod schemas |
| 🟠 | No conflict detection | `ModelRegistry.ts` | Add validation |
| 🟡 | Legacy agentType | `AgentConfig.ts` | Deprecate, remove |
| 🟡 | Hardcoded models | Various | Use constants |

### Medium-Term (SoC Extraction)

| Priority | Issue | Location | Action |
|----------|-------|----------|--------|
| 🟠 | God class | `BaseReflectionAgent.ts` | Extract orchestrators |
| 🟠 | Business in commands | `agentCreatorCommands.ts` | Extract services |
| 🟠 | Session fragmentation | `src/agent/toolUse/` | Create SessionContext |
| 🟡 | 16 abstract methods | `ModelHandler.ts` | Composition pattern |
| 🟡 | Dependency violation | `BaseViewContentProvider.ts` | Move or restructure |

### Long-Term (Architecture)

| Priority | Issue | Location | Action |
|----------|-------|----------|--------|
| 🟡 | 7+ FS classes | `src/utils/files/` | Reduce to 3-4 |
| 🟡 | 3 state systems | Various | Unified StateService |
| 🟡 | normalizeUsage() dup | Model handlers | Extract calculator |
| ⚪ | 30+ manager classes | Various | Audit and consolidate |

---

## 6. Metrics Summary

| Category | Current | Target |
|----------|---------|--------|
| SSOT Violations | 6 identified | 0 |
| SoC Violations | 8 major | 2-3 (acceptable) |
| God Classes (>500 lines) | 5 | 0 |
| Duplicate Code Patterns | 3 | 0 |
| FS Abstractions | 7+ | 3-4 |
| State Systems | 3 | 1 unified |
| **Dependency Violations** | **40+ imports across 30+ files** | **0** |
| Circular Dependencies | 1 critical (@agent ↔ @tools) | 0 |
| Upward Layer Violations | 10 categories | 0 |

---

## Appendix: File Reference

### Critical Files to Review

```
src/model/providers/googleModels.ts          # Fix duplicate name
src/model/ModelConfig.ts                      # Add Zod schema
src/model/ModelRegistry.ts                    # Add conflict detection
src/agent/implementations/BaseReflectionAgent.ts  # Refactor god class
src/agent/modelHandlers/ModelHandler.ts       # Reduce abstract methods
src/commands/agent/agentCreatorCommands.ts    # Extract services
src/common/webview/BaseViewContentProvider.ts # Fix dependency direction
```

### Files with Code Duplication

```
src/agent/modelHandlers/modelHandlerOpenAI.ts     # normalizeUsage
src/agent/modelHandlers/modelHandlerAnthropic.ts  # normalizeUsage
src/agent/modelHandlers/modelHandlerGoogleGenAI.ts # normalizeUsage
src/agent/implementations/DirectAgent.ts          # handleOutput
src/agent/implementations/CoTAgent.ts             # handleOutput
```

---

## 7. CLEAN SOLUTION: Minimal Changes to Fix Architecture

### Root Cause Analysis

The 40+ violations stem from **3 root causes**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    ROOT CAUSE BREAKDOWN                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ ROOT CAUSE 1: Shared Types in Wrong Layer (60% of issues)  ││
│  │                                                             ││
│  │ Types like StreamTabId, AgentType, ITool are defined in    ││
│  │ @agent but needed by @tools, @logger, @eventBus            ││
│  │                                                             ││
│  │ SOLUTION: Extract to @types/ (compile-time only change)    ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ ROOT CAUSE 2: Singleton Service Coupling (25% of issues)   ││
│  │                                                             ││
│  │ Services like SecretManager, agentDirectories are imported ││
│  │ directly instead of injected                                ││
│  │                                                             ││
│  │ SOLUTION: Dependency injection via interfaces              ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ ROOT CAUSE 3: UI Functions in Business Logic (15%)         ││
│  │                                                             ││
│  │ Functions like showInstructionWithSuppress called from     ││
│  │ agent runtime instead of command layer                      ││
│  │                                                             ││
│  │ SOLUTION: Callback interfaces for UI operations            ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

### Import Classification Matrix

| Import | Type | Runtime? | Violation? | Fix |
|--------|------|----------|------------|-----|
| `import type { StreamTabId }` | Type-only | No | **Safe** | Keep |
| `import { AgentType }` | Enum | Yes | **Mild** | Move to @types/ |
| `import { createToolRegistry }` | Factory | Yes | **Medium** | Move to @types/ |
| `import { SecretManager }` | Singleton | Yes | **Severe** | Inject |
| `import { showInstruction }` | UI Function | Yes | **Severe** | Callback |

---

### Phase 1: Create `@types/` Layer (Fixes 60% - ~24 violations)

**One-time setup that fixes most issues:**

```
NEW: src/types/
├── identifiers.ts      # StreamTabId, ExecutionId, StorageKey
├── agent.ts            # AgentType, AgentCategory, AgentSessionDescriptor
├── tools.ts            # ITool, IToolRegistry, ToolResult, ToolDefinition
├── usage.ts            # TokenUsageStats, ExtendedTokenUsageStats
├── output.ts           # OutputFileInfo, FileLocation
└── index.ts            # Barrel export
```

**What moves:**
```typescript
// FROM: src/agent/types/IdentifierTypes.ts
// TO:   src/types/identifiers.ts

// FROM: src/agent/core/AgentDataclass.ts (enums only)
// TO:   src/types/agent.ts

// FROM: src/agent/core/ToolTypes.ts (interfaces only)
// TO:   src/types/tools.ts

// FROM: src/agent/types/UsageTypes.ts
// TO:   src/types/usage.ts

// FROM: src/agent/output/types.ts
// TO:   src/types/output.ts
```

**tsconfig.json addition:**
```json
{
  "paths": {
    "@types/*": ["src/types/*"]  // Add this
  }
}
```

**Impact:** All `import type { ... } from '@agent/...'` become `import type { ... } from '@types/...'`

---

### Phase 2: Break Circular Dependency (Fixes @agent ↔ @tools)

**Current problem in `src/agent/core/ToolTypes.ts:19,28`:**
```typescript
import type { ToolResult as ToolResultType } from '@tools/result';  // ← Creates cycle
export { toolResult, cliResult, ToolError } from '@tools/result';   // ← Creates cycle
```

**Solution: Move interfaces UP, keep implementations DOWN**

```
BEFORE:                              AFTER:
@agent/core/ToolTypes.ts             @types/tools.ts
  ├── ITool (interface)        →       ├── ITool (interface)
  ├── IToolRegistry (interface)→       ├── IToolRegistry (interface)
  ├── ToolResult (re-export)   ✗       └── ToolResult (type only)
  └── toolResult() (re-export) ✗
                                     @tools/result.ts
@tools/core/base.ts                    └── toolResult() (stays here)
  └── imports ITool from @agent ✗
                                     @tools/core/base.ts
                                       └── imports ITool from @types ✓
```

**Result:** No more circular dependency. Types flow down, implementations stay in place.

---

### Phase 3: Dependency Injection for Singletons (Fixes 25% - ~10 violations)

#### 3.1 SecretManager

**Current (6 files import this):**
```typescript
// src/agent/modelHandlers/ModelHandler.ts:12
import { SecretManager } from '@frontend/secretManager';

// Used as:
const apiKey = await SecretManager.getApiKey(this.config.provider);
```

**Solution: Inject via config**
```typescript
// Add to AgentConfig or create ISecretProvider
export interface ISecretProvider {
  getApiKey(provider: ApiProvider): Promise<string | undefined>;
}

// ModelHandler constructor accepts it
class ModelHandler {
  constructor(
    private config: ModelConfig,
    private secrets: ISecretProvider  // ← Injected
  ) {}
}
```

#### 3.2 agentDirectories

**Current:**
```typescript
// src/agent/index/agentRegistry.ts:26
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
```

**Solution: Inject via initialization**
```typescript
// Create interface in @types/
export interface IAgentDirectories {
  builtIn(): Promise<string>;
  custom(): Promise<string>;
}

// Registry accepts it
export function initializeAgentRegistry(dirs: IAgentDirectories): void { ... }
```

---

### Phase 4: Callback Interfaces for UI (Fixes 15% - ~6 violations)

**Current (agent calls UI directly):**
```typescript
// src/agent/runtime/executeAgent.ts:41
import { showInstructionWithSuppress } from '@frontend/ui/instruction';

// src/agent/output/OutputHandler.ts:17-18
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
```

**Solution: UI callback interface**
```typescript
// src/types/callbacks.ts (NEW)
export interface IAgentUICallbacks {
  showInstruction(key: string, message: string): Promise<boolean>;
  openBuildDisplay(file: string): Promise<void>;
  showError(message: string): Promise<void>;
}

// Agent execution accepts callbacks
export interface AgentExecutionContext {
  config: AgentConfig;
  ui: IAgentUICallbacks;  // ← Injected by command layer
  secrets: ISecretProvider;
}
```

**Command layer provides implementation:**
```typescript
// src/commands/agent/executeCommand.ts
const uiCallbacks: IAgentUICallbacks = {
  showInstruction: showInstructionWithSuppress,
  openBuildDisplay: openBuildDisplayIfTex,
  showError: (msg) => vscode.window.showErrorMessage(msg),
};

await executeAgent({ config, ui: uiCallbacks, secrets: SecretManager });
```

---

### Clean Architecture After Changes

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLEAN ARCHITECTURE                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│   │  commands/  │  │  webview/   │  │progressView/│  ENTRY      │
│   │             │  │             │  │             │  POINTS     │
│   │ Provides:   │  │             │  │             │             │
│   │ - UI cbs    │  │             │  │             │             │
│   │ - Secrets   │  │             │  │             │             │
│   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│          │                │                │                     │
│          ▼                ▼                ▼                     │
│   ┌───────────────────────────────────────────────────────────┐ │
│   │                      @agent/                               │ │
│   │  Accepts: ISecretProvider, IAgentUICallbacks               │ │
│   │  Uses: @types/* for all shared types                       │ │
│   └─────────────────────────┬─────────────────────────────────┘ │
│                             │                                    │
│          ┌──────────────────┼──────────────────┐                │
│          ▼                  ▼                  ▼                 │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│   │   @model/   │    │   @tools/   │    │   @latex/   │         │
│   │             │    │             │    │             │         │
│   │ Uses:       │    │ Uses:       │    │ Uses:       │         │
│   │ @types/*    │    │ @types/*    │    │ @types/*    │         │
│   └──────┬──────┘    └──────┬──────┘    └──────┬──────┘         │
│          │                  │                  │                 │
│          ▼                  ▼                  ▼                 │
│   ┌───────────────────────────────────────────────────────────┐ │
│   │                      @types/                               │ │
│   │  Pure types, interfaces, enums - NO implementations       │ │
│   │  - identifiers.ts (StreamTabId, ExecutionId)              │ │
│   │  - agent.ts (AgentType, AgentCategory)                    │ │
│   │  - tools.ts (ITool, IToolRegistry, ToolResult type)       │ │
│   │  - callbacks.ts (ISecretProvider, IAgentUICallbacks)      │ │
│   └─────────────────────────┬─────────────────────────────────┘ │
│                             │                                    │
│                             ▼                                    │
│   ┌───────────────────────────────────────────────────────────┐ │
│   │              @utils/ @common/ @logger/                     │ │
│   │              (pure utilities, no @agent imports)           │ │
│   └───────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

DEPENDENCY RULE: All arrows point DOWN (inward)
- Upper layers can import from lower layers
- Lower layers NEVER import from upper layers
- @types/ is the foundation - imported by everyone
```

---

### Implementation Roadmap (Minimal Round-Trips)

| Phase | Files Changed | Violations Fixed | Effort | Status |
|-------|---------------|------------------|--------|--------|
| **1. Create @shared/** | 7 new + ~80 direct updates | 30+ (75%) | 3 hours | ✅ DONE |
| **2. Break @agent↔@tools cycle** | 4 files | 5 (12%) | 1 hour | ⏳ Pending |
| **3. Inject SecretManager** | 8 files | 4 (10%) | 1-2 hours | ⏳ Pending |
| **4. UI callback interface** | 6 files | 2 (3%) | 1-2 hours | ⏳ Pending |
| **Total** | ~100 files | 40+ violations | **6-8 hours** | |

> **Note:** Phase 1 was renamed from `@types/` to `@shared/` to avoid conflict with TypeScript's
> built-in `@types/*` package resolution (which caused TS6137 errors).

### Phase 1 Implementation Details (Completed - Direct Refactor)

**Files Created in `src/types/`:**
- `identifiers.ts` - StreamTabId, ExecutionId, StorageKey schemas
- `agent.ts` - AgentType, AgentCategory enums and derivation functions
- `tools.ts` - ITool, IToolRegistry interfaces, ToolResult schemas
- `usage.ts` - TokenUsageStats, ExtendedTokenUsageStats schemas
- `status.ts` - STREAM_STATUS constants and schemas
- `callbacks.ts` - ISecretProvider, IAgentUICallbacks interfaces
- `index.ts` - Barrel export

**Files Deleted (no re-exports - direct imports only):**
- `src/agent/types/IdentifierTypes.ts` ❌ DELETED
- `src/agent/types/UsageTypes.ts` ❌ DELETED
- `src/common/constants/streamStatus.ts` ❌ DELETED

**~80 Files Updated to Import Directly from @shared/:**
- `@shared/identifiers` - StreamTabId, ExecutionId, StorageKey
- `@shared/agent` - AgentType, AgentCategory, AgentSessionDescriptor
- `@shared/tools` - ITool, IToolRegistry, ToolResult, ToolDefinition
- `@shared/usage` - TokenUsageStats, ExtendedTokenUsageStats
- `@shared/status` - STREAM_STATUS, StreamStatus

**Config Files:**
```json
// tsconfig.json
"@shared/*": ["src/types/*"]

// webpack.config.js
'@shared': path.resolve(__dirname, 'src/types')
```

This establishes true SSOT - types defined once in @shared/, imported
directly everywhere, no intermediate re-export layers.

---

### Quick Wins (Can Do Immediately)

| Fix | Files | Time | Impact |
|-----|-------|------|--------|
| Move `capitalize()` to `@utils/text/` | 2 files | 5 min | Fixes @replacement→@frontend |
| Create `@types/identifiers.ts` | 1 new + 15 updates | 30 min | Fixes 15 violations |
| Add `ISecretProvider` interface | 1 new + 6 updates | 30 min | Decouples @agent from @frontend |

---

### Files to Create

```typescript
// src/types/identifiers.ts
export type StreamTabId = string & { readonly __brand: 'StreamTabId' };
export type ExecutionId = string & { readonly __brand: 'ExecutionId' };
export type StorageKey = string & { readonly __brand: 'StorageKey' };

// src/types/agent.ts
export enum AgentType { CoT = 'CoT', Direct = 'direct', ToolUse = 'toolUse' }
export enum AgentCategory { Workflow = 'workflow', ToolUse = 'toolUse' }

// src/types/tools.ts
export interface ITool { ... }
export interface IToolRegistry { ... }
export type ToolResult = { ... };

// src/types/callbacks.ts
export interface ISecretProvider {
  getApiKey(provider: string): Promise<string | undefined>;
}
export interface IAgentUICallbacks {
  showInstruction(key: string, message: string): Promise<boolean>;
  openBuildDisplay(file: string): Promise<void>;
}
```

### Files with Dependency Violations (by severity)

**🔴 CRITICAL - Circular Dependencies:**
```
src/agent/core/ToolTypes.ts              # imports @tools/result
src/agent/implementations/BaseToolUseAgent.ts  # imports @tools/registry
src/tools/registry.ts                    # imports @agent/core/ToolTypes
src/tools/core/base.ts                   # imports @agent/core/ToolTypes
```

**🟠 HIGH - Agent Layer Violations:**
```
src/agent/index/agentRegistry.ts         # imports @frontend/agents
src/agent/runtime/executeAgent.ts        # imports @frontend/ui
src/agent/modelHandlers/ModelHandler.ts  # imports @frontend/secretManager
src/agent/output/OutputHandler.ts        # imports @frontend/latex, @frontend/ui
src/agent/utils/userVars.ts              # imports @frontend/files
```

**🟠 HIGH - Logger/EventBus Violations:**
```
src/logger/AgentUsageReporter.ts         # imports @agent/types, @agent/core
src/logger/AgentLogger.ts                # imports @agent/types
src/logger/streamUtils.ts                # imports @agent/index, @agent/core
src/logger/TaskState.ts                  # imports @agent/core
src/eventBus/ProgressEventBus.ts         # imports @agent/*, @common/*, @logger/*
```

**🟡 MEDIUM - Other Violations:**
```
src/model/computeModelOptions.ts         # imports @frontend/secretManager
src/common/webview/BaseViewContentProvider.ts  # imports @frontend/webview
src/utils/prompt/PromptBuilder.ts        # imports @frontend/files
src/replacement/helpers.ts               # imports @frontend/ui (just for capitalize)
src/latex/textConnection.ts              # imports @agent/modelHandlers
src/latex/LatexMediaManager.ts           # imports @agent/core
```
