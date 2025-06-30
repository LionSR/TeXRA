# Naming Alignment Proposal: TypeScript ↔ JavaScript Consistency

## Executive Summary

Following the successful migration from `logStreams` to `StreamTabs`, this proposal addresses remaining naming inconsistencies between TypeScript backend code and JavaScript frontend code in the progressView system.

## Current State Analysis

### ✅ Already Aligned (Recent Changes)
- `logStreams` → `StreamTabs` (completed in both TS and JS)

### 🔄 Identified Misalignments

## 1. Core Entity Naming Inconsistencies

### A. Log Groups vs Task Groups
**Current State:**
- **TypeScript**: Uses `taskGroups` (ProgressStateManager.ts)
- **JavaScript**: Uses `taskGroups` (domHandlers.js, TaskGroupManager)
- **Legacy**: Old references to `logGroups` in storage migration code

**Status**: ✅ **ALIGNED** - Both sides use `taskGroups`

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

### Priority 1: Critical Alignment Issues
**None identified** - The major alignment issue (`logStreams` → `StreamTabs`) has been resolved.

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

### Phase 1: Backup Strategy
```typescript
// No workspace storage changes needed - all keys are already aligned
// Current storage keys are consistent between TS and JS usage
```

### Phase 2: Message Handler Renaming (Optional)
If desired for consistency:

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

4. Update all import statements accordingly.

### Phase 3: Validation
- All storage keys already use consistent naming
- No breaking changes to storage format
- All functional naming is already aligned

## 🎯 CONCLUSION

**Good News**: The codebase is already well-aligned! The major inconsistency (`logStreams` vs `StreamTabs`) has been resolved. 

**Remaining Issues**: 
- Minor: Message handler class names could be more consistent with TypeScript naming conventions
- All storage keys and functional naming are already properly aligned

**Recommendation**: The current state is functionally correct. The optional message handler renaming could improve consistency but is not critical for functionality.

**Workspace Storage**: No backup needed - all storage keys are already consistent and no breaking changes are required.