# Data Structure Simplification Plan

This document outlines the implementation plan for simplifying and unifying data structures in the TeXRA codebase, based on the analysis in the Data Structure Resolution Analysis.

## Current State Analysis

### Usage Type Hierarchy

```
Provider SDK Types (Raw)
    │
    ▼ modelHandler.normalizeUsage()
NormalizedUsage (per-request, canonical)
    │
    ▼ RunUsageAccumulator.recordNormalizedUsage()
RunUsageTotals (accumulated totals)
    │
    ▼ UsageMonitor.recordUsage()
ExtendedTokenUsageStats (for logging/reporting)
    │
    ▼ AgentUsageReporter.report() - TRUNCATION HAPPENS HERE
TokenUsageStats (3 fields only for Progress View)
```

### Field Naming Inconsistencies

| Concept | NormalizedUsage | ExtendedTokenUsageStats | RunUsageTotals |
|---------|-----------------|------------------------|----------------|
| Cached input tokens | `cachedInputTokens` | `cacheReadInputTokens` | `totalCacheReadInputTokens` |
| Cache creation tokens | `cacheCreationTokens` | `cacheCreationInputTokens` | `totalCacheCreationInputTokens` |
| Time measurement | `responseTimeMs` (ms) | `elapsedTime` (seconds) | N/A |
| Tool usage tokens | `toolUsePromptTokens` | `toolUseTokens` | `totalToolUsePromptTokens` |
| Reasoning tokens | `reasoningTokens` | `reasoningTokens` | `totalReasoningTokens` |

---

## Priority 2: Unify ExtendedTokenUsageStats → NormalizedUsage ✅ IMPLEMENTED

### Problem
Two nearly-identical schemas exist with different field names, causing confusion and requiring manual mapping.

### Solution: Rename ExtendedTokenUsageStats fields to match NormalizedUsage

This is the minimal-change approach that preserves the distinct purposes (totals vs per-request) while fixing naming inconsistencies.

#### Files Modified

1. **`src/agent/types/UsageTypes.ts`** ✅
   - Renamed fields in `ExtendedTokenUsageStatsSchema`:
     - `cacheReadInputTokens` → `cachedInputTokens`
     - `cacheCreationInputTokens` → `cacheCreationTokens`
     - `elapsedTime` → `responseTimeMs` (unit changed from seconds to milliseconds)
     - `toolUseTokens` → `toolUsePromptTokens`

2. **`src/agent/utils/UsageMonitor.ts`** ✅
   - Updated payload construction to use new field names
   - Changed `elapsedTime` to `responseTimeMs` (value was already in ms!)

3. **`src/progressView/modules/formatters.js`** ✅
   - Added backward compatibility for both old and new field names
   - Converts `responseTimeMs` to seconds for display

4. **`src/test/logger/AgentUsageReporter.test.ts`** ✅
   - Updated test fixtures to use new field names

---

## Priority 3: Preserve NormalizedUsage in Progress View ✅ IMPLEMENTED

### Problem
The Progress View only receives `TokenUsageStats` (3 fields), losing all extended metrics like cached tokens, reasoning tokens, etc.

### Solution: Pass NormalizedUsage-like data to Progress View

Created a new `DisplayUsageStats` type that extends `TokenUsageStats` with optional extended fields. This type flows through the entire event chain from agent execution to the Progress View.

#### Files Modified

1. **`src/agent/types/UsageTypes.ts`** ✅
   - Created `DisplayUsageStatsSchema` with optional extended fields:
     - `cachedInputTokens`
     - `cacheCreationTokens`
     - `percentageCached`
     - `reasoningTokens`

2. **`src/eventBus/ProgressEventBus.ts`** ✅
   - Changed `updateStreamUsage` event type from `TokenUsageStats` to `DisplayUsageStats`

3. **`src/logger/AgentUsageReporter.ts`** ✅
   - Updated to pass extended fields in the event payload

4. **`src/progressView/events/UsageEvents.ts`** ✅
   - Updated to preserve and pass through extended fields

5. **`src/progressView/managers/UsageStatsManager.ts`** ✅
   - Updated to store `DisplayUsageStats` (now stores extended metrics)
   - Created `DisplayUsageStatsParsingSchema` with safe coercion for optional fields

6. **`src/progressView/managers/WebviewUpdater.ts`** ✅
   - Updated `updateRunUsage` method signature to use `DisplayUsageStats`

---

## Priority 4: Centralize Legacy Migration (FUTURE WORK)

### Problem
Migration logic is scattered across multiple files:
- `UsageStatsManager.ts:257` - `migrateLegacyRunUsage()`
- `OutputFilesManager.ts:495` - `migrateLegacyMissingOutputs()`

### Solution: Create MigrationService

> **Note:** This is documented for future work. The current migration logic works correctly.

#### New File: `src/progressView/persistence/MigrationService.ts`

```typescript
import { AgentLogger } from '@logger/AgentLogger';
import type { StateStorage } from './PersistentMapManager';

export interface MigrationResult {
  key: string;
  success: boolean;
  itemsMigrated: number;
}

export class MigrationService {
  private readonly logger: AgentLogger;

  constructor(private readonly storage: StateStorage) {
    this.logger = new AgentLogger('MigrationService');
  }

  /**
   * Run all migrations. Should be called once on extension activation.
   */
  async runAll(): Promise<MigrationResult[]> {
    const results: MigrationResult[] = [];

    results.push(await this.migrateRunUsage());
    results.push(await this.migrateMissingOutputs());
    // Add future migrations here

    return results;
  }

  private async migrateRunUsage(): Promise<MigrationResult> {
    // Move logic from UsageStatsManager.migrateLegacyRunUsage()
  }

  private async migrateMissingOutputs(): Promise<MigrationResult> {
    // Move logic from OutputFilesManager.migrateLegacyMissingOutputs()
  }
}
```

#### Files to Modify

1. **`src/progressView/managers/UsageStatsManager.ts`**:
   - Remove `migrateLegacyRunUsage()` method
   - Remove migration call from `load()`

2. **`src/progressView/managers/OutputFilesManager.ts`**:
   - Remove `migrateLegacyMissingOutputs()` method
   - Remove migration call from loading logic

3. **`src/extension.ts`** (or appropriate activation point):
   - Call `migrationService.runAll()` on activation

---

## Priority 5: Schema-Driven Serialization (DOCUMENTATION ONLY)

> **Note:** This section provides guidelines for future development. No code changes were made.

### Current Pattern

Each stateful class has:
1. A `*SnapshotSchema` defining serialization format
2. A `toJSON()` method that manually constructs the snapshot
3. A `fromJSON()` static method that manually parses

This leads to field duplication between schema and `toJSON()`.

### Recommended Pattern

For classes with simple field mappings, consider:

```typescript
// Schema defines the serialization format
export const MyStateSnapshotSchema = z.object({
  field1: z.string(),
  field2: z.number(),
});

export class MyState {
  field1: string;
  field2: number;

  // Derive toJSON from class properties
  toJSON(): z.infer<typeof MyStateSnapshotSchema> {
    // Use schema to validate output (catches missing fields at runtime)
    return MyStateSnapshotSchema.parse({
      field1: this.field1,
      field2: this.field2,
    });
  }

  static fromJSON(json: unknown): MyState {
    const parsed = MyStateSnapshotSchema.parse(json);
    const state = new MyState();
    state.field1 = parsed.field1;
    state.field2 = parsed.field2;
    return state;
  }
}
```

### When NOT to Use

- When performance is critical (parsing adds overhead)
- When class has computed/derived properties not in schema
- When class needs complex initialization logic

### Classes to Consider for This Pattern

| Class | Complexity | Recommendation |
|-------|------------|----------------|
| `ConversationRoundState` | Simple | Could benefit |
| `AgentRunState` | Contains nested object | Keep current |
| `RunUsageAccumulator` | Simple + nested array | Could benefit |
| `AgentSharedStore` | Complex composition | Keep current |
| `AgentWorkspaceState` | Complex nested | Keep current |

---

## Implementation Summary

| Priority | Status | Description |
|----------|--------|-------------|
| 2 | ✅ DONE | Unified field naming in `ExtendedTokenUsageStats` |
| 3 | ✅ DONE | Created `DisplayUsageStats`, extended event chain to preserve metrics |
| 4 | ⏳ Future | Centralize legacy migrations (documented for future work) |
| 5 | 📄 Docs | Schema-driven serialization pattern (documentation only) |

### Files Changed

- `src/agent/types/UsageTypes.ts` - New `DisplayUsageStats`, renamed fields
- `src/agent/utils/UsageMonitor.ts` - Use new field names
- `src/eventBus/ProgressEventBus.ts` - Use `DisplayUsageStats` in event
- `src/logger/AgentUsageReporter.ts` - Pass extended fields
- `src/progressView/events/UsageEvents.ts` - Preserve extended fields
- `src/progressView/managers/UsageStatsManager.ts` - Store `DisplayUsageStats`
- `src/progressView/managers/WebviewUpdater.ts` - Accept `DisplayUsageStats`
- `src/progressView/modules/formatters.js` - Backward compatible field handling
- `src/test/logger/AgentUsageReporter.test.ts` - Updated test fixtures

---

## Validation Checklist

- [x] TypeScript compiles without errors
- [x] Webpack build succeeds
- [x] Backward compatibility maintained in formatters.js
- [ ] Manual testing: verify usage statistics display correctly in Progress View
- [ ] Manual testing: verify logging output shows correct field names
