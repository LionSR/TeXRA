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
/runs/{id}                   → Execution summary (with navigation hints)
/runs/{id}/config            → Agent configuration (JSON, for propose_*)
/runs/{id}/conversation      → Message history (tool calls, responses)
/runs/{id}/files             → List generated files
/runs/{id}/files/{path}      → Read file content
```

Use `current` as `{id}` to access the active execution.

### Design Principles

1. **Separation of concerns** - Config (structured) vs conversation (log) vs files (artifacts)
2. **Read-only** - History is immutable, no `command` parameter needed
3. **Agent-type agnostic** - Works for both tool-use and workflow agents
4. **Single file** - `src/tools/RunsTool.ts`, no subdirectory
5. **Friendly output** - Summary shows what's available, not everything at once

## Schema

```typescript
const RunsToolInputSchema = z.strictObject({
  /** Virtual path: /runs, /runs/{id}, /runs/{id}/files, /runs/{id}/files/{path} */
  path: z.string(),

  /** Optional line range [start, end] for large outputs */
  view_range: z.array(z.int().min(1)).length(2).nullish(),
});
```

No `command` parameter - it's always "view" (read-only).

## Path Semantics

| Path | Source | Returns |
|------|--------|---------|
| `/runs` | `AgentHistoryManager.getHistory()` | List: id, timestamp, agent, model, summary |
| `/runs/{id}` | `AgentHistoryManager` | Summary + navigation hints |
| `/runs/{id}/config` | `AgentHistoryManager` | `AgentConfig` as JSON |
| `/runs/{id}/conversation` | `ExecutionKVStore` → `flow:{id}` | `conversation[]` formatted |
| `/runs/{id}/files` | `StorageFS` → `taskRuns/{id}/` | Directory listing |
| `/runs/{id}/files/{path}` | `StorageFS` → `taskRuns/{id}/{path}` | File content |

### Special: `current`

Use `current` as execution ID to access the active session:

```
runs({ path: '/runs/current' })
runs({ path: '/runs/current/files' })
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
runs({ path: '/runs' })
→ Executions (2):

  abc123  2024-01-15T10:30:00Z  research-assistant  sonnet45  Find related work...
  def456  2024-01-15T11:00:00Z  latex-rewriter      gemini3p  Fix grammar errors...

// View execution summary (friendly, shows what's available)
runs({ path: '/runs/abc123' })
→ Execution: abc123
  Agent: research-assistant
  Model: sonnet45
  Timestamp: 2024-01-15T10:30:00Z
  Task: Find related work

  Available paths:
    /runs/abc123/config - Agent configuration (JSON)
    /runs/abc123/conversation - Message history
    /runs/abc123/files - Generated files

// Get config as JSON (for propose_workflow / propose_agent)
runs({ path: '/runs/abc123/config' })
→ {
    "agent": "research-assistant",
    "model": "sonnet45",
    "tools": ["read_file", "web_search", "arxiv_search"],
    "session": {
      "taskSummary": "Find related work",
      "inputFiles": ["paper.tex"]
    }
  }

// View conversation history
runs({ path: '/runs/abc123/conversation' })
→ [1] user:
  Find papers about quantum computing...

  [2] assistant:
  I'll search for relevant papers...

  [3] assistant:
  [tool_use: arxiv_search({"query": "quantum computing"})]

  [4] user:
  [tool_result: Found 10 papers...]

// List generated files
runs({ path: '/runs/abc123/files' })
→ Files in /runs/abc123/files:

      2.4K  output.tex
      1.2K  summary.md
    <dir>  original
      3.1K  original/input.tex

// Read generated file
runs({ path: '/runs/abc123/files/output.tex' })
→ File: /runs/abc123/files/output.tex

  \documentclass{article}
  ...
```

## Implementation

### Path Parsing

Use existing `getPathSegments` from `src/utils/core/pathCore.ts`:

```typescript
import { getPathSegments } from '@utils/core/pathCore';

// Example: '/runs/abc123/files' → ['runs', 'abc123', 'files']
const segments = getPathSegments(input.path);
const [namespace, id, resource, ...rest] = segments;

if (namespace !== 'runs') throw new ToolError('Path must start with /runs');
if (!id) return this.listRuns();
if (!resource) return this.showExecution(id);  // Config + conversation combined
if (resource === 'files') {
  if (rest.length === 0) return this.listFiles(id);
  return this.readFile(id, rest.join('/'));
}
```

### Files Created

```
src/tools/RunsTool.ts  # Single file, ~280 lines
```

### Files Modified

```
src/tools/registry.ts  # Import + register RunsTool
```

### Existing Utilities to Reuse

| Utility | Location | Usage |
|---------|----------|-------|
| `getPathSegments` | `@utils/core/pathCore` | Parse virtual paths |
| `getCurrentToolFileInteractionContext` | `@agent/toolUse/ToolFileInteractionContext` | Get current executionId |
| `getExecutionStore` | `@agent/storage/ExecutionKVStore` | Read flow records |
| `AgentHistoryManager` | `@common/history` | List executions |
| `StorageFS` | `@utils/files` | Read task run files |

### No Changes Required

- `ExecutionKVStore` - read as-is
- `AgentHistoryManager` - read as-is
- `TaskRunFileService` - read as-is
- `Memory tool` - untouched (follows Anthropic API)
- `pathCore.ts` - already has `getPathSegments`

## Tool Description (for LLM)

```
View execution history and generated files (read-only).

Paths:
- /runs - List all past executions
- /runs/{id} - Execution summary
- /runs/{id}/config - Agent configuration (JSON, use with propose_*)
- /runs/{id}/conversation - Message history
- /runs/{id}/files - List generated files
- /runs/{id}/files/{path} - Read specific file

Use "current" as {id} to access the active execution.
Use view_range: [start, end] to paginate large outputs.
```

## Integration with Agent Proposal Tools

The `/runs/{id}/config` path returns clean JSON, enabling agents to learn and propose new executions:

### Tool-Use Agent History → Propose New Tool-Use Agent

```
// Get past config as JSON
runs({ path: '/runs/abc123/config' })
→ { "agent": "search", "model": "sonnet45", ... }

// Propose similar with modifications
propose_agent({
  agent: "search",
  model: "opus45",
  instruction: "Find papers on linear attention, focusing on memory efficiency"
})
```

### Workflow Agent History → Propose New Workflow

```
// Get past config as JSON
runs({ path: '/runs/def456/config' })
→ { "agent": "correct", "model": "sonnet45", "inputFile": "paper.tex", ... }

// Propose similar with modifications
propose_workflow({
  agent: "correct",
  model: "opus45",
  inputFile: "paper_v2.tex",
  instruction: "Same corrections, plus check citations"
})
```

### Cross-Type Learning

An orchestrating tool-use agent can:
1. List executions: `/runs`
2. Check what worked: `/runs/{id}/config` + `/runs/{id}/conversation`
3. Propose new execution with modifications

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
2. Agent can view execution detail (config + conversation combined)
3. Agent can read generated files from past runs
4. Works for both tool-use and workflow agents
5. No breaking changes to existing code
6. Single file implementation (~280 lines)

## References

- Memory tool pattern: `src/tools/memory/MemoryTool.ts`
- Execution storage: `src/agent/storage/ExecutionKVStore.ts`
- History manager: `src/common/history/AgentHistoryManager.ts`
- Task run files: `src/utils/files/taskRunStorage.ts`
