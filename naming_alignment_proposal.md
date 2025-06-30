# Naming Alignment Proposal: TypeScript ↔ JavaScript Consistency

## Executive Summary

Following the successful migration from `logStreams` to `StreamTabs`, this proposal addresses remaining naming inconsistencies between TypeScript backend code and JavaScript frontend code in the progressView system.

## Current State Analysis

### ✅ Already Aligned (Recent Changes)
- `logStreams` → `StreamTabs` (completed in both TS and JS)

### 🔄 MAJOR INCONSISTENCIES IDENTIFIED

## 1. Core Entity Naming Inconsistencies

### A. Log Groups vs Task Groups - **CRITICAL MISALIGNMENT**
**Current State:**
- **Documentation (AGENTS.md)**: Specifies `LogGroups` as the intended pattern
- **TypeScript Storage**: Uses `taskGroups` (ProgressStateManager.ts)
- **TypeScript Methods**: Uses `addLogGroup`, `updateLogGroup` (ProgressViewProvider.ts)
- **JavaScript**: Uses `taskGroups` (domHandlers.js, TaskGroupManager)
- **JavaScript Handlers**: Uses `handleAddLogGroup`, `handleUpdateLogGroup`
- **Commands**: Uses `ADD_LOG_GROUP`, `UPDATE_LOG_GROUP`
- **Event Bus**: Uses `addLogGroup`, `updateLogGroup`

**Status**: ❌ **MAJOR INCONSISTENCY** - Mixed usage of both `logGroup` and `taskGroup` patterns

### B. Usage Management
**Current State:**
- **TypeScript**: `usageStats: Map<string, TokenUsageStats>` (ProgressStateManager.ts)
- **JavaScript**: `usageSummary: UsageSummary` (domHandlers.js)

**Issue**: Different concepts - `usageStats` is persistent data, `usageSummary` is UI computation

**Status**: ✅ **CORRECTLY DIFFERENT** - These serve different purposes

### C. File Management
**Current State:**
- **TypeScript**: `outputFiles: Map<string, { [key: number]: OutputFileInfo[] }>` (ProgressStateManager.ts)
- **JavaScript**: `fileList: FileList` (domHandlers.js)

**Status**: ✅ **CORRECTLY DIFFERENT** - Different scopes (output vs all files)

## 2. Instance Naming Patterns

### A. Manager Instantiation Consistency
**Current Inconsistencies:**

#### JavaScript Pattern Analysis:
```javascript
// progressView/modules/domHandlers.js - GOOD (PascalCase classes, camelCase instances)
this.streamTabs = new StreamTabs();
this.taskGroups = new TaskGroupManager();
this.usageSummary = new UsageSummary();

// webview/modules/domHandlers.js - INCONSISTENT (some camelCase exports)
export const instructionManager = new InstructionManager();  // camelCase export
export const toggleManager = new ToggleManager();           // camelCase export
export const recordingManager = new RecordingManager();     // camelCase export
```

**Recommendation**: Standardize on **camelCase instances, PascalCase classes**

### B. Singleton Export Patterns
**Current Inconsistencies:**

#### JavaScript Singleton Exports:
```javascript
// INCONSISTENT PATTERNS:
export const fileList = new FileList();                    // camelCase
export const messageHandlers = new MessageHandlers();      // camelCase  
export const progressViewDomHandler = new ProgressViewDomHandler(); // camelCase
export const webviewDomHandler = new WebviewDomHandler();  // camelCase
```

**Status**: ✅ **CONSISTENT** - All use camelCase for singleton exports

## 3. Workspace Storage Key Alignment

### Current Storage Keys (TypeScript):
```typescript
export enum WorkspaceStateKey {
  STREAM_TABS = 'texra.streamTabs',        // ✅ Updated from logStreams
  TASK_GROUPS = 'texra.taskGroups',        // ✅ Consistent  
  OUTPUT_FILES = 'texra.outputFiles',      // ✅ Consistent
  USAGE_STATS = 'texra.usageStats',        // ✅ Consistent
  // ... others
}
```

**Status**: ✅ **ALIGNED** - Storage keys are consistent

## 4. Method and Property Naming

### A. State Manager Methods
**TypeScript (ProgressStateManager.ts):**
```typescript
get streamTabs(): Map<string, LogMessageData[]>
get taskGroups(): Map<string, Map<string, TaskGroup>>
get usageStats(): Map<string, TokenUsageStats>
```

**JavaScript (progressViewState.js):**
```javascript
class ProgressViewState {
  constructor() {
    this.taskGroups = new TaskGroups();  // ✅ Consistent
    // No direct streamTabs equivalent - handled differently
  }
}
```

**Status**: ✅ **APPROPRIATELY DIFFERENT** - Different architectural layers

## 5. Event and Message Handler Naming

### Current Pattern Analysis:
**TypeScript:**
```typescript
export class ProgressViewMessageHandler extends BaseViewMessageHandler
export class MainViewMessageHandler extends BaseViewMessageHandler
```

**JavaScript:**
```javascript
export class ProgressMessageHandlers  // Missing "View" 
export class MessageHandlers          // Missing "View"
export class HistoryMessageHandlers   // Missing "View"
```

**Identified Inconsistency**: JavaScript message handlers don't follow the `[Domain]View[Component]` pattern

## 📋 RECOMMENDATIONS

### Priority 1: CRITICAL - Log Groups vs Task Groups Alignment

**Decision Required**: Choose one consistent naming pattern:

#### Option A: Standardize on `LogGroups` (Following AGENTS.md documentation)
**Pros:**
- Matches documented architecture pattern
- More descriptive of actual function (logging/progress tracking)
- Consistent with existing event/command naming

**Changes Required:**
1. **TypeScript Storage & Properties:**
   ```typescript
   // ProgressStateManager.ts
   - private _taskGroups: Map<string, Map<string, TaskGroup>>
   + private _logGroups: Map<string, Map<string, LogGroup>>
   
   - get taskGroups(): Map<string, Map<string, TaskGroup>>
   + get logGroups(): Map<string, Map<string, LogGroup>>
   ```

2. **JavaScript Classes & Instances:**
   ```javascript
   // domHandlers.js
   - this.taskGroups = new TaskGroupManager();
   + this.logGroups = new LogGroupManager();
   
   // Rename TaskGroupManager → LogGroupManager
   ```

3. **Storage Keys:**
   ```typescript
   // stateManager.ts
   - TASK_GROUPS = 'texra.taskGroups'
   + LOG_GROUPS = 'texra.logGroups'
   ```

#### Option B: Standardize on `TaskGroups` (Current implementation)
**Pros:**
- Less changes to existing storage/state management
- Matches current TypeScript implementation

**Changes Required:**
1. **Commands & Events:**
   ```typescript
   // commands.ts/js
   - ADD_LOG_GROUP: 'addLogGroup'
   + ADD_TASK_GROUP: 'addTaskGroup'
   
   - UPDATE_LOG_GROUP: 'updateLogGroup'  
   + UPDATE_TASK_GROUP: 'updateTaskGroup'
   ```

2. **TypeScript Methods:**
   ```typescript
   // ProgressViewProvider.ts
   - public addLogGroup(...)
   + public addTaskGroup(...)
   
   - public updateLogGroup(...)
   + public updateTaskGroup(...)
   ```

3. **JavaScript Handlers:**
   ```javascript
   // messageHandlers.js
   - handleAddLogGroup(message)
   + handleAddTaskGroup(message)
   
   - handleUpdateLogGroup(message)
   + handleUpdateTaskGroup(message)
   ```

4. **Update AGENTS.md documentation**

### Priority 2: Consistency Improvements

#### A. Message Handler Class Naming
**Current:**
```javascript
// progressView/modules/messageHandlers.js
export class ProgressMessageHandlers

// webview/modules/messageHandlers.js  
export class MessageHandlers

// historyView/modules/messageHandlers.js
export class HistoryMessageHandlers
```

**Proposed:**
```javascript
// progressView/modules/messageHandlers.js
export class ProgressViewMessageHandlers  // Add "View"

// webview/modules/messageHandlers.js
export class MainViewMessageHandlers      // Add "MainView"

// historyView/modules/messageHandlers.js
export class HistoryViewMessageHandlers   // Add "View"
```

**Impact**: Low risk - only affects class names, not functionality

### Priority 3: Optional Standardization

#### A. Singleton Export Naming
All singleton exports currently use consistent camelCase - **no changes needed**.

#### B. Instance Property Naming  
All instance properties follow camelCase convention - **no changes needed**.

## 🔧 IMPLEMENTATION PLAN

### Phase 1: CRITICAL - Workspace Storage Backup Strategy

**⚠️ BACKUP REQUIRED** - This involves changing storage keys that may contain user data.

#### Recommended Approach: Follow the `logStreams` → `streamTabs` Migration Pattern

The ProgressStateManager already has migration logic for the `logStreams` → `streamTabs` transition. We should follow the same pattern:

```typescript
// Example migration logic (already exists in ProgressStateManager.ts):
private async _loadTaskGroups(): Promise<void> {
  let savedGroups = workspaceSM.get<{
    [key: string]: { [groupId: string]: TaskGroup };
  }>(this._getWorkspaceKey(WorkspaceStateKey.TASK_GROUPS));

  // Migrate from old key if needed
  if (!savedGroups) {
    const oldGroups = workspaceSM.get<{
      [key: string]: { [groupId: string]: TaskGroup };
    }>(this._getWorkspaceKey('texra.logGroups'));
    if (oldGroups) {
      savedGroups = oldGroups;
      await workspaceSM.update(
        this._getWorkspaceKey('texra.logGroups'),
        undefined,
      );
      this.logger.debug('Migrated log groups to task groups');
    }
  }
  // ... rest of loading logic
}
```

#### Recommended Decision: **Option A - Standardize on LogGroups**

**Rationale:**
1. Matches documented architecture (AGENTS.md)
2. Consistent with existing command/event naming
3. More semantically correct (these are logging/progress groups, not task execution groups)
4. Migration path already exists in codebase

### Phase 2: Implementation Steps for LogGroups Standardization

#### Step 1: Update Storage Keys and Migration Logic
```typescript
// src/utils/stateManager.ts
export enum WorkspaceStateKey {
- TASK_GROUPS = 'texra.taskGroups',
+ LOG_GROUPS = 'texra.logGroups',
}

// src/progressView/ProgressStateManager.ts
- private _taskGroups: Map<string, Map<string, TaskGroup>> = new Map();
+ private _logGroups: Map<string, Map<string, LogGroup>> = new Map();

- get taskGroups(): Map<string, Map<string, TaskGroup>> {
+ get logGroups(): Map<string, Map<string, LogGroup>> {
- return this._taskGroups;
+ return this._logGroups;
}

// Update migration logic to handle taskGroups → logGroups transition
private async _loadLogGroups(): Promise<void> {
  let savedGroups = workspaceSM.get<{
    [key: string]: { [groupId: string]: LogGroup };
  }>(this._getWorkspaceKey(WorkspaceStateKey.LOG_GROUPS));

  // Migrate from taskGroups if needed
  if (!savedGroups) {
    const taskGroups = workspaceSM.get<{
      [key: string]: { [groupId: string]: LogGroup };
    }>(this._getWorkspaceKey('texra.taskGroups'));
    if (taskGroups) {
      savedGroups = taskGroups;
      await workspaceSM.update(
        this._getWorkspaceKey('texra.taskGroups'),
        undefined,
      );
      this.logger.debug('Migrated taskGroups to logGroups');
    }
  }
  // ... rest of loading logic
}
```

#### Step 2: Update JavaScript Classes and Instances
```javascript
// src/progressView/modules/taskManagers.js → logManagers.js
- export class TaskGroupManager {
+ export class LogGroupManager {

// src/progressView/modules/domHandlers.js
- this.taskGroups = new TaskGroupManager();
+ this.logGroups = new LogGroupManager();

// Update all references in messageHandlers.js
- dom.taskGroups.add(g);
+ dom.logGroups.add(g);
```

#### Step 3: Update All Method References
```typescript
// src/progressView/ProgressViewProvider.ts
// No changes needed - addLogGroup, updateLogGroup already correct

// src/progressView/modules/messageHandlers.js  
// No changes needed - handleAddLogGroup, handleUpdateLogGroup already correct

// Update state manager method calls:
- this._stateManager.taskGroups
+ this._stateManager.logGroups
```

### Phase 3: Optional Message Handler Class Naming
After LogGroups alignment, optionally standardize message handler names:

1. **progressView/modules/messageHandlers.js**:
   ```javascript
   - export class ProgressMessageHandlers
   + export class ProgressViewMessageHandlers
   ```

2. **webview/modules/messageHandlers.js**:
   ```javascript
   - export class MessageHandlers  
   + export class MainViewMessageHandlers
   ```

3. **historyView/modules/messageHandlers.js**:
   ```javascript
   - export class HistoryMessageHandlers
   + export class HistoryViewMessageHandlers
   ```

### Phase 4: Validation & Testing
- Test workspace storage migration from `texra.taskGroups` → `texra.logGroups`
- Verify all UI functionality works with renamed classes
- Ensure no references to old `taskGroups` remain

## 🎯 CONCLUSION

**Critical Issue Identified**: Major naming inconsistency between `logGroups` (documentation/commands) and `taskGroups` (storage/state).

**Recommendation**: 
1. **Priority 1**: Implement LogGroups standardization with proper migration
2. **Priority 2**: Optional message handler class renaming for consistency

**Workspace Storage**: **BACKUP REQUIRED** - Storage key changes need migration logic to preserve user data.

**Impact**: This is a significant refactoring that will improve code consistency and align implementation with documentation, but requires careful migration handling.

## 📝 Additional Naming Patterns Analysis

### ✅ Confirmed Consistent Patterns
After thorough analysis, these patterns are already properly aligned:

1. **LogEntry/LogEntryManager**: ✅ Consistent usage across TS/JS
2. **LogMessage/LogMessageData**: ✅ Consistent usage across TS/JS  
3. **StreamTabs**: ✅ Successfully migrated from logStreams
4. **UsageSummary vs UsageStats**: ✅ Correctly different (UI computation vs persistent data)
5. **FileList vs OutputFiles**: ✅ Correctly different (UI management vs storage)

### 🔍 Summary of All Findings

| Entity | TypeScript | JavaScript | Status | Action Required |
|--------|------------|------------|--------|-----------------|
| Stream Tabs | `streamTabs` | `StreamTabs` | ✅ Aligned | None |
| **Log Groups** | `taskGroups` (storage)<br>`addLogGroup` (methods) | `taskGroups` (instance)<br>`handleAddLogGroup` (handlers) | ❌ **CRITICAL** | **Standardize on LogGroups** |
| Log Entries | `LogEntryManager` | `LogEntryManager` | ✅ Aligned | None |
| Log Messages | `LogMessageData` | `logMessage` | ✅ Aligned | None |
| Usage Data | `usageStats` | `usageSummary` | ✅ Different by design | None |
| File Management | `outputFiles` | `fileList` | ✅ Different by design | None |
| Message Handlers | `[Domain]ViewMessageHandler` | `[Domain]MessageHandlers` | ⚠️ Minor | Optional standardization |

**Primary Issue**: The LogGroups vs TaskGroups inconsistency is the main alignment problem that needs addressing.