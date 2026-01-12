# Settings View Implementation Progress

## Status: Phase 2 - Fixing Gaps Before Legacy Removal

### Phase 1 Complete ✅

#### Backend Implementation
- [x] `SettingsViewProvider.ts` - Main webview provider with panel management
- [x] `SettingsViewContentProvider.ts` - HTML content generation with import maps
- [x] `SettingsViewMessageHandler.ts` - Message handling for all 5 tabs
- [x] `schemas.ts` - Zod schemas for type-safe message protocol

#### Frontend Implementation
- [x] All frontend modules created and functional
- [x] All 5 tabs implemented (Models, Agents, LaTeX, Memory, History)
- [x] Integration with main webview gear button

---

## Phase 2: Gap Analysis Results

### History Tab Gaps (vs legacy historyView)

| Gap | Priority | Status |
|-----|----------|--------|
| Only shows first output file (should show all) | HIGH | Pending |
| Missing media files display | MEDIUM | Pending |
| Missing reference files display | MEDIUM | Pending |
| Missing auxiliary files display | MEDIUM | Pending |
| Missing session kind badge (Workflow/Tool-Use) | LOW | Pending |
| Missing tool configuration display | HIGH | Pending |
| Missing keyboard navigation (Enter/Shift+Enter) | LOW | Pending |
| Missing search state persistence | LOW | Pending |

### Memory Tab Gaps (vs legacy memoryView)

| Gap | Priority | Status |
|-----|----------|--------|
| Memory data NOT collected in initial data load | CRITICAL | Pending |
| Missing "Open Memory Folder" handler | HIGH | Pending |
| Missing memory enable/disable toggle | HIGH | Pending |
| Missing preview data population | MEDIUM | Pending |
| Missing line count display | LOW | Pending |

### Command Registration Gaps

| Command | In Code | In package.json | Status |
|---------|---------|-----------------|--------|
| `texra.openSettingsView` | ✅ | ❌ | Pending |
| `texra.openModelsSettings` | ✅ | ❌ | Pending |
| `texra.openAgentsSettings` | ✅ | ❌ | Pending |

### Menu Integration Updates Needed

| Menu Location | Current | Target |
|---------------|---------|--------|
| progressView toolbar | `texra.openSettings` | `texra.openSettingsView` |
| progressView toolbar | `texra.showAgentHistory` | Remove (use Settings View) |
| progressView toolbar | `texra.showMemory` | Remove (use Settings View) |
| mainView toolbar | Same changes needed | Same |

### Schema/Protocol Issues

- Duplicate command constants (3 locations)
- `OPEN_MEMORY_FOLDER` defined but no handler
- `HistoryActionSchema` overly generic (should be 3 separate schemas)
- No outbound message validation for `SET_HISTORY_DATA`, etc.

---

## Fix Priority Order

1. **CRITICAL**: Collect memory data in `collectInitialData()`
2. **HIGH**: Expand HistoryItem schema to include all file types
3. **HIGH**: Add `handleOpenMemoryFolder` handler
4. **HIGH**: Add memory enable/disable toggle
5. **MEDIUM**: Add commands to package.json
6. **MEDIUM**: Update menu integrations
7. **LOW**: Clean up duplicate constants
8. **LOW**: Add keyboard navigation for search

---

## Legacy Views to Remove (After Fixes)

| Directory | Lines | Replacement |
|-----------|-------|-------------|
| `src/historyView/` | ~1200 | Settings View → History tab |
| `src/memoryView/` | ~800 | Settings View → Memory tab |

### Files to Delete
- `src/historyView/HistoryViewProvider.ts`
- `src/historyView/HistoryViewContentProvider.ts`
- `src/historyView/HistoryViewMessageHandler.ts`
- `src/historyView/index.html`
- `src/historyView/script.js`
- `src/historyView/styles/`
- `src/historyView/modules/`
- `src/memoryView/MemoryViewProvider.ts`
- `src/memoryView/MemoryViewContentProvider.ts`
- `src/memoryView/MemoryViewMessageHandler.ts`
- `src/memoryView/index.html`
- `src/memoryView/script.js`
- `src/memoryView/styles/`
- `src/memoryView/modules/`

### References to Update
- `src/commands/history/historyCommands.ts` - Redirect to Settings View
- `src/commands/memory/memoryCommands.ts` - Redirect to Settings View
- `src/commands.ts` - Remove legacy command registrations
- `src/common/webview/commands.ts` - Remove legacy command exports
- `package.json` - Remove legacy commands, update menus
