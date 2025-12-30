# Subagent UI Flow Design PRD

**Status:** Draft
**Author:** TeXRA Team
**Created:** 2024-12-30
**Last Updated:** 2024-12-30

## Overview

This document describes the design for adding subagent support to TeXRA's tool-use agents, enabling hierarchical agent execution with a native VS Code UI for visualization and interaction.

## Background

### Current State

TeXRA currently supports two agent execution models:

1. **Workflow Agents** (Reflection): Multi-round synchronous processing with CoT reasoning
2. **Tool-Use Agents**: Session-based interactive processing with tool calls

Both models execute agents independently with:
- Single StreamTabId per execution
- No parent-child relationships during execution
- Independent session/state management

### Problem Statement

Complex tasks often benefit from decomposition into specialized subtasks. Currently, users must manually orchestrate multiple agent runs. A subagent system would allow:

- Automatic task decomposition
- Parallel execution of independent subtasks
- Specialized agents for specific capabilities (exploration, coding, review)
- Result aggregation and synthesis

### Inspiration

This design is inspired by Claude Code's Task tool, which spawns specialized subagents:
- `Explore`: Fast codebase exploration
- `Plan`: Architecture and implementation planning
- `claude-code-guide`: Documentation lookup

## Goals

1. **Hierarchical Execution**: Parent agents can spawn child agents
2. **Native UI**: Subagent visualization that feels like VS Code
3. **Minimal Disruption**: Extend existing patterns rather than rewrite
4. **User Control**: Clear visibility and ability to interact with subagents

## Non-Goals

- Real-time collaboration between subagents
- Cross-session subagent persistence
- Unlimited nesting depth (will be capped)

---

## Architecture

### StreamTabId Hierarchy

Extend the flat StreamTabId to support hierarchical paths:

```
Format: {parentId}:{childIndex}

Examples:
  "texra-2024-001"              → Root agent
  "texra-2024-001:1"            → First subagent
  "texra-2024-001:2"            → Second subagent (parallel)
  "texra-2024-001:1:1"          → Nested subagent (depth 2)
```

Utility functions:
```typescript
getParentStreamId(id: StreamTabId): StreamTabId | null
getDepth(id: StreamTabId): number
isDescendantOf(child: StreamTabId, parent: StreamTabId): boolean
getRootStreamId(id: StreamTabId): StreamTabId
```

### Subagent Spawning Model

```
┌─────────────────────────────────────────────────────────────┐
│  Parent Agent (Tool-Use, StreamTabId: A)                    │
│                                                             │
│  Tools Available:                                           │
│  - SpawnSubagent  ← NEW                                     │
│  - Read/Edit/Search                                         │
│  - ...                                                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
           ▼               ▼               ▼
┌──────────────────┐ ┌─────────────┐ ┌─────────────────┐
│ SUBAGENT: Explore│ │SUBAGENT:Coder│ │SUBAGENT: Reviewer│
│ StreamTabId: A.1 │ │StreamTabId:A.2│ │StreamTabId: A.3 │
└────────┬─────────┘ └──────┬──────┘ └────────┬────────┘
         │                  │                  │
         └──────────────────┼──────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │      RESULT AGGREGATION      │
              │  (Merged back to parent)     │
              └─────────────────────────────┘
```

### SpawnSubagent Tool Schema

```typescript
interface SpawnSubagentToolInput {
  subagent_type: 'explore' | 'coder' | 'reviewer' | 'researcher' | 'planner';
  prompt: string;
  model?: 'haiku' | 'sonnet' | 'opus';
  parallel?: boolean;
  inherit_context?: boolean;
}
```

---

## PocketFlow Node Extensions

### New Node Types

```
Node
  │
  ├── SubagentNode             (spawn single subagent)
  │     ├── prep()   → Prepare subagent config
  │     ├── exec()   → Create & run child agent
  │     └── post()   → Merge result, determine next
  │
  ├── ParallelSubagentNode     (spawn multiple in parallel)
  │     ├── prep()   → Prepare array of subagent configs
  │     ├── exec()   → Promise.all(subagents)
  │     └── post()   → Aggregate results
  │
  └── SubagentMergeNode        (combine results)
        ├── prep()   → Collect all subagent results
        ├── exec()   → Merge/synthesize results
        └── post()   → Return to parent flow
```

### Flow Composition Example

```typescript
class ParentAgentFlow extends Flow<ParentServices, ParentShared> {
  nodes = {
    analyze: new AnalyzeTaskNode(),

    spawnExplorers: new ParallelSubagentNode({
      subagentType: 'explore',
      model: 'haiku',
      getConfigs: (shared) => [
        { prompt: 'Find API patterns', scope: 'src/api' },
        { prompt: 'Find UI patterns', scope: 'src/components' },
      ],
    }),

    spawnCoder: new SubagentNode({
      subagentType: 'coder',
      model: 'sonnet',
      inheritContext: true,
    }),

    mergeResults: new SubagentMergeNode(),
    finalize: new FinalizeNode(),
  };

  transitions = {
    analyze: { DEFAULT: 'spawnExplorers' },
    spawnExplorers: { DEFAULT: 'spawnCoder' },
    spawnCoder: { DEFAULT: 'mergeResults' },
    mergeResults: { DEFAULT: 'finalize' },
  };
}
```

---

## Event Bus Extensions

### New Event Types

```typescript
interface SubagentEventPayloads {
  subagentSpawned: SpawnSubagentPayload;
  subagentProgress: UpdateSubagentPayload;
  subagentCompleted: SubagentCompletedPayload;
  updateAgentHierarchy: AgentHierarchyPayload;
}
```

### Schema Definitions

```typescript
// Following existing pattern from src/eventBus/schemas.ts

export const SubagentStatusSchema = z.enum([
  'spawning',
  'running',
  'waiting',
  'completed',
  'error',
  'cancelled',
]);

export const SpawnSubagentPayloadSchema = z.strictObject({
  stream: StreamTabIdSchema,
  subagentStreamId: StreamTabIdSchema,
  subagentType: z.string(),
  label: z.string(),
  model: z.string().optional(),
  prompt: z.string(),
  parentGroupId: z.string().optional(),
  depth: z.number().default(1),
  siblingIndex: z.number().optional(),
});

export const UpdateSubagentPayloadSchema = z.strictObject({
  stream: StreamTabIdSchema,
  subagentStreamId: StreamTabIdSchema,
  status: SubagentStatusSchema,
  progress: z.number().min(0).max(100).optional(),
  endTime: z.number().optional(),
});

export const SubagentCompletedPayloadSchema = z.strictObject({
  stream: StreamTabIdSchema,
  subagentStreamId: StreamTabIdSchema,
  status: z.enum(['completed', 'error', 'cancelled']),
  result: z.any().optional(),
  error: z.string().optional(),
  duration: z.number(),
});
```

---

## UI Design

### Design Principles

1. **VS Code Native**: Use codicons, VS Code color variables, existing patterns
2. **Progressive Disclosure**: Show summary by default, expand for details
3. **Consistent Patterns**: Extend existing TaskGroup and TodoList patterns
4. **Non-Intrusive**: Subagents appear inline within parent's log content

### Status Indicators

| Status | Icon | Color Variable | Animation |
|--------|------|----------------|-----------|
| Spawning | `codicon-loading` | `--vscode-textLink-foreground` | Spin |
| Running | `codicon-sync` | `--vscode-progressBar-background` | Spin |
| Waiting | `codicon-watch` | `--vscode-editorWarning-foreground` | None |
| Completed | `codicon-pass-filled` | `--vscode-testing-iconPassed` | None |
| Error | `codicon-error` | `--vscode-errorForeground` | None |
| Cancelled | `codicon-circle-slash` | `--vscode-descriptionForeground` | None |

### Stream Tabs with Subagents

```
┌────────────────────────────────────┐
│ ┌────────────────────────────────┐ │
│ │ ●  Research & Implement     ▾  │ │  ← Expand indicator
│ │    opus • active            ⚙  │ │
│ ├┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤ │  ← Subtle divider
│ │  ├─ ✓ 🔍 Explore       9.2s   │ │
│ │  ├─ ◐ 💻 Coder      running   │ │
│ │  └─ ○ 📋 Review     pending   │ │
│ └────────────────────────────────┘ │
└────────────────────────────────────┘
```

### Log Content with Subagent Flow

```
▼ ◐ Parent Agent                                    🕐 10:30 • 2m
┃
┃  10:30:01 INFO  Analyzing task requirements...
┃  10:30:05 INFO  Spawning specialized agents
┃
┃  ╭─ ⑂ Subagents ──────────────────────────────────────────────╮
┃  │                                                            │
┃  │  ▼ ✓ 🔍 Explore Codebase                    haiku • 9.2s  │
┃  │  │   10:30:06 Searching for patterns...                    │
┃  │  │   10:30:12 Found 15 endpoints                           │
┃  │  │   10:30:15 ✓ Complete                                   │
┃  │  └─────────────────────────────────────────────────────────│
┃  │                                                            │
┃  │  ▼ ◐ 💻 Implementation                     sonnet • 15.3s │
┃  │  │   10:30:16 Planning implementation...                   │
┃  │  │   ◐ Writing UserController.ts...                        │
┃  │  └─────────────────────────────────────────────────────────│
┃  │                                                            │
┃  │  ▷ ○ 📋 Code Review                        haiku • waiting│
┃  │       Waiting for Implementation...                        │
┃  │                                                            │
┃  ╰────────────────────────────────────────────────────────────╯
┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Todo List with Subagent Attribution

```
┌──────────────────────────────────────────────────────────────────┐
│  ☰ Task Progress                                                 │
│                                                                  │
│  ✓  Search for auth patterns                     🔍 Explore      │
│  ◐  Implementing user login endpoint             💻 Coder        │
│  ○  Add input validation                         💻 Coder        │
│  ○  Review security                              📋 Review       │
│                                                                  │
│  ─────────────────────────────────────────────────────────────   │
│  Progress: ━━━━━━━━━━━░░░░░░░░░░░░░░░░░░░  1/4                   │
└──────────────────────────────────────────────────────────────────┘
```

### Follow-Up with Subagent Targeting

```
┌──────────────────────────────────────────────────────────────────┐
│ Add error handling for the login endpoint                        │
└──────────────────────────────────────────────────────────────────┘

Target: ┌────────────────────┐
        │ 💻 Coder        ▾ │   [✨] [🎤] [⌫] [📤]
        └────────────────────┘
        ┌────────────────────┐
        │ 🎯 Parent Agent   │  ← Send to orchestrator
        │ 💻 Coder (active) │  ← Currently running
        │ 📋 Review         │  ← Queue for later
        └────────────────────┘
```

---

## CSS Implementation

### Subagent Flow Container

```css
.subagent-flow-container {
  margin: var(--spacing-small) 0;
  margin-left: var(--spacing-small);
  padding-left: var(--spacing-medium);
  border-left: var(--border-thin) dashed
    var(--vscode-editorGroupHeader-tabsBorder);
}

.subagent-flow__header {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-tiny);
  font-weight: 500;
  color: var(--color-text-secondary);
  margin-bottom: var(--spacing-small);
  font-size: var(--font-size-sm);
}
```

### Subagent Node with Connectors

```css
.subagent-node {
  position: relative;
  margin: var(--spacing-tiny) 0;
}

/* Vertical connector line */
.subagent-node::before {
  content: '';
  position: absolute;
  left: calc(-1 * var(--spacing-medium));
  top: 0;
  bottom: 0;
  width: var(--border-thin);
  background-color: var(--color-border);
}

/* L-shaped connector for last child */
.subagent-node:last-child::before {
  height: calc(50% + var(--spacing-tiny));
}

/* Horizontal branch */
.subagent-header::before {
  content: '';
  position: absolute;
  left: calc(-1 * var(--spacing-medium));
  top: 50%;
  width: var(--spacing-medium);
  height: var(--border-thin);
  background-color: var(--color-border);
}
```

### Status-Specific Styling

```css
.subagent-node.is-completed .subagent-header .codicon {
  color: var(--color-success);
}

.subagent-node.is-running .subagent-header .codicon {
  color: var(--vscode-progressBar-background);
}

.subagent-node.is-running::before,
.subagent-node.is-running .subagent-header::before {
  background-color: var(--vscode-progressBar-background);
}

.subagent-node.is-pending {
  opacity: var(--opacity-subtle);
}

.subagent-node.is-error .subagent-header .codicon {
  color: var(--color-error);
}
```

---

## State Management

### SubagentFlowManager

```typescript
export class SubagentFlowManager {
  private subagentsByParent: Map<StreamTabId, SubagentNode[]> = new Map();
  private subagentIndex: Map<StreamTabId, SubagentNode> = new Map();

  addSubagent(payload: SpawnSubagentPayload): void {
    const node: SubagentNode = {
      streamId: payload.subagentStreamId,
      parentStreamId: payload.stream,
      type: payload.subagentType,
      label: payload.label,
      model: payload.model,
      status: 'spawning',
      depth: payload.depth,
      siblingIndex: payload.siblingIndex,
      startTime: Date.now(),
    };

    this.subagentIndex.set(node.streamId, node);

    const siblings = this.subagentsByParent.get(payload.stream) ?? [];
    siblings.push(node);
    this.subagentsByParent.set(payload.stream, siblings);
  }

  updateSubagent(payload: UpdateSubagentPayload): void {
    const node = this.subagentIndex.get(payload.subagentStreamId);
    if (!node) return;

    node.status = payload.status;
    if (payload.endTime) {
      node.endTime = payload.endTime;
    }
  }

  getSubagentTree(parentStream: StreamTabId): SubagentNode[] {
    return this.subagentsByParent.get(parentStream) ?? [];
  }

  hasSubagents(stream: StreamTabId): boolean {
    return (this.subagentsByParent.get(stream)?.length ?? 0) > 0;
  }
}
```

---

## Implementation Phases

### Phase 1: Core Infrastructure
- [ ] Add `SpawnSubagentTool` to tool registry
- [ ] Create `SubagentExecutionContext` type
- [ ] Extend event bus with subagent events
- [ ] Add parent-child tracking to `BaseAgent`

### Phase 2: Flow Nodes
- [ ] Create `SubagentNode` extending Node class
- [ ] Implement `ParallelSubagentNode` for concurrent spawning
- [ ] Create `SubagentMergeNode` for result aggregation

### Phase 3: UI Visualization
- [ ] Extend TaskGroup rendering for subagent hierarchy
- [ ] Add subagent tree to stream tabs
- [ ] Implement collapsible subagent details

### Phase 4: Advanced Features
- [ ] Follow-up targeting to specific subagents
- [ ] Todo list subagent attribution
- [ ] Progress indicators for long-running subagents

---

## Configuration Options

### Agent YAML Extensions

```yaml
name: research-agent
type: tool-use
settings:
  subagents:
    enabled: true
    max_depth: 2
    max_parallel: 3
    allowed_types:
      - explore
      - coder
      - reviewer
    default_model: haiku
```

### User Settings

```json
{
  "texra.subagents.enabled": true,
  "texra.subagents.maxDepth": 2,
  "texra.subagents.maxParallel": 3,
  "texra.subagents.showInStreamTabs": true,
  "texra.subagents.autoCollapse": true
}
```

---

## Open Questions

1. **Context Inheritance**: How much context should be passed to subagents?
   - Full conversation history?
   - Summary only?
   - Relevant files/references?

2. **Result Handling**: How should results be merged?
   - Automatic aggregation?
   - User-guided selection?
   - Structured return types?

3. **Depth Limits**: What's the maximum practical nesting depth?
   - Resource/cost considerations
   - UI complexity

4. **Error Recovery**: When a subagent fails:
   - Retry automatically?
   - Prompt user?
   - Fail entire parent?

5. **Cost Attribution**: How to show token usage per subagent?

---

## Appendix: UI Mockups

### Full Window with Active Subagents

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━┓
┃ TeXRA Progress                                                ─ □ ✕ ┃                     ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╋━━━━━━━━━━━━━━━━━━━━━┫
┃                                                                    ┃                     ┃
┃  Research & Implement  ●                         [⟲] [📋] [⏹]      ┃ ┌─────────────────┐ ┃
┃  ────────────────────────────────────────────────────────────────  ┃ │ ● Research &  ▾│█┃
┃                                                                    ┃ │   opus • active │ ┃
┃  ▼ ◐ Main Agent                                     🕐 10:30 • 2m  ┃ ├┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤ ┃
┃  ┃                                                                 ┃ │ ├─ ✓ 🔍 Explore│ ┃
┃  ┃  10:30:01 INFO  Analyzing: implement user authentication        ┃ │ ├─ ◐ 💻 Coder  │ ┃
┃  ┃  10:30:03 INFO  Spawning agents for parallel execution          ┃ │ └─ ○ 📋 Review │ ┃
┃  ┃                                                                 ┃ └─────────────────┘ ┃
┃  ┃  ╭─ ⑂ Subagents ─────────────────────────────────────────────╮  ┃                     ┃
┃  ┃  │                                                           │  ┃ ┌─────────────────┐ ┃
┃  ┃  │  ▼ ✓ 🔍 Explore Codebase                   haiku • 9.2s  │  ┃ │ ✓ Fix typos     │ ┃
┃  ┃  │  │   10:30:04 Searching src/ for auth patterns...         │  ┃ │   haiku • 5m    │ ┃
┃  ┃  │  │   10:30:08 Found middleware in src/middleware/auth.ts  │  ┃ └─────────────────┘ ┃
┃  ┃  │  │   10:30:13 ✓ Exploration complete                      │  ┃                     ┃
┃  ┃  │  │                                                        │  ┃                     ┃
┃  ┃  │  │   ▶ Summary                                            │  ┃                     ┃
┃  ┃  │  │      • Found 3 relevant files                          │  ┃                     ┃
┃  ┃  │  │      • Existing: JWT middleware, bcrypt                │  ┃                     ┃
┃  ┃  │  └────────────────────────────────────────────────────────│  ┃                     ┃
┃  ┃  │                                                           │  ┃                     ┃
┃  ┃  │  ▼ ◐ 💻 Implementation                    sonnet • 23.1s │  ┃                     ┃
┃  ┃  │  │   10:30:14 Received context from Explore               │  ┃                     ┃
┃  ┃  │  │   10:30:16 Planning: 2 new files, 1 modification       │  ┃                     ┃
┃  ┃  │  │                                                        │  ┃                     ┃
┃  ┃  │  │   ▶ 🔧 Creating AuthController.ts                      │  ┃                     ┃
┃  ┃  │  │   │  export class AuthController {                     │  ┃                     ┃
┃  ┃  │  │   │    async login(req, res) { ... }                   │  ┃                     ┃
┃  ┃  │  │   └────────────────────────────────────────────────    │  ┃                     ┃
┃  ┃  │  │                                                        │  ┃                     ┃
┃  ┃  │  │   ◐ Writing src/routes/auth.ts...                      │  ┃                     ┃
┃  ┃  │  └────────────────────────────────────────────────────────│  ┃                     ┃
┃  ┃  │                                                           │  ┃                     ┃
┃  ┃  │  ▷ ○ 📋 Code Review                       haiku • waiting│  ┃                     ┃
┃  ┃  │       Waiting for Implementation to complete...           │  ┃ ───────────────────┃
┃  ┃  ╰───────────────────────────────────────────────────────────╯  ┃ ○All ○Wkfl ●Chat  ┃
┃  ┃                                                                 ┃ [🕐][📄][👤][🗑️]   ┃
┃  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┃                     ┃
┃                                                                    ┃                     ┃
┃  ════════════════════════════════════════════════════════════════  ┃                     ┃
┃  ☰ Task Progress                                            [2/5]  ┃                     ┃
┃   ✓  Search for auth patterns                    🔍 Explore        ┃                     ┃
┃   ◐  Creating AuthController                     💻 Coder          ┃                     ┃
┃   ○  Create auth routes                          💻 Coder          ┃                     ┃
┃   ○  Review security                             📋 Review         ┃                     ┃
┃  ════════════════════════════════════════════════════════════════  ┃                     ┃
┃                                                                    ┃                     ┃
┃  ┌────────────────────────────────────────────────────────────┐    ┃                     ┃
┃  │ Send follow-up to 💻 Coder...                              │    ┃                     ┃
┃  └────────────────────────────────────────────────────────────┘    ┃                     ┃
┃                                            [💻▾] [✨] [🎤] [📤]    ┃                     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┻━━━━━━━━━━━━━━━━━━━━━┛
```

---

## References

- [Claude Code Task Tool](https://docs.anthropic.com/claude-code) - Inspiration for subagent patterns
- [VS Code Webview UI Toolkit](https://github.com/microsoft/vscode-webview-ui-toolkit)
- [TeXRA Agent Architecture](../guide/agent-architecture.md)
- [PocketFlow Design Patterns](../pocketflow/design_pattern/multi_agent.md)
