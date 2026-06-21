---
created: 2026-01-26
updated: 2026-02-10
---

# PRD: MainView Modernization - Phase 7

> **Parent doc:** [2026-01-24-prd-progressview-modernization.md](./2026-01-24-prd-progressview-modernization.md)
> **Prior phase:** [2026-01-26-prd-progressview-phase6.md](./2026-01-26-prd-progressview-phase6.md)
> **Next phase:** [2026-01-26-prd-lit-native-phase8.md](./2026-01-26-prd-lit-native-phase8.md)

## Overview

Phase 7 focuses on **Zod-native type migration** across all webviews. The goal is schema-first design where Zod schemas are the single source of truth for all data contracts.

> **Status: ⬜ Not Started**

### Zod-Native Principles

1. **Schema is source of truth** - Define Zod schema first, derive TypeScript type via `z.infer<>`
2. **No duplicate interfaces** - Never define a TypeScript interface that duplicates a schema
3. **Validate at boundaries** - Use `.safeParse()` at all entry points (message handlers, state restore)
4. **Defaults via schema** - Use `.prefault()` (Zod v4) instead of separate DEFAULT constants
5. **Shared schemas** - All schemas in `src/shared/schemas/`, imported by both backend and frontend

### Scope

| Webview          | Current State                        | Work Needed                |
| ---------------- | ------------------------------------ | -------------------------- |
| **MainView**     | Standalone interfaces, no validation | Full migration             |
| **ProgressView** | ✅ Zod-native                        | Reference implementation   |
| **HistoryView**  | ✅ Mostly good                       | Minor cleanup              |
| **ProfileView**  | ✅ Mostly good                       | Minor cleanup              |
| **MemoryView**   | ✅ Mostly good                       | Remove duplicate interface |

### 7.1 Problem Statement

The main webview uses standalone TypeScript interfaces that aren't derived from Zod schemas, unlike progressView which follows the Zod-native pattern. This creates:

1. **No runtime validation** for persisted state restoration
2. **Type drift risk** between actual data and TypeScript types
3. **Inconsistency** with project patterns (CLAUDE.md mandates Zod as source of truth)
4. **MainApp.ts still at ~2,300 lines** - further decomposition needed

### 7.2 Pattern to Follow (from progressView)

```typescript
// Schema is single source of truth with .prefault() for defaults
export const StreamSessionStateSchema = z.object({
  hints: StreamHintsSchema.prefault({}),
  todos: z.array(TodoItemSchema).prefault([]),
  activeRunId: StorageKeySchema.nullable().prefault(null),
});

// Type derived from schema
type StreamSessionState = z.output<typeof StreamSessionStateSchema>;
```

### 7.3 Interfaces to Migrate (~25 types)

#### Priority 1: State Schemas (enables runtime validation)

| Interface                | File                 | Fields    |
| ------------------------ | -------------------- | --------- |
| `MainViewPersistedState` | MainApp.ts:90-123    | 23 fields |
| `BannerState`            | MainApp.ts:125-132   | 5 fields  |
| `ApiKeyBannerState`      | BannerGroup.ts:18-22 | 3 fields  |
| `AgentConfigBannerState` | BannerGroup.ts:25-29 | 3 fields  |
| `DependencyBannerState`  | BannerGroup.ts:32-35 | 2 fields  |

#### Priority 2: Event Detail Types (14 interfaces in events.ts + 5 in InstructionPanel.ts)

| Interface                         | Current Location                  |
| --------------------------------- | --------------------------------- |
| `FileSelectChangeDetail`          | events.ts                         |
| `BaseFileChangeDetail`            | events.ts                         |
| `CheckboxChangeDetail`            | events.ts                         |
| `BannerActionDetail`              | events.ts                         |
| `LatexDiffsActionDetail`          | events.ts                         |
| `SessionTypeChangeDetail`         | InstructionPanel.ts → consolidate |
| `AgentChangeDetail`               | InstructionPanel.ts → consolidate |
| ... (19 total event detail types) |                                   |

#### Priority 3: Configuration Types

| Interface          | File               | Fields    |
| ------------------ | ------------------ | --------- |
| `FileSelectConfig` | FileSelectGroup.ts | 12 fields |
| `CheckboxValues`   | FileSelectGroup.ts | 5 fields  |

### 7.4 Shared Schema Contract

**Problem:** Backend, frontend, and persistence must agree on data shapes. Currently the contract is too loose.

#### Current State (Investigation Findings)

**Backend sends state with no validation:**

```typescript
// src/shared/schemas/commonViewMessages.ts:17-22
export const StateRestoreMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.STATE_RESTORE),
  state: z.record(z.string(), z.unknown()).nullish(), // ← NO TYPE VALIDATION
  executeImmediately: z.boolean().nullish(),
});
```

**Frontend receives with unsafe cast:**

```typescript
// src/webview/frontend/MainApp.ts:1117
const state = message.state as Record<string, unknown>; // ← UNSAFE CAST
```

**Legacy field support creates confusion:**

```typescript
// MainApp.ts:1172-1180 - determineSessionType()
state.agentCategory ?? state.sessionType; // Which is canonical?

// MainApp.ts:1213-1220 - restoreFileArrays()
state[`${key}Active`] ?? state[`${key}Visible`]; // Which is canonical?
```

#### Specific Type Drift Risks

| Risk                | Location                   | Issue                                                       |
| ------------------- | -------------------------- | ----------------------------------------------------------- |
| Schema too loose    | `commonViewMessages.ts:19` | `state: z.record(z.string(), z.unknown())` accepts ANY keys |
| No shape validation | `MainApp.ts:1117`          | Cast `as Record<string, unknown>` without parsing           |
| Legacy field names  | `MainApp.ts:1172-1180`     | Supports both `agentCategory` and `sessionType`             |
| No agent validation | `MainApp.ts:1187-1197`     | Agent names not validated against available options         |
| No enum validation  | `MainApp.ts:1172-1180`     | Session type accepts any string, not `SESSION_TYPES` enum   |

#### Solution

`src/shared/schemas/` is the **single source of truth** for all data contracts:

```
src/shared/schemas/
├── index.ts                      # Single barrel export - ALL schemas
├── mainViewState.ts              # NEW: MainViewPersistedState schema
├── mainViewMessages.ts           # EXISTS: Update StateRestoreMessage
├── progressViewMessages.ts       # EXISTS: Already well-typed
└── historyViewMessages.ts        # EXISTS: Already well-typed
```

**Key changes:**

1. Create `MainViewPersistedStateSchema` with all 26 fields typed
2. Update `StateRestoreMessageSchema` to use typed state: `state: MainViewPersistedStateSchema.nullish()`
3. Frontend uses `.safeParse()` instead of `as` cast
4. Remove legacy field support (or document migration path)

**Contract enforcement:**

- Backend validates before sending: `MainViewPersistedStateSchema.parse(state)`
- Frontend validates on restore: `MainViewPersistedStateSchema.safeParse(raw)`
- Both sides get compile-time type safety via `z.infer<>`

### 7.4.1 Cross-Webview Message Contracts

**Investigation Finding:** Cross-webview messages are already well-organized - no duplication.

#### Current Organization (Good)

| Location                                     | Purpose                              | Status                      |
| -------------------------------------------- | ------------------------------------ | --------------------------- |
| `src/shared/schemas/progressViewMessages.ts` | Backend → ProgressView (30+ schemas) | ✅ Uses discriminated union |
| `src/shared/schemas/historyViewMessages.ts`  | Backend → HistoryView                | ✅ Well-typed               |
| `src/shared/schemas/mainViewMessages.ts`     | Backend → MainView (40+ types)       | ✅ Well-typed               |
| `src/webview/types/messages.ts`              | Frontend → Backend                   | ✅ Validated with Zod       |
| `src/common/webview/commands.ts`             | Command constants                    | ✅ Single source of truth   |

#### Communication Flows (All Through Extension Host)

```
ProgressView → Extension Host → MainView
  Example: Follow-up task setup
  - Sender: progressView/frontend/eventHandlers.ts (SETUP_FOLLOWUP)
  - Receiver: ProgressViewMessageHandler.handleSetupFollowup()
  - Cross-webview: executeCommand('texra.restoreState', newTaskState)

HistoryView → Extension Host → MainView
  Example: Restore agent state
  - Sender: historyView/frontend/HistoryApp.ts (RESTORE_AGENT)
  - Receiver: HistoryViewMessageHandler
  - Cross-webview: executeCommand('texra.restoreState', taskState)
```

#### The Gap: StateRestoreMessage

The **one weak point** is `StateRestoreMessage` - it's the bridge for cross-webview state transfer:

```typescript
// Current - too loose
executeCommand('texra.restoreState', taskState); // taskState is untyped

// src/commands/history/stateRestoreCommand.ts:42-46
webviewView.webview.postMessage({
  command: 'restoreState', // Hardcoded string, not using constant!
  state: state, // Unvalidated TaskState
});
```

**Fix:** Update `StateRestoreMessage` to use typed state schema (covered in 7.4)

### 7.4.2 Normalization Layer Issues

**Problem:** Data is transformed inconsistently across multiple locations.

#### Triple Path Normalization (3 different approaches)

| Location                                      | Method                              | Issue                   |
| --------------------------------------------- | ----------------------------------- | ----------------------- |
| `src/shared/utils/path.ts:11-26`              | Manual separator replacement        | `replaceAll('\\', '/')` |
| `src/webview/managers/FileManager.ts:82`      | Node.js `path.basename()`           | Different normalization |
| `src/webview/managers/FileManager.ts:479-482` | VSCode `workspace.asRelativePath()` | Yet another approach    |

**Risk:** Files stored in different normalized forms depending on code path.

#### Dead Code: `agentCategory` Field

```typescript
// MainApp.ts:1020-1028 - determineSessionType()
const candidate = state.agentCategory ?? state.sessionType;  // agentCategory NEVER saved!

// MainApp.ts:514-518 - saveState() saves:
agent: this.sessionType === SESSION_TYPES.TOOL_USE ? this.toolUseAgent : this.workflowAgent,
isToolUseAgent: this.sessionType === SESSION_TYPES.TOOL_USE,
// ← No agentCategory field!
```

#### Duplicate File Command Mappings

Same concept defined in 3 places:

| Location               | Mapping                                           |
| ---------------------- | ------------------------------------------------- |
| `MainApp.ts:1111-1117` | `singleSelectIdMap`                               |
| `store.ts:170-192`     | `FILE_UPDATE_COMMANDS`                            |
| `store.ts:170-192`     | `FILE_REFRESH_COMMANDS`, `FILE_SELECTED_COMMANDS` |

#### Multiple Visibility Field Names (3 names for same concept)

```typescript
// MainApp.ts:1050-1072 - restoreFileArrays()
const visible =
  activeFiles[fileType] ?? // Priority 1: activeFiles map
  (state[`${key}Active`] as boolean) ?? // Priority 2: ${key}Active
  (state[`${key}Visible`] as boolean) ?? // Priority 3: ${key}Visible
  false;
```

#### Global Pending State (Race Condition)

```typescript
// src/common/state/pendingStateManager.ts:21-36
let pendingStateData: PendingStateData | undefined = undefined; // SINGLE GLOBAL!

export function setPendingState(
  state: TaskState,
  executeImmediately?: boolean,
): void {
  pendingStateData = { state, executeImmediately }; // Overwrites previous!
}
```

**Risk:** Multiple restore operations → only last one wins.

### 7.4.3 Additional Contract Gaps

#### Managers Using `message: any`

```typescript
// src/webview/managers/DiffManager.ts:15-48
handleLatexdiff(message: any): void {
  this.runDiffCommand('latexdiff', message, ['inputFile', 'baseFile', 'editedFile']);
}

private runDiffCommand(command: string, message: any, paramKeys: string[]): void {
  void vscode.commands.executeCommand(
    `texra.${command}`,
    ...paramKeys.map((k) => message[k]),  // ← No validation
  );
}
```

#### Double Cast Anti-Pattern

```typescript
// MainApp.ts:853-856 - handleSetAllSingleFiles()
const messageValues = message as unknown as Record<
  // ← DOUBLE CAST!
  string,
  string[] | null | undefined
>;
```

#### WebviewStateManager Unvalidated

```typescript
// src/shared/state/WebviewStateManager.ts:14-15
const saved = (vscode.getState() as T | undefined) ?? ({} as T); // ← No validation!
```

#### String Command Construction (Injection Risk)

```typescript
// src/webview/managers/FileManager.ts:58-63
const file = await vscode.commands.executeCommand<string>(
  `texra.${message.command}`, // ← Command from unvalidated input!
);
this.postMessage({
  command: `${uncapitalize(singleFileType)}Selected`, // ← Constructed string
});
```

### 7.4.4 Inconsistent Webview File Structures

**Current State:** Each webview has a different organization.

| Webview          | Backend Files                                            | Frontend Structure                           | State                     | Types                     |
| ---------------- | -------------------------------------------------------- | -------------------------------------------- | ------------------------- | ------------------------- |
| **MainView**     | Provider, Handler, `managers/`                           | `frontend/`, `types/`                        | `store.ts`                | Local `types/messages.ts` |
| **ProgressView** | Provider, Handler, `managers/`, `state/`, `persistence/` | `frontend/formatters/`, `frontend/managers/` | `state/`, `stateUtils.ts` | `@shared/schemas`         |
| **HistoryView**  | Provider, ContentProvider, Handler                       | `frontend/`                                  | `state.ts`                | `@shared/schemas`         |
| **ProfileView**  | Provider, ContentProvider, Handler                       | `frontend/`                                  | None                      | `@shared/schemas`         |
| **MemoryView**   | Provider, ContentProvider, Handler                       | `frontend/`                                  | None                      | `@shared/schemas`         |

#### Inconsistencies Found

1. **Type locations:** MainView has local `types/messages.ts`, others use `@shared/schemas`
2. **Backend managers:** Only MainView has `managers/` folder at root
3. **State management:** `store.ts` vs `state.ts` vs `state/` folder vs none
4. **Provider pattern:** Some split Provider/ContentProvider, some combined
5. **Frontend complexity:** ProgressView has `formatters/`, `managers/` in frontend; others flat

#### Recommended Consistent Structure

```
src/{viewName}View/
├── {ViewName}ViewProvider.ts       # VS Code webview provider
├── {ViewName}ViewContentProvider.ts # HTML/asset generation
├── {ViewName}ViewMessageHandler.ts  # Message routing
├── managers/                        # Backend business logic (if needed)
│   └── *.ts
└── frontend/
    ├── {ViewName}App.ts            # Root Lit component
    ├── index.ts                    # Entry point (registers components)
    ├── events.ts                   # Event creators (types from @shared/schemas)
    ├── styles.ts                   # Component styles
    ├── components/
    │   ├── index.ts                # Barrel export
    │   └── *.ts                    # Extracted Lit components
    └── utils/                      # Frontend-only utilities (if needed)
        └── *.ts

src/shared/schemas/
├── {viewName}Messages.ts           # ALL message schemas for this view
├── {viewName}State.ts              # Persisted state schema (if any)
└── index.ts                        # Barrel export
```

#### Key Principles

1. **Schemas in `@shared/schemas/`** - Never local `types/` folder
2. **Types derived from schemas** - `type X = z.infer<typeof XSchema>`
3. **Events import types** - `events.ts` imports from `@shared/schemas`, defines creators only
4. **Flat frontend structure** - Avoid nested `formatters/`, `managers/` in frontend
5. **Backend managers at root** - If needed, `managers/` folder at view root (not in frontend)

### 7.5 MainApp Decomposition

**Current:** MainApp.ts at ~2,300 lines after Phase 6 extractions.

**Target:** Further split into focused modules:

```
src/webview/frontend/
├── MainApp.ts                    # Orchestration only (~800 lines)
├── constants.ts                  # Session types, element IDs
├── events.ts                     # Event creators (import types from @shared/schemas)
├── state/
│   └── MainViewState.ts          # NEW: State management extracted
├── handlers/
│   └── messageHandlers.ts        # NEW: Message handler registry (~200 lines)
└── components/
    ├── index.ts
    ├── FileSelectGroup.ts
    ├── BannerGroup.ts
    ├── LatexDiffsSection.ts
    ├── InstructionPanel.ts
    └── OutputFilesSection.ts
```

### 7.6 Implementation Steps

#### Step 1: Create MainViewPersistedStateSchema

Create `src/shared/schemas/mainViewState.ts`:

```typescript
import { z } from 'zod';

export const SessionTypeSchema = z.enum(['toolUse', 'workflow']);
export const FileTypeSchema = z.enum([
  'input',
  'reference',
  'auxiliary',
  'media',
]);

// State schema - single source of truth for persistence contract
// All 26 fields from MainApp.ts:91-124
export const MainViewPersistedStateSchema = z.object({
  sessionType: SessionTypeSchema.prefault('workflow'),
  workflowAgent: z.string().prefault(''),
  toolUseAgent: z.string().prefault(''),
  model: z.string().prefault(''),
  commit: z.string().prefault(''),
  instruction: z.string().prefault(''),
  inputFile: z.string().prefault(''),
  referenceFile: z.string().prefault(''),
  auxiliaryFile: z.string().prefault(''),
  mediaFile: z.string().prefault(''),
  editedFile: z.string().prefault(''),
  baseFile: z.string().prefault(''),
  inputFiles: z.array(z.string()).prefault([]),
  referenceFiles: z.array(z.string()).prefault([]),
  auxiliaryFiles: z.array(z.string()).prefault([]),
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
  inputFilesVisible: z.boolean().prefault(false),
  referenceFilesVisible: z.boolean().prefault(false),
  auxiliaryFilesVisible: z.boolean().prefault(false),
  mediaFilesVisible: z.boolean().prefault(false),
  outputFilesVisible: z.boolean().prefault(false),
  outputFilesActive: z.boolean().prefault(false),
  latexdiffsVisible: z.boolean().prefault(false),
  autoExtractFigure: z.boolean().prefault(false),
  autoExtractTikzFigure: z.boolean().prefault(false),
  autoCompileInputPdf: z.boolean().prefault(false),
  attachTeXCount: z.boolean().prefault(false),
  attachDiagnostics: z.boolean().prefault(false),
  agent: z.string().prefault(''),
  isToolUseAgent: z.boolean().prefault(false),
  openedFiles: z.array(z.string()).optional(),
});

export type MainViewPersistedState = z.infer<
  typeof MainViewPersistedStateSchema
>;
```

#### Step 2: Update StateRestoreMessageSchema

Update `src/shared/schemas/commonViewMessages.ts`:

```typescript
// Before (too loose)
state: z.record(z.string(), z.unknown()).nullish(),

// After (typed)
state: MainViewPersistedStateSchema.partial().nullish(),
```

Use `.partial()` to allow partial state updates (not all fields required).

#### Step 3: Update MainApp.ts handleRestoreState()

Replace unsafe cast with validation:

```typescript
// Before (MainApp.ts:1117)
const state = message.state as Record<string, unknown>;

// After
const parseResult = MainViewPersistedStateSchema.partial().safeParse(
  message.state,
);
if (!parseResult.success) {
  console.warn('Invalid state restore:', parseResult.error);
  return;
}
const state = parseResult.data;
```

#### Step 4: Remove legacy field support

In `MainApp.ts`, remove fallback logic for legacy field names:

- `state.agentCategory ?? state.sessionType` → just `state.sessionType`
- `state[key + 'Active'] ?? state[key + 'Visible']` → just `state[key + 'Visible']`

Document migration if needed for existing persisted states.

#### Step 5: Update stateRestoreCommand.ts

Fix hardcoded string and add validation:

```typescript
// Before (stateRestoreCommand.ts:42-46)
webviewView.webview.postMessage({
  command: 'restoreState', // Hardcoded!
  state: state,
});

// After
import { COMMON_COMMANDS } from '@common/webview/commands';
import { MainViewPersistedStateSchema } from '@shared/schemas';

webviewView.webview.postMessage({
  command: COMMON_COMMANDS.STATE_RESTORE,
  state: MainViewPersistedStateSchema.partial().parse(state),
});
```

#### Step 6: Fix normalization layers

**6a. Create single path normalization function:**

```typescript
// src/shared/utils/path.ts
export function normalizeFilePath(filePath: string): string {
  // Single source of truth for path normalization
}
```

**6b. Remove dead `agentCategory` fallback:**

```typescript
// MainApp.ts:1020-1028 - Before
const candidate = state.agentCategory ?? state.sessionType;

// After - remove dead code
const candidate = state.sessionType;
```

**6c. Consolidate visibility field names:**

- Choose canonical name: `${key}Visible`
- Remove `${key}Active` and `activeFiles` map support
- Document migration for existing persisted states

**6d. Fix global pending state:**

```typescript
// Option 1: Use Map keyed by target
const pendingStates = new Map<string, PendingStateData>();

// Option 2: Use queue
const pendingStateQueue: PendingStateData[] = [];
```

#### Step 7: Fix manager contract gaps

**7a. Add schemas for DiffManager messages:**

```typescript
// src/shared/schemas/mainViewMessages.ts
export const LatexdiffMessageSchema = z.object({
  command: z.literal('latexdiff'),
  inputFile: z.string(),
  baseFile: z.string(),
  editedFile: z.string(),
});
```

**7b. Remove double casts in MainApp:**

```typescript
// Before (MainApp.ts:853-856)
const messageValues = message as unknown as Record<
  string,
  string[] | null | undefined
>;

// After - use schema
const parseResult = SetAllSingleFilesSchema.safeParse(message);
if (!parseResult.success) return;
const messageValues = parseResult.data;
```

**7c. Add validation to WebviewStateManager:**

```typescript
// WebviewStateManager.ts
constructor(defaultState: Partial<T>, schema: z.ZodType<T>) {
  const saved = vscode.getState();
  const parseResult = schema.safeParse(saved);
  this.state = parseResult.success
    ? { ...defaultState, ...parseResult.data }
    : { ...defaultState };
}
```

**7d. Validate command construction in FileManager:**

```typescript
// Before
const file = await vscode.commands.executeCommand(`texra.${message.command}`);

// After - whitelist valid commands
const VALID_FILE_COMMANDS = new Set(['selectInputFile', 'selectReferenceFile', ...]);
if (!VALID_FILE_COMMANDS.has(message.command)) {
  throw new Error(`Invalid file command: ${message.command}`);
}
```

#### Step 8: Fix other webviews (minor)

**HistoryView** - Use `unknown` instead of `any`:

```typescript
// src/historyView/HistoryViewMessageHandler.ts:43-45
// Before
private async handleGetHistoryData(_message: any, view: ...): Promise<void>

// After
private async handleGetHistoryData(_message: unknown, view: ...): Promise<void>
```

**MemoryView** - Remove duplicate interface, use schema:

```typescript
// src/memoryView/MemoryViewMessageHandler.ts:43
// Before - duplicate interface
interface MemoryViewItem {
  displayPath: string;
  storagePath: string;
  // ...
}

// After - derive from schema
import { type MemoryViewItem } from '@shared/schemas';
// (MemoryViewItemSchema already exists in memoryViewMessages.ts)
```

#### Step 9: Create event detail schemas (optional)

Move event types to `src/shared/schemas/mainViewEvents.ts` if needed for cross-component type sharing.

#### Step 10: Create regression test infrastructure

**10a. Create manual test checklist:**

- Create `docs/testing/mainview-manual-tests.md`
- Document state persistence tests
- Document cross-webview restore tests
- Document legacy state migration tests

**10b. Add state migration unit tests:**

- Create `src/test/webview/stateMigration.test.ts`
- Test legacy field migration (`agentCategory` → `sessionType`)
- Test default application via `.prefault()`
- Test partial state restoration

**10c. Add schema validation tests:**

- Test `MainViewPersistedStateSchema.safeParse()` with various inputs
- Test invalid state rejection
- Test backward compatibility with old formats

#### Step 11: Extract handlers/state (optional)

- Create `handlers/messageHandlers.ts` with registry pattern
- Create `state/MainViewState.ts` for state management

### 7.7 Files to Modify

#### Shared Schemas (single source of truth)

| File                                       | Changes                                               |
| ------------------------------------------ | ----------------------------------------------------- |
| `src/shared/schemas/mainViewState.ts`      | **NEW** - MainViewPersistedStateSchema with 26 fields |
| `src/shared/schemas/commonViewMessages.ts` | Update StateRestoreMessageSchema to use typed state   |
| `src/shared/schemas/index.ts`              | Export new mainViewState schemas                      |

#### Backend (State Restore Flow)

| File                                                | Changes                                      |
| --------------------------------------------------- | -------------------------------------------- |
| `src/commands/history/stateRestoreCommand.ts:42-46` | Use COMMON_COMMANDS constant, validate state |
| `src/MainViewProvider.ts:265-274`                   | Validate state in setupInitialState()        |

#### Frontend

| File                                                        | Changes                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| `src/webview/frontend/MainApp.ts:91-124`                    | Remove `MainViewPersistedState` interface, import from @shared/schemas |
| `src/webview/frontend/MainApp.ts:1109-1170`                 | Use `.safeParse()` in handleRestoreState()                             |
| `src/webview/frontend/MainApp.ts:1172-1224`                 | Remove legacy field fallbacks                                          |
| `src/webview/frontend/MainApp.ts:134-166`                   | Remove DEFAULT_STATE, use schema `.parse({})`                          |
| `src/webview/frontend/components/BannerGroup.ts:18-35`      | Remove banner state interfaces                                         |
| `src/webview/frontend/components/FileSelectGroup.ts:23-46`  | Remove config interfaces                                               |
| `src/webview/frontend/components/InstructionPanel.ts:22-45` | Remove event detail interfaces                                         |

#### Other Webviews (Minor Cleanup)

| File                                              | Changes                                                      |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `src/historyView/HistoryViewMessageHandler.ts:44` | `_message: any` → `_message: unknown`                        |
| `src/memoryView/MemoryViewMessageHandler.ts:43`   | Remove duplicate `MemoryViewItem` interface, use `z.infer<>` |

#### Testing Infrastructure

| File                                      | Changes                              |
| ----------------------------------------- | ------------------------------------ |
| `docs/testing/mainview-manual-tests.md`   | **NEW** - Manual test checklist      |
| `src/test/webview/stateMigration.test.ts` | **NEW** - State migration unit tests |

#### Optional

| File                                               | Changes                            |
| -------------------------------------------------- | ---------------------------------- |
| `src/webview/frontend/events.ts`                   | Import types from @shared/schemas  |
| `src/webview/frontend/handlers/messageHandlers.ts` | **NEW** - Message handler registry |
| `src/webview/frontend/state/MainViewState.ts`      | **NEW** - State management         |

### 7.8 Success Metrics

#### Zod-Native Compliance

| Metric                           | Before | Target |
| -------------------------------- | ------ | ------ |
| Standalone interfaces (MainView) | ~25    | 0      |
| Types derived from schemas       | 0      | ~25    |
| `message: any` handlers          | 5+     | 0      |
| Double casts (`as unknown as`)   | 3      | 0      |
| Duplicate interfaces             | 2      | 0      |

#### Contract Enforcement

| Metric                         | Before      | Target           |
| ------------------------------ | ----------- | ---------------- |
| StateRestoreMessage validation | None        | Schema validated |
| WebviewStateManager validation | None        | Schema validated |
| Path normalization functions   | 3 different | 1 canonical      |
| Visibility field names         | 3 variants  | 1 canonical      |

#### Code Quality

| Metric                            | Before | Target |
| --------------------------------- | ------ | ------ |
| MainApp.ts lines                  | ~2,087 | ~800   |
| Dead code paths (`agentCategory`) | 1      | 0      |
| Global state race conditions      | 1      | 0      |

### 7.9 UI Regression Testing Strategy

**Current State:** No webview UI tests exist. Only backend tests (19 files).

#### Gap Analysis

| Category              | Status  | Risk                                       |
| --------------------- | ------- | ------------------------------------------ |
| Component tests       | ❌ None | High - Lit components untested             |
| State migration tests | ❌ None | High - Legacy format handling untested     |
| Snapshot tests        | ❌ None | Medium - HTML structure changes undetected |
| E2E tests             | ❌ None | Medium - User flows untested               |
| Manual test docs      | ❌ None | Low - Only implicit in walkthrough         |

#### Recommended Testing Approach

**Option A: Manual Testing Checklist (Minimum)**

Create `docs/testing/mainview-manual-tests.md`:

```markdown
## MainView Manual Test Checklist

### State Persistence

- [ ] Set all form fields, close/reopen VS Code → fields restored
- [ ] Switch session type (workflow ↔ tool-use) → correct agent shown
- [ ] Add multiple files to lists → lists restored after reload
- [ ] Toggle visibility on file lists → visibility preserved

### State Restore (Cross-webview)

- [ ] From HistoryView: click "Restore" → MainView populated correctly
- [ ] From ProgressView: click "Setup Followup" → MainView populated correctly

### Legacy State Migration

- [ ] Load state with `agentCategory` field → maps to `sessionType`
- [ ] Load state with `inputFilesActive` → maps to `inputFilesVisible`
- [ ] Load state with `activeFiles` map → extracts visibility correctly

### Component Interactions

- [ ] File dropdowns: select file → field updates
- [ ] Checkboxes: toggle → state saves
- [ ] Banners: API key missing → banner shows, add key → banner hides
- [ ] Execute button: click → progress view opens
```

**Option B: Automated State Migration Tests (Recommended)**

Add `src/test/webview/stateMigration.test.ts`:

```typescript
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { MainViewPersistedStateSchema } from '@shared/schemas';

describe('MainView State Migration', () => {
  it('migrates legacy agentCategory to sessionType', () => {
    const legacy = { agentCategory: 'toolUse', agent: 'test-agent' };
    const result = MainViewPersistedStateSchema.safeParse(legacy);
    expect(result.success).to.be.true;
    expect(result.data?.sessionType).to.equal('toolUse');
  });

  it('migrates legacy inputFilesActive to inputFilesVisible', () => {
    const legacy = { inputFilesActive: true };
    const result = MainViewPersistedStateSchema.safeParse(legacy);
    expect(result.success).to.be.true;
    expect(result.data?.inputFilesVisible).to.be.true;
  });

  it('applies defaults for missing fields', () => {
    const partial = { sessionType: 'workflow' };
    const result = MainViewPersistedStateSchema.parse(partial);
    expect(result.inputFiles).to.deep.equal([]);
    expect(result.inputFilesVisible).to.be.false;
  });
});
```

**Option C: Lit Component Tests (Future)**

Add `@open-wc/testing` and `@web/test-runner`:

```typescript
// src/webview/frontend/components/FileSelectGroup.test.ts
import { fixture, html, expect } from '@open-wc/testing';
import { FileSelectGroup } from './FileSelectGroup';

describe('FileSelectGroup', () => {
  it('renders file dropdown with options', async () => {
    const el = await fixture<FileSelectGroup>(html`
      <file-select-group
        .config=${{ type: 'input', label: 'Input' }}
        .options=${['file1.tex', 'file2.tex']}
      ></file-select-group>
    `);
    const select = el.shadowRoot?.querySelector('select');
    expect(select?.options.length).to.equal(2);
  });

  it('dispatches file-change event on selection', async () => {
    // ...
  });
});
```

#### Phase 7 Verification Steps

**Build Verification:**

1. `npm run compile:fast` - No TypeScript errors
2. `npm run lint` - No issues

**State Contract Verification:** 3. Add state migration unit tests (Option B above) 4. Run: `npm run test` (after fixing test infrastructure)

**Manual Regression Testing:** 5. Open extension, verify main view loads correctly 6. Execute manual test checklist (create as part of Phase 7) 7. Test state persistence: Close/reopen VS Code 8. Test cross-webview restore: HistoryView → MainView 9. Test legacy state: Manually edit stored state to legacy format, verify migration

**Smoke Test Critical Paths:** 10. New user flow: No state → defaults load correctly 11. Existing user: Persisted state → restores correctly 12. State restore: From history → fields populate correctly

---
