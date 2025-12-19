# Data Structure Design Analysis

Deep analysis of data structures with complex round-trip resolve/normalization logic, evaluating Zod-native patterns, single source of truth, and separation of concerns.

## Executive Summary

The codebase demonstrates **strong adherence** to Zod-native patterns and single source of truth principles in most areas. However, there are several design issues worth addressing:

| Issue | Severity | Location |
|-------|----------|----------|
| ToolDefinition schema/type divergence | **High** | `src/model/ToolDefinition.ts` |
| AgentSetting union not discriminated | **Medium** | `src/agent/core/AgentDataclass.ts` |
| RunUsageAccumulator partial schema workaround | **Medium** | `src/agent/core/RunUsageAccumulator.ts` |
| TokenUsageStats dual schemas | **Low** | `UsageTypes.ts` vs `UsageStatsManager.ts` |
| Legacy backward-compat relaxed strictness | **Low** | Multiple files |

---

## 1. ToolDefinition: Schema/Type Divergence (HIGH)

**Location**: `src/model/ToolDefinition.ts:26-66`

### Problem

The `ToolDefinition` type is **NOT** derived from `ToolDefinitionSchema` via `z.infer<>`, breaking the single source of truth principle:

```typescript
// Schema: validates serializable structure
export const ToolDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// Type: manually defined, adds provider-specific types
export type ToolDefinition = {
  name: string;
  description?: string;
  parameters?:
    | FunctionDefinition['parameters']        // OpenAI
    | AnthropicTool['input_schema']           // Anthropic
    | GeminiSchema;                           // Google
  zodSchema?: ZodType;  // Runtime-only, not in schema
};
```

### Why This is Problematic

1. **Dual maintenance**: Changes to one must be manually reflected in the other
2. **Type safety gap**: Schema validates `z.record(z.string(), z.unknown())` but type allows `FunctionDefinition['parameters']` - these may diverge
3. **Passthrough danger**: `.passthrough()` allows unknown properties, potentially masking bugs
4. **Cast required**: `resolveToolDefinitions()` must cast `parsed.data as ToolDefinition` (line 155)

### Root Cause

The comment explains the rationale:
> "This type is NOT derived from ToolDefinitionSchema via z.infer because:
> 1. `parameters` needs provider-specific types (OpenAI, Anthropic, Gemini)
> 2. `zodSchema` is a runtime-only field (ZodType can't be validated by Zod)"

### Recommended Solution

Use a **discriminated approach** with runtime-only type augmentation:

```typescript
// Base schema - single source of truth for serializable fields
export const ToolDefinitionSchema = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

// Serializable type (derived from schema)
export type SerializableToolDefinition = z.infer<typeof ToolDefinitionSchema>;

// Runtime type (extends serializable with provider-specific fields)
export type ToolDefinition = SerializableToolDefinition & {
  zodSchema?: ZodType;  // Explicitly runtime-only
};

// Compile-time assertion to ensure synchronization
type _AssertExtends = ToolDefinition extends SerializableToolDefinition ? true : never;
```

For provider-specific `parameters`, consider a union schema or accept the broader type and validate at conversion boundaries.

---

## 2. AgentSetting Union Not Discriminated (MEDIUM)

**Location**: `src/agent/core/AgentDataclass.ts:121-127`

### Problem

`AgentSettingSchema` uses `z.union()` instead of `z.discriminatedUnion()`:

```typescript
export const AgentSettingSchema = z.union([
  AgentWorkflowSettingSchema,
  AgentToolUseSettingSchema,
]);
```

The comment explains:
> "z.union (not discriminatedUnion) because input may lack agentCategory"

### Why This is Problematic

1. **Performance**: `z.union()` tries each schema in order until one matches; `z.discriminatedUnion()` uses O(1) field lookup
2. **Error messages**: Union errors are less precise than discriminated union errors
3. **Indicates design smell**: If input may lack the discriminator, the upstream data model is incomplete

### Root Cause

YAML agent definitions may omit `agentCategory`, relying on inference from `agentType`. The schema must accept both complete and incomplete input.

### Recommended Solution

Use `.transform()` to normalize before validation:

```typescript
// Pre-processor that ensures discriminator is present
const AgentSettingInputSchema = z.preprocess(
  (input) => {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      if (!obj.agentCategory) {
        obj.agentCategory = obj.agentType === 'toolUse'
          ? AgentCategory.ToolUse
          : AgentCategory.Workflow;
      }
    }
    return input;
  },
  z.discriminatedUnion('agentCategory', [
    AgentWorkflowSettingSchema,
    AgentToolUseSettingSchema,
  ])
);
```

This separates concerns: normalization happens explicitly before validation.

---

## 3. RunUsageAccumulator Partial Schema Workaround (MEDIUM)

**Location**: `src/agent/core/RunUsageAccumulator.ts:54-81`

### Problem

The schema uses `.partial().default({})` requiring manual default spreading:

```typescript
export const RunUsageAccumulatorJSONSchema = z.object({
  totals: RunUsageTotalsSchema.partial().default({}),
  normalizedSnapshots: z.array(NormalizedUsageSnapshotSchema).default([]),
});

static fromSnapshot(snapshot: unknown): RunUsageAccumulator {
  const parsed = RunUsageAccumulatorJSONSchema.parse(snapshot);
  const acc = new RunUsageAccumulator();
  // Manual workaround for .partial().default({}) behavior
  acc.totals = { ...DEFAULT_TOTALS, ...parsed.totals };
  // ...
}
```

### Why This is Problematic

1. **Violates DRY**: `DEFAULT_TOTALS` is defined twice (lines 11-21 and implicitly in schema field defaults)
2. **Subtle bug risk**: Schema field defaults only apply when the field key is missing from a non-partial object
3. **Requires comment**: The workaround needs explanation (lines 75-78)

### Root Cause

The schema needs to accept incomplete input (backward compatibility) while outputting complete data. `.partial().default({})` returns `{}` for missing input, not the individual field defaults.

### Recommended Solution

Use `.transform()` to merge defaults explicitly within the schema:

```typescript
export const RunUsageAccumulatorJSONSchema = z.object({
  totals: RunUsageTotalsSchema.partial()
    .default({})
    .transform((partial) => ({ ...DEFAULT_TOTALS, ...partial })),
  normalizedSnapshots: z.array(NormalizedUsageSnapshotSchema).default([]),
});

// Now fromSnapshot is simple:
static fromSnapshot(snapshot: unknown): RunUsageAccumulator {
  const parsed = RunUsageAccumulatorJSONSchema.parse(snapshot);
  const acc = new RunUsageAccumulator();
  acc.totals = parsed.totals;  // Already complete
  // ...
}
```

---

## 4. TokenUsageStats: Dual Schema Pattern (LOW)

**Location**:
- `src/agent/types/UsageTypes.ts:7-16` (canonical schema)
- `src/progressView/managers/UsageStatsManager.ts:20-34` (parsing schema)

### Problem

There are two schemas for the same logical type:

```typescript
// UsageTypes.ts - canonical, strict
export const TokenUsageStatsSchema = z.strictObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
});

// UsageStatsManager.ts - resilient, for parsing persisted data
const TokenUsageStatsParsingSchema = z
  .object({
    inputTokens: FiniteNumber,  // coerces non-finite to 0
    outputTokens: FiniteNumber,
    cost: FiniteNumber,
  })
  .catch({ inputTokens: 0, outputTokens: 0, cost: 0 });
```

### Assessment

This is **intentional and acceptable**:

1. **Separation of concerns**: Canonical schema for runtime, parsing schema for persistence
2. **Compile-time assertion**: Lines 36-41 verify type compatibility
3. **Different responsibilities**: Canonical validates, parsing schema recovers from corruption

### Recommendation

Document this pattern explicitly. Consider a utility function:

```typescript
/**
 * Creates a resilient parsing schema for persistence layer.
 * @param canonical - The strict schema for runtime validation
 * @param defaults - Fallback values if parsing fails entirely
 */
function createParsingSchema<T extends z.ZodTypeAny>(
  canonical: T,
  defaults: z.infer<T>
): z.ZodType<z.infer<T>> {
  // Implementation using coercion and .catch()
}
```

---

## 5. Relaxed Strictness for Backward Compatibility (LOW)

**Location**: Multiple files use `z.object()` instead of `z.strictObject()`:
- `src/agent/core/AgentSessionSchema.ts:15`
- `src/agent/core/AgentSharedStore.ts:45`
- `src/agent/core/AgentWorkspaceState.ts:458`
- `src/agent/toolUse/ToolUseSnapshotTypes.ts`

### Pattern

```typescript
/**
 * We use z.object() instead of z.strictObject() to remain backward compatible
 * with legacy snapshots that may contain removed or renamed fields.
 */
export const AgentSessionDescriptorSchema = z.object({
  agentType: z.enum(AgentType).optional(),
  agentCategory: z.enum(AgentCategory),
});
```

### Assessment

This is **pragmatic but has downsides**:

1. **Pros**: Allows evolution without migration scripts
2. **Cons**:
   - Silently ignores typos in field names
   - May mask bugs where old data is used
   - Accumulates cruft over time

### Recommendation

Add a **schema evolution strategy**:

```typescript
// Option 1: Track removed fields explicitly
const REMOVED_FIELDS = ['oldField1', 'oldField2'] as const;
export const AgentSessionDescriptorSchema = z.object({
  agentType: z.enum(AgentType).optional(),
  agentCategory: z.enum(AgentCategory),
}).passthrough()
  .transform((data) => {
    // Log warning for legacy fields
    const obj = data as Record<string, unknown>;
    for (const field of REMOVED_FIELDS) {
      if (field in obj) {
        console.warn(`Deprecated field '${field}' found in session descriptor`);
      }
    }
    return data;
  });

// Option 2: Migration version tracking
export const AgentSessionDescriptorSchema = z.object({
  _version: z.number().default(1),  // Schema version
  agentType: z.enum(AgentType).optional(),
  agentCategory: z.enum(AgentCategory),
});
```

---

## 6. Exemplary Patterns (What Works Well)

### 6.1 Snapshot Serialization Pattern

The `fromSnapshot()`/`toSnapshot()` pattern in state classes is excellent:

```typescript
// AgentState.ts - clean round-trip
export class ConversationRoundState {
  static fromSnapshot(snapshot: unknown): ConversationRoundState {
    const parsed = ConversationRoundStateSnapshotSchema.parse(snapshot);
    const state = new ConversationRoundState(parsed.roundIndex);
    state.continuationCount = parsed.continuationCount;
    // ...
    return state;
  }

  toSnapshot(): ConversationRoundStateSnapshot {
    return {
      roundIndex: this.roundIndex,
      continuationCount: this.continuationCount,
      // ...
    };
  }
}
```

**Why this works**:
- Schema is single source of truth
- Types derived via `z.output<>`
- Validation at deserialization boundary
- Class methods for domain logic

### 6.2 Discriminated Union with Factory Functions

`FileLocation` in `taskRunStorage.ts` is well-designed:

```typescript
export const FileLocationSchema = z.discriminatedUnion('kind', [
  WorkspaceFileLocationSchema,
  RunStorageFileLocationSchema,
  ExternalFileLocationSchema,
]);

export function createWorkspaceLocation(
  absolutePath: string,
  relativePath: string,
): WorkspaceFileLocation {
  return { kind: 'workspace', absolutePath, relativePath };
}
```

**Why this works**:
- Clear discriminator (`kind`)
- Type-safe factory functions
- Schema validates, factories construct

### 6.3 Schema Composition via `.extend()`

`NormalizedUsageSchema` properly extends its base:

```typescript
// UsageTypes.ts
export const TokenUsageStatsSchema = z.strictObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
});

// NormalizedUsage.ts
export const NormalizedUsageSchema = TokenUsageStatsSchema.extend({
  responseTimeMs: z.number(),
  provider: UsageProviderSchema,
  cachedInputTokens: z.number().optional(),
  // ...
});
```

**Why this works**:
- Base schema is reused, not duplicated
- Extensions are additive
- Type is derived from composed schema

### 6.4 Transform-Based Normalization

`AgentConfigSchema` handles legacy field migration cleanly:

```typescript
export const AgentConfigSchema = AgentConfigBaseSchema.transform((config) => {
  const descriptor = resolveAgentSessionDescriptor(
    config.session?.agentType ?? config.agentType,  // Legacy fallback
    config.session?.agentCategory,
  );

  return {
    ...config,
    agentType: descriptor.agentType,
    session: descriptor,
  };
});
```

**Why this works**:
- Legacy field (`agentType`) is normalized to canonical form (`session`)
- Transform is part of schema, not ad-hoc code
- Input/output types are distinct (`z.input<>` vs `z.output<>`)

---

## 7. Summary of Recommendations

| Priority | Issue | Recommendation |
|----------|-------|----------------|
| **P1** | ToolDefinition divergence | Derive type from schema; use runtime augmentation for non-serializable fields |
| **P2** | AgentSetting union | Use `z.preprocess()` to normalize discriminator before discriminated union |
| **P2** | RunUsageAccumulator partial | Move default spreading into `.transform()` within schema |
| **P3** | TokenUsageStats dual schemas | Document pattern; consider utility function |
| **P3** | Relaxed strictness | Add schema versioning or explicit removed-field tracking |

---

## 8. Architectural Observations

### What the Codebase Does Well

1. **Consistent snapshot pattern**: All stateful classes use `fromSnapshot()`/`toSnapshot()`
2. **Type derivation**: Most types use `z.infer<>` or `z.output<>` from schemas
3. **Schema composition**: Proper use of `.extend()`, `.pick()`, `.partial()`
4. **Normalization hubs**: Usage, config, and tool definitions have clear normalization points
5. **Compile-time assertions**: Type compatibility checks where schemas diverge

### Areas for Improvement

1. **Schema/type synchronization**: ToolDefinition is the primary violation
2. **Discriminated unions**: Could be used more consistently
3. **Schema evolution**: No formal versioning or migration strategy
4. **Documentation**: Some complex patterns lack explanatory comments

### Overall Assessment

The codebase demonstrates **mature Zod usage** with thoughtful separation of concerns. The issues identified are relatively minor and stem from pragmatic tradeoffs (backward compatibility, provider-specific types) rather than fundamental design flaws.

The recommended changes would improve type safety and maintainability without requiring architectural changes.
