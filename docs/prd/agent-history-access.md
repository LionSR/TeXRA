# PRD: Agent History Access via `/runs` Virtual Filesystem

## Overview

Give tool-use agents read-only access to execution history and generated files through a virtual filesystem interface (`/runs`), following the same pattern as the existing `/memories` tool.

## Problem Statement

Agents currently have:
- ✅ Full access to workspace files via `read_file`, `write_file`, `ls`
- ✅ Full access to `/memories` via `memory` tool
- ❌ No access to execution history (past conversations, tool calls)
- ❌ No access to task run files (generated outputs)

This limits an agent's ability to:
- Learn from previous attempts
- Reference past outputs
- Propose improved configurations based on what worked

## Solution

A new `runs` tool providing read-only virtual filesystem access to execution storage.

### Virtual Filesystem Structure

```
/runs                        → List all executions
/runs/current                → Alias for active execution
/runs/{id}                   → Summary + conversation history
/runs/{id}/config            → AgentConfig JSON
/runs/{id}/files             → List generated files
/runs/{id}/files/{path}      → Read file content
```

### Design Principles

1. **Minimal surface** - 5 path patterns, not 12
2. **Read-only** - History is immutable
3. **Agent-type agnostic** - Works for both tool-use and workflow agents (both have `conversation[]`)
4. **No over-abstraction** - Single tool file, no elaborate backend hierarchy
5. **Follows existing patterns** - Mirrors `/memories` tool interface

## Schema

```typescript
const RunsToolInputSchema = z.strictObject({
  /** Only 'view' supported - runs are read-only */
  command: z.literal('view'),

  /** Virtual path starting with /runs */
  path: z.string(),

  /** Optional line range [start, end] for large outputs */
  view_range: z.array(z.int().min(1)).length(2).nullish(),
});
```

## Path Semantics

| Path | Source | Returns |
|------|--------|---------|
| `/runs` | `AgentHistoryManager.getHistory()` | List: id, agent, timestamp, status |
| `/runs/{id}` | `ExecutionKVStore` → `flow:{id}` | Header + `conversation[]` formatted |
| `/runs/{id}/config` | `ExecutionKVStore` → `flow:{id}` | `agentConfig` as JSON |
| `/runs/{id}/files` | `StorageFS` → `taskRuns/{id}/` | Directory listing |
| `/runs/{id}/files/{path}` | `StorageFS` → `taskRuns/{id}/{path}` | File content |

### Special: `/runs/current`

Resolves to the active execution via `ToolFileInteractionContext.executionId`.

```typescript
function resolveExecutionId(id: string): string {
  if (id === 'current') {
    const ctx = getCurrentToolFileInteractionContext();
    if (!ctx?.executionId) throw new Error('No active execution');
    return ctx.executionId;
  }
  return id;
}
```

## Storage Architecture (Unchanged)

The tool reads from existing storage - no refactoring required:

| Component | Location | What We Read |
|-----------|----------|--------------|
| `AgentHistoryManager` | WorkspaceState | Execution list (id, timestamp, agentConfig) |
| `ExecutionKVStore` | `executions/{id}/flow:{id}.json` | `conversation[]`, `agentConfig` |
| `TaskRunFileService` | `taskRuns/{id}/` | Generated files |

### Tool-Use vs Workflow Agents

Both agent types store accumulated messages in `shared.conversation[]`. The tool does not expose workflow-specific internals (rounds, per-round state) - these are implementation details.

| Agent Type | `conversation[]` | Rounds | Exposed? |
|------------|------------------|--------|----------|
| Tool-use | All messages | N/A | ✅ via `/runs/{id}` |
| Workflow | Accumulated across rounds | Internal | ✅ via `/runs/{id}` (flattened) |

## Example Usage

```
// List past executions
runs({ command: 'view', path: '/runs' })
→ abc123  research-assistant  2024-01-15 10:30  completed
  def456  latex-rewriter      2024-01-15 11:00  completed
  ...

// View execution history
runs({ command: 'view', path: '/runs/abc123' })
→ Agent: research-assistant
  Model: claude-sonnet-4-20250514
  Started: 2024-01-15 10:30:00
  Status: completed

  [1] user: Find papers about quantum computing...
  [2] assistant: I'll search for relevant papers...
  [3] tool_use: arxiv_search({query: "quantum computing"})
  [4] tool_result: Found 10 papers...
  ...

// View config (useful for proposing new runs)
runs({ command: 'view', path: '/runs/abc123/config' })
→ {
    "agent": "research-assistant",
    "model": "claude-sonnet-4-20250514",
    "tools": ["read_file", "web_search", "arxiv_search"],
    "session": {
      "inputFiles": ["paper.tex"],
      "taskSummary": "Find related work"
    }
  }

// List generated files
runs({ command: 'view', path: '/runs/abc123/files' })
→ output.tex      2,451 bytes
  summary.md      1,203 bytes
  original/
    input.tex     3,102 bytes

// Read generated file
runs({ command: 'view', path: '/runs/abc123/files/output.tex' })
→ [file content...]

// Access current session
runs({ command: 'view', path: '/runs/current' })
→ [current execution history so far]
```

## Implementation

### Files to Create

```
src/tools/runs/
├── constants.ts      # RUNS_DISPLAY_ROOT, path patterns
├── RunsTool.ts       # Main tool (~180 lines)
└── index.ts          # Exports
```

### Files to Modify

```
src/tools/registry.ts  # Register RunsTool (1 line)
```

### No Changes Required

- `ExecutionKVStore` - read as-is
- `AgentHistoryManager` - read as-is
- `TaskRunFileService` - read as-is
- `Memory tool` - untouched (follows Anthropic API)

## Tool Description (for LLM)

```
View execution history and generated files (read-only).

Paths:
- /runs - List all past executions
- /runs/current - Current session
- /runs/{id} - Execution summary and conversation history
- /runs/{id}/config - Agent configuration used
- /runs/{id}/files - List generated files
- /runs/{id}/files/{path} - Read specific file

Use view_range: [start, end] to paginate large outputs.
```

## Future Considerations

### Not in Scope (Intentionally)

- **Per-round access for workflows** - Implementation detail, not useful for agents
- **State snapshots** - Debugging concern, not reasoning
- **Write operations** - History is immutable
- **Search/filter** - Keep it simple; can add later if needed

### Potential Extensions (Later)

- `/runs/{id}/tools` - List of tool calls with timing/success
- `/runs/{id}/usage` - Token usage statistics
- Search by agent name or date range

## Success Criteria

1. Agent can list past executions
2. Agent can read conversation history from any execution
3. Agent can view config to understand/propose new runs
4. Agent can read generated files from past runs
5. Works for both tool-use and workflow agents
6. No breaking changes to existing code
7. Implementation < 200 lines

## References

- Memory tool pattern: `src/tools/memory/MemoryTool.ts`
- Execution storage: `src/agent/storage/ExecutionKVStore.ts`
- History manager: `src/common/history/AgentHistoryManager.ts`
- Task run files: `src/utils/files/taskRunStorage.ts`
