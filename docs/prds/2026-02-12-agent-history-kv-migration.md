---
created: 2026-02-12
updated: 2026-05-08
---

# PRD: AgentHistoryManager → Thin Index over KV Store

## Status: In Progress (Phase 1 complete)

## Problem

`AgentHistoryManager` stores full `AgentConfig` objects in VS Code workspace state for every execution. This creates dual-write problems:

1. **Config stored in two places**: workspace state (`addToHistory`) and KV store (`config` key). Either can be the source of truth.
2. **Children derived from two places**: `parentExecutionId` filter over 500 history items, or per-child KV keys on the parent's store.
3. **Workspace state is ephemeral**: VS Code can lose workspace state on extension updates, workspace moves, or storage corruption. KV store (filesystem-backed) is durable.
4. **Linear scans**: `getHistoryItemById` and `getChildrenOf` do O(N) scans over the full history array.

## Current State (after Phase 1)

Phase 1 established KV as the primary store with history fallback:

| Data         | KV Key            | Written At                  | Reader               | Fallback                                             |
| ------------ | ----------------- | --------------------------- | -------------------- | ---------------------------------------------------- |
| Config       | `config`          | Execution start             | `readConfig()`       | `getHistoryItemById().agentConfig`                   |
| Metadata     | `meta`            | Execution start             | `readMeta()`         | `getHistoryItemById().{timestamp,parentExecutionId}` |
| Conversation | `conversation`    | Flow completion             | `readConversation()` | `flow:{id}` blob extraction                          |
| Todos        | `todos`           | Flow completion             | `readTodos()`        | `flow:{id}` blob extraction                          |
| Children     | `child-{childId}` | Child launch                | `readChildren()`     | `getChildrenOf()` history scan                       |
| Report       | `report`          | Subagent/process completion | `readReport()`       | (none — always KV)                                   |

`ExecutionsTool.showSummary` reads entirely from KV readers (parallel `Promise.all`). `AgentHistoryManager` is only used for `getHistory()` (the ordered listing in `listExecutions`).

### Remaining overlap

- `AgentHistoryManager.addToHistory` still stores full `AgentConfig` in workspace state.
- `listExecutions` uses `getHistory()` which returns `AgentHistoryItem[]` with full config (used by `formatHistoryLine` for agent name and model).
- Settings view (`SettingsViewMessageHandler.sendHistoryData`) sends full history items to the webview for display and re-run.
- `AcceptRunFilesTool` uses `getHistoryItemById` as an existence check.

## Phase 2: Slim History to Index-Only

### Goal

Reduce `AgentHistoryItem` to index fields only. Full config lives exclusively in KV.

### Changes

**1. Redefine `AgentHistoryItem`**

```typescript
// Before (stores full config)
export interface AgentHistoryItem {
  id: ExecutionId;
  timestamp: string;
  agentConfig: AgentConfig;
  parentExecutionId?: ExecutionId;
}

// After (index fields only)
export interface AgentHistoryItem {
  id: ExecutionId;
  timestamp: string;
  agent: string;
  model: string;
  parentExecutionId?: ExecutionId;
}
```

**2. Update `addToHistory`**

Extract only `agent` and `model` from the config before storing:

```typescript
public static async addToHistory(
  executionId: ExecutionId,
  config: AgentConfig,
  parentExecutionId?: ExecutionId,
): Promise<void> {
  const historyItem: AgentHistoryItem = {
    id: executionId,
    timestamp: new Date().toISOString(),
    agent: config.agent,
    model: config.model ?? 'default',
    parentExecutionId,
  };
  // ...
}
```

**3. Update consumers**

| Consumer                                     | Current                                   | After                                                                      |
| -------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| `formatHistoryLine`                          | `item.agentConfig.agent`                  | `item.agent`                                                               |
| `SettingsViewMessageHandler.sendHistoryData` | Sends full items                          | Sends index items; webview uses `readConfig(id)` for full config on demand |
| `AcceptRunFilesTool`                         | `getHistoryItemById` for existence        | `getExecutionStore(id).exists('meta')`                                     |
| `SettingsViewMessageHandler.withHistoryItem` | Uses `historyItem.agentConfig` for re-run | Calls `readConfig(id)` for full config                                     |

**4. Backward compatibility**

`sanitizeHistoryEntries` already handles legacy formats. Add a migration path:

- Old items with `agentConfig` → extract `agent` and `model`, discard the rest
- New items with `agent`/`model` → use directly

**5. Storage savings**

A typical `AgentConfig` is 500-2000 bytes (instruction text, file paths, tool lists). Index fields are ~80 bytes. For 500 history items, this reduces workspace state from ~500KB to ~40KB.

### Files Modified

| File                                                                | Change                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/common/history/AgentHistoryManager.ts`                         | Slim `AgentHistoryItem`, update `addToHistory` and `sanitizeHistoryEntries` |
| `src/tools/ExecutionsTool.ts`                                       | Update `formatHistoryLine` to use `item.agent`                              |
| `packages/extension/src/settingsView/SettingsViewMessageHandler.ts` | Lazy-load full config via `readConfig()`                                    |
| `packages/extension/src/settingsView/` webview components           | Request config on demand instead of receiving it upfront                    |
| `src/tools/AcceptRunFilesTool.ts`                                   | Use KV existence check                                                      |

## Phase 3: Remove History Fallbacks from Readers (Future)

Once Phase 2 is stable and old workspace state has been migrated:

1. Remove `AgentHistoryManager` fallbacks from `readConfig`, `readMeta`, `readChildren`.
2. Each reader becomes a single KV read — no dynamic imports, no linear scans.
3. `AgentHistoryManager` is only used for `getHistory()` (ordered index) and `deleteHistoryItemById` (cleanup).

### Precondition

All active installations have run at least once with Phase 1 writes (config, meta, child-keys written to KV). This happens naturally after one release cycle.

## Non-Goals

- **Replacing workspace state entirely**: `getHistory()` needs an ordered index. KV directories aren't ordered. Workspace state is the right tool for a small ordered array.
- **Pagination for history listing**: 500 items is the cap and workspace state handles it fine.
- **Moving history to a database**: Over-engineering for a VS Code extension with local-only data.

## Success Criteria

1. `AgentHistoryItem` contains only index fields (~80 bytes per entry)
2. Full config is only in KV — single source of truth
3. No behavioral changes to `ExecutionsTool` or settings view
4. Backward compatible with old workspace state entries
5. `npm run typecheck` passes
