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

### 🟡 MEDIUM: Dependency Direction Violation

**Location:** `src/common/webview/BaseViewContentProvider.ts:6`

```typescript
// VIOLATION: common/ imports from frontend/
import { buildWebviewHtml } from '@frontend/webview/html';
```

```
                CORRECT LAYERING:
        ┌─────────────────────────────┐
        │        frontend/            │
        │   (extension-host specific) │
        └──────────────┬──────────────┘
                       │ imports
                       ▼
        ┌─────────────────────────────┐
        │         common/             │
        │    (shared backend code)    │
        └──────────────┬──────────────┘
                       │ imports
                       ▼
        ┌─────────────────────────────┐
        │          utils/             │
        │    (low-level utilities)    │
        └─────────────────────────────┘


                ACTUAL (VIOLATED):
        ┌─────────────────────────────┐
        │        frontend/            │
        └──────────────┬──────────────┘
                       ▲
                       │ WRONG DIRECTION
        ┌──────────────┴──────────────┐
        │         common/             │
        │ BaseViewContentProvider.ts  │
        └─────────────────────────────┘
```

**Fix:** Move `buildWebviewHtml` to `common/webview/` or move `BaseViewContentProvider` to `frontend/`.

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
| Dependency Violations | 1 | 0 |

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
