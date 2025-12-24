# Agent Separation Refactoring Plan

This document outlines the refactoring needed to prepare the agent architecture for a third category: **Multi-Agent Pipeline**.

## Current Architecture Assessment

### Strengths

| Area | Status | Details |
|------|--------|---------|
| Category Discrimination | ✅ Good | `AgentCategory` enum separates Workflow/ToolUse |
| Discriminated Schemas | ✅ Good | `AgentWorkflowSettingSchema` vs `AgentToolUseSettingSchema` |
| Flow Separation | ✅ Good | Separate flow files per category |
| Cycle Separation | ✅ Good | `ResponseCycle` vs `ToolUseCycle` |
| Zod Schema Usage | ✅ Good | Core types use schemas as single source of truth |
| Base Options | ✅ Good | `AgentCycleBaseOptions` shared across cycles |

### Issues

| Issue | Severity | Location | Impact on Pipeline |
|-------|----------|----------|-------------------|
| `AgentType` conflates pattern with category | High | `AgentDataclass.ts:15-19` | Cannot cleanly add pipeline types |
| Weak typing in `ToolUseRunStateSchema` | Medium | `runStateSchemas.ts:40-45` | Sets bad precedent |
| Conversation type inconsistency | Low | `ReflectionRunState` vs `ToolUseRunState` | Minor cleanup |
| Hook extension pattern not formalized | Medium | `ReflectionRunHooks`, `ToolUseRunHooks` | Need third extension |

---

## Refactoring Steps

### Phase 1: Type System Cleanup

#### 1.1 Split `AgentType` into Category + Pattern

**Current** (`AgentDataclass.ts`):
```typescript
export enum AgentType {
  CoT = 'CoT',
  Direct = 'direct',
  ToolUse = 'toolUse',
}
```

**Proposed**:
```typescript
// Agent category - which family of agent
export enum AgentCategory {
  Workflow = 'workflow',
  ToolUse = 'toolUse',
  Pipeline = 'pipeline',  // NEW
}

// Execution pattern - how the agent runs (optional, category-specific)
export const WorkflowPattern = {
  SingleRound: 'singleRound',  // was Direct
  MultiRound: 'multiRound',    // was CoT
} as const;

export const PipelinePattern = {
  Orchestrator: 'orchestrator',
  SubAgent: 'subAgent',
} as const;
```

**Migration**: Keep `AgentType` for backward compatibility, derive from category + pattern.

#### 1.2 Create Pipeline Setting Schema

```typescript
export const AgentPipelineSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z.literal(AgentCategory.Pipeline).prefault(AgentCategory.Pipeline),
  pipelinePattern: z.enum(['orchestrator', 'subAgent']).prefault('orchestrator'),
  subAgents: z.array(z.string()).prefault([]),
  orchestrationStrategy: z.enum(['sequential', 'parallel', 'conditional']).prefault('sequential'),
});

export const AgentSettingSchema = z.union([
  AgentWorkflowSettingSchema,
  AgentToolUseSettingSchema,
  AgentPipelineSettingSchema,  // NEW
]);
```

### Phase 2: Flow Architecture

#### 2.1 Create Base Flow Types for Pipeline

```
src/agent/implementations/flows/
├── common/
│   ├── types.ts              # AgentRunShared, AgentLifecycleState (existing)
│   ├── lifecycle.ts          # Lifecycle utilities (existing)
│   └── runStateSchemas.ts    # Add PipelineRunStateSchema
├── ReflectionRunFlow.ts      # Workflow (existing)
├── ToolUseRunFlow.ts         # ToolUse (existing)
└── PipelineRunFlow.ts        # Pipeline (NEW)
```

#### 2.2 Define Pipeline Run State Schema

```typescript
// In runStateSchemas.ts
export const PipelineRunStateSchema = BaseRunStateSchema.extend({
  orchestratorState: z.object({
    currentStep: z.number(),
    completedSubAgents: z.array(z.string()),
    pendingSubAgents: z.array(z.string()),
    aggregatedOutputs: z.record(z.string(), z.unknown()),
  }),
  subAgentSnapshots: z.record(z.string(), z.unknown()),
});
```

### Phase 3: Hook Interface Formalization

#### 3.1 Create Hook Category Interface Pattern

```typescript
// In types.ts - formalize the extension pattern
export interface AgentRunHooks {
  // Core lifecycle (required by all)
  start(): Promise<AgentLogStage | undefined>;
  init(runStage: AgentLogStage | undefined): Promise<void>;
  initializeClient(): Promise<void>;
  end(status: EndGroupStatus): void | Promise<void>;
  cleanup(): void | Promise<void>;
}

// Category-specific hooks use declaration merging pattern
export interface CategoryHooks {
  workflow: WorkflowHooks;
  toolUse: ToolUseHooks;
  pipeline: PipelineHooks;
}

export interface WorkflowHooks {
  resetPromptBuilder(): void;
}

export interface ToolUseHooks {
  prepareState(): Promise<PrepareStateResult>;
  buildCycleOptions(store: AgentSharedStore): ToolUseCycleOptions;
  runCycle(options: ToolUseCycleOptions, messages: ProviderMessage[], store: AgentSharedStore): Promise<void>;
  // ... etc
}

export interface PipelineHooks {
  resolveSubAgents(): Promise<SubAgentConfig[]>;
  executeSubAgent(config: SubAgentConfig, context: SubAgentContext): Promise<SubAgentResult>;
  aggregateResults(results: Map<string, SubAgentResult>): Promise<AggregatedOutput>;
}
```

### Phase 4: Fix Weak Typing

#### 4.1 Fix `ToolUseRunStateSchema`

```typescript
// Before
export const ToolUseRunStateSchema = BaseRunStateSchema.extend({
  cycleOptions: z.unknown().nullable(),  // ❌
  store: z.unknown().nullable(),          // ❌
});

// After - use proper schema references
export const ToolUseRunStateSchema = BaseRunStateSchema.extend({
  conversation: z.array(ProviderMessageSchema),
  cycleOptions: z.lazy(() => ToolUseCycleOptionsSchema).nullable(),
  store: z.lazy(() => AgentSharedStoreSnapshotSchema).nullable(),
  shouldSkipCycle: z.boolean(),
});
```

#### 4.2 Fix Conversation Type Consistency

```typescript
// In ReflectionRunState - change from any[] to typed
export interface ReflectionRunState {
  conversation: ProviderMessage[];  // was any[]
  runState: AgentRunState;
  totalRounds: number;
  currentRound: number;
  continueRounds: boolean;
}
```

---

## File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/agent/core/AgentDataclass.ts` | Modify | Add `Pipeline` category, refactor `AgentType` |
| `src/agent/core/flows/CycleServices.ts` | Modify | Add `PipelineCycleOptions` |
| `src/agent/implementations/flows/common/types.ts` | Modify | Formalize hook extension pattern |
| `src/agent/implementations/flows/common/runStateSchemas.ts` | Modify | Fix weak typing, add pipeline schema |
| `src/agent/implementations/flows/PipelineRunFlow.ts` | Create | Pipeline flow implementation |
| `src/agent/implementations/BasePipelineAgent.ts` | Create | Pipeline agent base class |
| `src/agent/core/PipelineCycle.ts` | Create | Pipeline cycle execution |

---

## Migration Strategy

1. **Backward Compatible**: Keep `AgentType` working for existing agents
2. **Opt-in**: New pipeline features are additive
3. **Gradual**: Migrate workflow agents to new pattern over time
4. **Schema Versioning**: Add version field to schemas if needed

---

## Testing Considerations

- Unit tests for new schemas with edge cases
- Integration tests for pipeline orchestration
- Backward compatibility tests for existing workflow/toolUse agents
- Snapshot tests for run state serialization

---

## Questions to Resolve

1. Should `AgentType` be deprecated or kept as a derived value?
2. How should sub-agents share context in a pipeline?
3. Should pipeline results aggregate into a single output or preserve per-agent outputs?
4. How to handle errors in one sub-agent affecting others in a pipeline?
