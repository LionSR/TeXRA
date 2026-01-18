# Type/Schema Migration Plan

This document outlines the findings from analyzing TypeScript interfaces and Zod schemas in the TeXRA codebase, with recommended migrations organized by priority.

## Executive Summary

| Category | Count | Action |
|----------|-------|--------|
| Interfaces needing schemas | 21 | Add Zod schemas |
| Dual definitions (interface + schema) | 4 | 1 to consolidate, 3 justified |
| Unsafe trust boundaries | 9 | Add validation |
| Dead/unused types | 6 | ✅ DELETED |
| Single-use exported types | 3 | ✅ REMOVED |
| Internal-only interfaces | 41 | No action needed |

---

## Zod v4 Patterns (Reference)

This project uses **Zod v4.3.5**. Use these idiomatic patterns when adding schemas:

```typescript
// ✅ Pre-validation default (replaces undefined BEFORE validation)
z.string().prefault('default value')

// ✅ Post-validation default (replaces undefined AFTER validation)
z.string().default('default value')

// ✅ Fallback on validation error
z.string().catch('fallback if parse fails')

// ✅ Nullable + optional shorthand
z.string().nullish()  // equivalent to .nullable().optional()

// ✅ Safe parsing with fallback (common pattern)
const result = SomeSchema.catch({ defaultField: 'value' }).parse(untrustedData)
```

**Tool schema pattern** (for LLM tool inputs):
```typescript
const ToolInputSchema = z.object({
  required_field: z.string(),
  optional_field: z.string().nullish(),        // accepts string | null | undefined
  with_default: z.string().prefault('auto'),   // uses 'auto' if undefined
});
```

---

## Priority 1: DELETE DEAD TYPES ✅ COMPLETED

~~These types are defined but never used anywhere.~~ **Deleted in commit `1f4c3a7`.**

| Type | File | Status |
|------|------|--------|
| `BetaToolUnionParam` | `src/tools/types.ts` | ✅ DELETED |
| `TextEditorToolParams` | `src/tools/types.ts` | ✅ DELETED |
| `FileHistoryEntry` | `src/tools/types.ts` | ✅ DELETED |
| `BaseError` | `src/tools/types.ts` | ✅ DELETED |
| `XMLValidationError` | `src/tools/types.ts` | ✅ DELETED |
| `ValidationResult` | `src/tools/types.ts` | ✅ DELETED |
| `LaTeXdiffMultipleResult` | `src/latex/latexdiff.ts` | KEEP (used internally) |
| `ExtractResult` | `src/latex/arxivProcessor.ts` | KEEP (used internally) |
| `ExtractOptions` | `src/latex/arxivProcessor.ts` | KEEP (used internally) |
| `ProxyConfig` | `src/agent/modelHandlers/support/ProxyConfigResolver.ts` | KEEP (used in ModelHandler.ts) |

### Single-Use Exports ✅ COMPLETED

| Type | File | Status |
|------|------|--------|
| `ConnectionResult` | `src/latex/textConnection.ts` | ✅ Removed from exports |
| `BibliographyReferenceResult` | `src/latex/extractBibliography.ts` | ✅ Removed from exports |
| `BibliographyEntriesResult` | `src/latex/extractBibliography.ts` | ✅ Removed from exports |

---

## Priority 2: CONSOLIDATE DUAL DEFINITIONS ✅ COMPLETED

### ✅ Consolidated in commit `1f4c3a7`

**`ModelRegistry` in `src/model/ModelConfig.ts`**

~~Current (anti-pattern):~~
```typescript
// OLD - manual type alias
export type ModelRegistry = Record<string, ModelConfig>;
```

✅ Fixed:
```typescript
// NEW - derived from schema (single source of truth)
export type ModelRegistry = z.infer<typeof ModelRegistrySchema>;
```

### Justified Dual Definitions (No Action)

| Type | Schema | File | Reason |
|------|--------|------|--------|
| `WorkflowTaskState` | `WorkflowTaskStateSchema` | `src/logger/TaskState.ts` | Intentional - types add discriminant refinements that passthrough() schemas don't capture |
| `ToolUseTaskState` | `ToolUseTaskStateSchema` | `src/logger/TaskState.ts` | Same as above |
| `ProviderMessage` | `ProviderMessageSchema` | `src/agent/modelHandlers/types/ProviderMessage.ts` | Correct pattern - external SDK types wrapped with z.custom<>() |

---

## Priority 3: ADD SCHEMA VALIDATION TO UNSAFE BOUNDARIES (High Risk)

### Critical - External API Responses

| Location | Issue | Fix |
|----------|-------|-----|
| `supabase/functions/auth-github/index.ts:179` | GitHub API user response unvalidated | Add `GitHubUserSchema` |
| `supabase/functions/auth-github/index.ts:186-191` | GitHub emails response unvalidated | Add `GitHubEmailSchema` |
| `src/agent/remote/RemoteAgentLoader.ts:237-243` | Remote agent API response destructured without validation | Add response schema |
| `src/auth/SupabaseAuthProvider.ts:589-591` | Error response accessed without validation | Add error response schema or use optional chaining |

### High - Stored Data

| Location | Issue | Fix |
|----------|-------|-----|
| `src/auth/SupabaseClient.ts:147` | `StoredSession` from VS Code secrets unvalidated | Add `StoredSessionSchema` |
| `src/utils/files/relativeFS.ts:30` | Generic `JSON.parse(raw) as T` | Accept Zod schema as parameter |

### Medium - Streaming Data

| Location | Issue | Fix |
|----------|-------|-----|
| `src/agent/modelHandlers/support/AnthropicStreamHandler.ts:300` | Streaming JSON parsed with type assertion | Add schema for search query format |

### Low Risk (Has Error Handling)

These locations have try/catch or fallback handling, making them lower priority:
- `src/agent/modelHandlers/modelHandlerOpenAI.ts:1232`
- `src/agent/modelHandlers/modelHandlerOpenAIResponse.ts:1572`
- `src/agent/core/flows/ToolUseCycleFlow.ts:78`

---

## Priority 4: ADD SCHEMAS TO ORPHAN INTERFACES (Medium Risk)

These interfaces receive external/untrusted data but lack Zod schemas.

### Serialized Storage

| Interface | File | Recommended Schema |
|-----------|------|-------------------|
| `AgentHistoryItem` | `src/common/history/AgentHistoryManager.ts` | `AgentHistoryItemSchema` for VS Code workspace storage |
| `FlowRecord` | `src/agent/node/persisted-flow.ts` | `FlowRecordSchema` for ExecutionKVStore |
| `SerializedError` | `src/utils/core/stringCore.ts` | `SerializedErrorSchema` for error transport |

### External LSP/Tool Responses

| Interface | File | Recommended Schema |
|-----------|------|-------------------|
| `PlainGoal` | `src/tools/lean/VscodeIntegration.ts` | `PlainGoalSchema` for Lean LSP response |
| `LspResult` | `src/tools/lean/VscodeIntegration.ts` | `LspResultSchema<T>` generic wrapper |
| `PlainTermGoal` | `src/tools/lean/VscodeIntegration.ts` | `PlainTermGoalSchema` for Lean term goal |

### User Approval Flow

| Interface | File | Recommended Schema |
|-----------|------|-------------------|
| `ToolEditApprovalRequest` | `src/tools/approval/toolEditApproval.ts` | `ToolEditApprovalRequestSchema` |
| `ToolEditApprovalResult` | `src/tools/approval/toolEditApproval.ts` | `ToolEditApprovalResultSchema` |

### Validation/Diagnostics (Tool Output)

| Interface | File | Recommended Schema |
|-----------|------|-------------------|
| `FormattedZodIssue` | `src/tools/result.ts` | `FormattedZodIssueSchema` |
| `ValidationErrorDiagnostics` | `src/tools/result.ts` | `ValidationErrorDiagnosticsSchema` |
| `DiagnosticsPayload` | `src/tools/result.ts` | `DiagnosticsPayloadSchema` |
| `ErrorDiagnostics` | `src/tools/result.ts` | `ErrorDiagnosticsSchema` |

### Event Payloads

| Interface | File | Recommended Schema |
|-----------|------|-------------------|
| `ProgressEventPayloads` | `src/eventBus/ProgressEventBus.ts` | Consider schemas for individual payload types |

---

## No Action Required (Internal-Only Interfaces)

These 41 interfaces are used only for internal type safety and don't require schemas:

<details>
<summary>Full list of internal-only interfaces</summary>

- `ReplacementCategory` - Static rule categories
- `ToolConfig` / `RunToolOptions` - Internal tool configuration
- `EventHandlerContext` - Handler context passing
- `RetryCallbacks` / `ApprovalCallbacks` / `AgentProposalCallbacks` / `UICallbacks` - UI callbacks
- `FileContext` - Derived from TaskState
- `GitignoreMatcher` - Functional interface
- `RecordingManagerConfig` - Internal config
- `AuthProvider` - Service interface
- `AgentEntry` / `ResolvedAgent` / `AgentOptionsPayload` - Internal registry
- `LatexDiffMetadata` - Derived from filename parsing
- `UsageMonitorMetadata` / `UsageMonitorModelInfo` / `UsageMonitorContext` - Internal tracking
- `MessageHandler` / `MessageHandlerOptions` / `PanelOptions` / `ModuleDescriptor` - Framework interfaces
- `SupabaseConfig` / `ExternalAuthCallbackInfo` - Static config
- `ProgressEventBusLike` - Service interface
- `LoadedFileEntry` / `ModelProviderFlags` - Internal derived types
- `RoundAwareState` / `RoundHookContext` / `RoundLifecycleHooks` / `RoundFlowConfig` - Framework abstractions
- `WriteApprovedContentResult` - Internal result type
- `WorkspacePathResolution` / `BuildFileAttachmentOptions` - Internal utilities
- `RepetitionResult` - Algorithm result
- `StepResult` - Internal return type
- `StateStorage` - Storage interface
- `DebugContext` / `FileOptions` / `SaveDebugParams` - Debug utilities
- `BibliographyReferenceResult` / `BibliographyEntriesResult` - Internal parsing
- `ApiProviderQuickPickItem` - VS Code UI extension
- `AgentVariantMetadata` - Internal metadata
- `RoundFileMapping` - Internal tracking
- `FileDialogOptions` / `FileSelectionResult` - UI framework
- `ActiveFileGuardOptions` / `ActiveFileGuardResult` / `LaTeXGuardOptions` - Editor guards
- `SeverityCounts` - Internal tallies
- `FollowupInstructionVars` - Template variables

</details>

---

## Implementation Order

1. **Week 1**: Delete dead types and remove unnecessary exports (Priority 1)
2. **Week 2**: Consolidate `ModelRegistry` dual definition (Priority 2)
3. **Week 3**: Add schemas to critical external API boundaries (Priority 3 - Critical)
4. **Week 4**: Add schemas to stored data boundaries (Priority 3 - High)
5. **Ongoing**: Add schemas to orphan interfaces as files are touched (Priority 4)

---

## Testing Strategy

For each schema addition:
1. Add the schema with `.safeParse()` initially
2. Add unit tests with valid and invalid data
3. Monitor for parsing failures in development
4. Convert to `.parse()` once stable

For type deletions:
1. Verify no imports exist: `grep -r "import.*TypeName" src/`
2. Run full test suite
3. Delete type and re-run tests
