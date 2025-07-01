# Codebase Reorganization Proposal

## Current Issues

### 1. `src/utils` - Mixed Scope Utilities
- Contains both **shared utilities** (used by frontend + backend) and **backend-only utilities**
- Examples of truly shared: `helpers.ts` (sleep function used across frontend & backend)
- Examples of backend-only: `errorHandlingUtils.ts`, `sdkErrorUtils.ts`, `stateManager.ts`

### 2. `src/types` - Backend-Only Types
- Contains types that are primarily used in backend code, not shared between frontend/backend
- `DiffTypes.ts` - Only used in backend progress/agent modules
- `EntityTypes.ts` - Only used in backend logger module
- Only `node-pandoc.d.ts` and `nunjucks.d.ts` are truly shared type declarations

### 3. `src/commands` - Well Organized But Could Be Better Integrated
- Good domain-based organization, but some commands could be closer to their related modules

## Proposed Structure

### A. Move Backend-Only Utilities to Appropriate Modules

#### From `src/utils/` → Backend Module Locations:
```
src/utils/errorHandlingUtils.ts    → src/common/errors/errorHandlingUtils.ts
src/utils/sdkErrorUtils.ts         → src/common/errors/sdkErrorUtils.ts
src/utils/stateManager.ts          → src/common/state/stateManager.ts
src/utils/fileTypeUtils.ts         → src/common/files/fileTypeUtils.ts
```

#### Keep Truly Shared Utilities in `src/utils/`:
```
src/utils/
├── helpers.ts                     # Shared utilities (sleep, etc.)
├── files/                         # File system utilities (used by both)
│   ├── absoluteFS.ts
│   ├── workspaceFS.ts
│   ├── storageFS.ts
│   └── ...
├── text/                          # Text processing (used by both)
│   ├── stringUtils.ts
│   ├── xmlUtils.ts
│   └── ...
├── system/                        # System utilities (used by both)
│   ├── execUtils.ts
│   ├── toolUtils.ts
│   └── ...
└── config/                        # Configuration utilities (used by both)
    ├── configUtils.ts
    └── ...
```

### B. Reorganize Types for True Separation

#### Move Backend-Only Types:
```
src/types/DiffTypes.ts             → src/agent/types/DiffTypes.ts
src/types/EntityTypes.ts           → src/logger/types/EntityTypes.ts
src/types/IdentifierTypes.ts       → src/agent/types/IdentifierTypes.ts
src/types/ResultTypes.ts           → src/agent/types/ResultTypes.ts
src/types/UsageTypes.ts            → src/agent/types/UsageTypes.ts
```

#### Keep Truly Shared Types in `src/types/`:
```
src/types/
├── node-pandoc.d.ts              # Shared type declarations
├── nunjucks.d.ts                 # Shared type declarations
└── shared.ts                     # New file for truly shared interfaces
```

### C. Better Integration of Commands

#### Move Domain-Specific Commands Closer to Their Modules:
```
src/commands/latex/               → src/latex/commands/
src/commands/wolfram/             → src/tools/wolfram/commands/
src/commands/agent/               → src/agent/commands/
src/commands/git/                 → src/tools/git/commands/
src/commands/housekeeping/        → src/housekeeping/commands/
```

#### Keep General Commands in `src/commands/`:
```
src/commands/
├── system/                       # System-level commands
├── files/                        # File operation commands
├── api/                          # API-related commands
├── tests/                        # Test commands
├── progress/                     # Progress view commands
└── history/                      # History commands
```

## Benefits of This Reorganization

### 1. **Clear Separation of Concerns**
- **Shared utilities** remain in `src/utils/` (truly used by both frontend & backend)
- **Backend-specific utilities** move to appropriate domain modules
- **Types** are co-located with their usage domains

### 2. **Improved Maintainability**
- Easier to find related code (commands near their domain logic)
- Clear boundaries between shared and domain-specific code
- Reduced coupling between unrelated modules

### 3. **Better Developer Experience**
- Clearer import paths that indicate scope
- Less confusion about what's shared vs. domain-specific
- Easier to understand dependencies

## Implementation Plan

### Phase 1: Create New Directory Structure
1. Create `src/common/errors/`, `src/common/state/`, `src/common/files/`
2. Create type directories in relevant modules: `src/agent/types/`, `src/logger/types/`

### Phase 2: Move Files and Update Imports
1. Move backend-only utilities to appropriate locations
2. Move domain-specific types to their modules
3. Update all import statements across the codebase
4. Update tsconfig.json path mappings if needed

### Phase 3: Move Commands (Optional)
1. Move domain-specific commands to their modules
2. Update command registration and imports
3. Test all functionality

### Phase 4: Cleanup
1. Remove empty directories
2. Update documentation
3. Verify all imports are working correctly

## Files That Need Import Updates

Based on the analysis, these files will need import path updates:

### For errorHandlingUtils.ts:
- `src/commands/system/textEditorCommands.ts`
- `src/commands/files/fileSelectionCommands.ts`
- `src/commands/history/stateRestoreCommand.ts`
- `src/commands/tests/connectionTests.ts`
- `src/commands/latex/latexCommands.ts`
- `src/historyView/HistoryViewProvider.ts`
- `src/latex/latexdiff.ts`
- `src/explorer/ExplorerOperations.ts`
- `src/housekeeping/indent.ts`
- `src/utils/system/commandUtils.ts`
- `src/webview/managers/FileManager.ts`

### For sdkErrorUtils.ts:
- `src/agent/modelHandlers/` (multiple files)
- `src/agent/toolUse/BaseToolUseAgent.ts`
- `src/latex/textConnection.ts`
- `src/frontend/media/audio.ts`
- `src/utils/text/textEnhancementUtils.ts`

### For stateManager.ts:
- `src/frontend/setup.ts`
- `src/frontend/ui/instruction.ts`
- `src/extension.ts`
- `src/progressView/ProgressStateManager.ts`
- `src/historyView/AgentHistoryManager.ts`

This reorganization will create a cleaner, more maintainable codebase structure that properly separates shared utilities from domain-specific ones.