# Proposal: Git Worktree Mode for Parallel Tool-Use Agents

## Executive Summary

This proposal investigates adding **git worktree-based isolation** to TeXRA's tool-use agent system, enabling multiple agents to work on the same repository in parallel without file conflicts. The core idea: each parallel agent stream gets its own git worktree (a separate checked-out working directory on a different branch), so file reads, writes, and shell commands are isolated from one another and from the user's main workspace.

**Verdict: Feasible, with meaningful architectural work required.** The existing stream/tab infrastructure already supports parallel agent executions. The main gap is that all streams share a single `WorkspaceFS` root, meaning file operations from concurrent agents collide. Git worktrees solve this cleanly.

---

## 1. Problem Statement

### Current Architecture

Today, TeXRA's tool-use agents operate within a single workspace directory:

```
WorkspaceFS.getPath() → vscode.workspace.workspaceFolders[0].uri.fsPath
                      → /home/user/my-paper/
```

**Every tool** resolves paths against this single root:
- `ReadFileTool`, `WriteFileTool`, `EditFileTool` → `resolveWorkspaceRelativePath()` → `WorkspaceFS.getPath()`
- `BashTool` → `executeCommand()` → `cwd: WorkspaceFS.getPath()`
- `GlobTool`, `GrepTool` → same pattern
- `ApplyPathTool` → `git apply` in workspace root

When two tool-use agents run in parallel (which the stream system already supports), they both read and write the same files. This causes:

1. **Write conflicts**: Agent A edits `main.tex` line 50 while Agent B edits line 80 — the second write may clobber the first
2. **Read inconsistency**: Agent A reads a file that Agent B is in the middle of modifying
3. **Shell collisions**: Both agents run `latexmk` simultaneously, fighting over auxiliary files
4. **No clean merge path**: Changes from parallel agents can't be easily reconciled

### What Git Worktrees Provide

`git worktree` creates linked working directories that share the same `.git` object store but have independent:
- Working trees (checked-out files)
- HEAD references (can be on different branches)
- Index files (staging areas)

```bash
# From the main workspace at /home/user/my-paper/
git worktree add /tmp/texra-worktrees/agent-A -b texra/agent-A
git worktree add /tmp/texra-worktrees/agent-B -b texra/agent-B

# Each agent now has an isolated copy of the repository
# Merging results back is a standard git merge operation
```

---

## 2. Feasibility Analysis

### 2.1 What Already Works

**Stream infrastructure supports parallelism.** The `StreamStatusService` (`src/agent/runtime/StreamStatusService.ts`) already tracks multiple concurrent streams. Each stream has an independent `StreamTabId`, `ExecutionId`, status, and lifecycle. The `ProgressView` displays them as tabs with real-time updates.

**Tools are stateless.** Each tool invocation is independent — tools don't cache workspace state between calls. This means redirecting their path resolution to a different directory is safe.

**Command execution supports custom `cwd`.** The `executeCommand()` function (`src/utils/system/execUtils.ts:65`) accepts an optional `cwd` parameter, already defaulting to `WorkspaceFS.getPath()`. Overriding this per-stream is straightforward.

**Event bus is stream-aware.** All progress events include `streamId`, so UI updates are already isolated per stream.

### 2.2 What Needs To Change

#### A. Path Resolution Layer (Medium effort)

The central challenge: `WorkspaceFS.getPath()` is a static method returning the single VS Code workspace folder. Every tool calls this directly or via `resolveWorkspaceRelativePath()`.

**Solution**: Introduce a **stream-scoped workspace root** that tools consult instead of the global `WorkspaceFS`:

```typescript
// New: Stream-aware workspace resolution
interface StreamWorkspace {
  /** The root directory for this stream's file operations */
  rootPath: string;
  /** The branch name this worktree is on */
  branch: string;
  /** Whether this is a worktree (true) or the main workspace (false) */
  isWorktree: boolean;
}

// Injected into tool execution context
interface ToolFileInteractionContext {
  // ...existing fields...
  workspace?: StreamWorkspace;  // NEW: per-stream workspace override
}
```

Tools would check `context.workspace?.rootPath ?? WorkspaceFS.getPath()` for their base directory. This is a contained change — roughly 8-10 tool files need a one-line update to their path resolution.

#### B. Worktree Lifecycle Manager (Medium effort)

A new service manages worktree creation, cleanup, and merge operations:

```typescript
interface WorktreeManager {
  /** Create a worktree for a new parallel stream */
  create(streamId: StreamTabId, baseBranch?: string): Promise<StreamWorkspace>;

  /** Get the workspace for an active stream */
  get(streamId: StreamTabId): StreamWorkspace | undefined;

  /** Merge worktree changes back to a target branch */
  merge(streamId: StreamTabId, targetBranch: string): Promise<MergeResult>;

  /** Clean up worktree when stream is disposed */
  dispose(streamId: StreamTabId): Promise<void>;

  /** List all active worktrees */
  list(): StreamWorkspace[];
}
```

#### C. Execution Context Threading (Low effort)

The `ToolFileInteractionContext` (`src/agent/toolUse/ToolFileInteractionContext.ts`) already uses a stack-based context propagation pattern (`withToolFileInteractionContext()`). Adding a `workspace` field to this context flows naturally through the existing architecture — every tool already accesses this context via `getCurrentToolFileInteractionContext()`.

#### D. Git Integration (Medium effort)

New git operations needed:
- `git worktree add` — create worktrees
- `git worktree remove` — clean up
- `git merge` / `git merge --no-ff` — reconcile changes
- Conflict detection and resolution UI

---

## 3. UI/UX Design Proposal

### 3.1 Overview: The Parallel Workspace Panel

The parallel execution experience is built around a concept of **"Workspaces"** — isolated environments where agents operate independently. The user's main editor remains on the primary workspace; parallel agents work in hidden worktrees and present their results for review and merge.

### 3.2 Launching Parallel Agents

#### Option A: "Branch & Run" Button (Recommended)

Add a **"Run in Parallel"** option to the execution flow. When the user clicks Execute in the main view, a dropdown offers:

```
┌─────────────────────────────────┐
│  ▶  Run                        │  ← Normal execution (current behavior)
│  ⑂  Run in Parallel            │  ← Creates worktree, runs isolated
│  ⑂  Run in Parallel (×3)       │  ← Fan-out: 3 parallel copies
└─────────────────────────────────┘
```

Selecting "Run in Parallel" automatically:
1. Creates a git worktree branching from the current HEAD
2. Names the branch `texra/<agent>-<short-id>` (e.g., `texra/chat-a1b2`)
3. Starts the agent in that worktree
4. Opens a new stream tab in the Progress Board

#### Option B: Explicit Branch Selection

A branch picker dialog appears before parallel execution:

```
┌──────────────────────────────────────────────┐
│  Parallel Execution Setup                    │
│                                              │
│  Base branch:  [main           ▼]            │
│  Agent branch: [texra/chat-a1b2   ] (auto)   │
│                                              │
│  ☐  Auto-merge on completion                 │
│  ☑  Notify when done                         │
│                                              │
│         [Cancel]  [Start Parallel Run]       │
└──────────────────────────────────────────────┘
```

### 3.3 Progress Board: Parallel Stream Indicators

The existing Progress Board tabs gain visual cues for worktree-backed streams:

```
┌──────────────────────────────────────────────────────────────┐
│  Progress Board                                              │
├──────────┬──────────┬──────────────┬─────────────────────────┤
│ ● main   │ ⑂ chat-1 │ ⑂ research-1 │                        │
│ (active) │ ● running│ ✓ done       │                        │
├──────────┴──────────┴──────────────┴─────────────────────────┤
│                                                              │
│  Stream: chat-1                                              │
│  Branch: texra/chat-a1b2                                     │
│  Base:   main @ abc1234                                      │
│  Status: Running (3 tool calls completed)                    │
│                                                              │
│  ┌─ Files Modified ──────────────────────────────────────┐   │
│  │  M  src/introduction.tex    (+12, -3)                 │   │
│  │  M  src/methodology.tex     (+45, -8)                 │   │
│  │  A  figures/diagram-v2.tikz                           │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  [View Diff]  [Merge to Main]  [Discard]                     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Key elements:
- **⑂ icon** distinguishes worktree streams from the main workspace stream
- **Branch name** shown prominently so the user always knows which branch an agent is working on
- **Files Modified** section shows a live `git diff --stat` of the worktree vs. its base
- **Action buttons** at stream level: View Diff, Merge to Main, Discard

### 3.4 Merge Experience

When a parallel agent completes, the user reviews and merges its changes. This is the most critical UX flow.

#### 3.4.1 Merge Preview Panel

Clicking **"Merge to Main"** opens a dedicated merge preview:

```
┌──────────────────────────────────────────────────────────────┐
│  Merge Preview: texra/chat-a1b2 → main                      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Changes to merge:                                           │
│  ──────────────────                                          │
│  M  src/introduction.tex    (+12, -3)    [View] [Skip]       │
│  M  src/methodology.tex     (+45, -8)    [View] [Skip]       │
│  A  figures/diagram-v2.tikz              [View] [Skip]       │
│                                                              │
│  Conflicts: None detected                                    │
│                                                              │
│  Merge strategy:                                             │
│  ○  Fast-forward (linear history)                            │
│  ●  Merge commit (preserve branch history)                   │
│  ○  Squash (single commit)                                   │
│                                                              │
│  Commit message:                                             │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Merge texra/chat-a1b2: Revised introduction and       │  │
│  │ methodology sections per reviewer feedback             │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│         [Cancel]  [Merge & Clean Up]                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

#### 3.4.2 Conflict Resolution

When merging conflicts with changes in the main workspace (or another parallel agent):

```
┌──────────────────────────────────────────────────────────────┐
│  ⚠ Merge Conflict: texra/chat-a1b2 → main                   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  3 files merged cleanly, 1 conflict:                         │
│                                                              │
│  ✓  src/introduction.tex      merged cleanly                 │
│  ✓  figures/diagram-v2.tikz   merged cleanly                 │
│  ✓  src/bibliography.bib      merged cleanly                 │
│  ✗  src/methodology.tex       CONFLICT (lines 45-60)         │
│                                                              │
│  ┌─ src/methodology.tex : lines 45-60 ──────────────────┐   │
│  │                                                       │   │
│  │  <<<<<<< main                                         │   │
│  │  We employ a mixed-methods approach combining         │   │
│  │  qualitative interviews with quantitative surveys.    │   │
│  │  =======                                              │   │
│  │  Our methodology integrates three complementary       │   │
│  │  approaches: semi-structured interviews, large-scale  │   │
│  │  surveys, and observational field studies.             │   │
│  │  >>>>>>> texra/chat-a1b2                              │   │
│  │                                                       │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  Resolution:                                                 │
│  ○  Keep main version                                        │
│  ○  Keep agent version                                       │
│  ●  Open in VS Code diff editor                              │
│  ○  Ask agent to resolve (uses merge agent)                  │
│                                                              │
│         [Cancel Merge]  [Resolve & Continue]                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

The "Ask agent to resolve" option leverages TeXRA's existing **merge agent** (`executeMergeAgent()` in `executeAgent.ts:495`), which already handles three-way merges with AI assistance.

### 3.5 Fan-Out Pattern: Multiple Parallel Agents

For the common use case of trying multiple approaches simultaneously:

```
┌──────────────────────────────────────────────────────────────┐
│  Fan-Out Execution                                           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Task: "Rewrite the introduction to be more engaging"        │
│                                                              │
│  Parallel runs:                                              │
│  ┌────┬──────────┬─────────────┬────────────┐               │
│  │ #  │ Agent    │ Model       │ Status     │               │
│  ├────┼──────────┼─────────────┼────────────┤               │
│  │ 1  │ chat     │ claude-4    │ ● Running  │               │
│  │ 2  │ chat     │ gpt-4o      │ ● Running  │               │
│  │ 3  │ research │ claude-4    │ ● Running  │               │
│  └────┴──────────┴─────────────┴────────────┘               │
│                                                              │
│  When complete:                                              │
│  ●  Compare results side-by-side                             │
│  ○  Auto-merge best result (by cost)                         │
│  ○  Keep all as separate branches                            │
│                                                              │
│         [Cancel All]  [Start All]                            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

After completion, a **comparison view** shows diffs side-by-side:

```
┌──────────────────────────────────────────────────────────────┐
│  Compare Parallel Results                                    │
├───────────────────┬──────────────────┬───────────────────────┤
│  Run 1: chat/cl4  │  Run 2: chat/4o  │  Run 3: research/cl4 │
│  Cost: $0.12      │  Cost: $0.08     │  Cost: $0.15         │
│  Time: 45s        │  Time: 32s       │  Time: 58s           │
│  Files: 2 changed │  Files: 1 changed│  Files: 3 changed    │
├───────────────────┼──────────────────┼───────────────────────┤
│                   │                  │                       │
│  "The rapid       │  "In an era of   │  "Recent advances    │
│   advancement of  │   unprecedented  │   in large language  │
│   artificial..."  │   technological  │   models have        │
│                   │   change..."     │   fundamentally..."  │
│                   │                  │                       │
│  [Select This]    │  [Select This]   │  [Select This]       │
│  [View Full Diff] │  [View Full Diff]│  [View Full Diff]    │
└───────────────────┴──────────────────┴───────────────────────┘
```

### 3.6 Worktree Status Indicators

Throughout the UI, consistent visual language communicates worktree state:

| Icon | Meaning |
|------|---------|
| `●` | Main workspace (no worktree) |
| `⑂` | Worktree-backed stream |
| `⑂●` | Worktree, agent running |
| `⑂✓` | Worktree, agent completed, ready to merge |
| `⑂✗` | Worktree, agent errored |
| `⑂⇄` | Worktree, merge in progress |

### 3.7 Settings & Configuration

New settings in the agent profile/settings view:

```
┌──────────────────────────────────────────────────────────────┐
│  Parallel Execution Settings                                 │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Worktree location:                                          │
│  ● System temp directory  (/tmp/texra-worktrees/)            │
│  ○ Workspace sibling      (../my-paper-worktrees/)           │
│  ○ Custom path            [________________________]         │
│                                                              │
│  Cleanup policy:                                             │
│  ● Auto-delete worktree after merge                          │
│  ○ Keep worktrees until session ends                         │
│  ○ Manual cleanup only                                       │
│                                                              │
│  Max parallel worktrees:  [4  ▼]                             │
│                                                              │
│  Default merge strategy:  [Merge commit  ▼]                  │
│                                                              │
│  ☑  Auto-commit agent changes before merge                   │
│  ☐  Push worktree branches to remote                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Technical Architecture

### 4.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        VS Code Extension Host                    │
│                                                                  │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │  Main View   │    │  Progress Board   │    │ WorktreeManager│ │
│  │  (webview)   │    │  (webview)        │    │  (new service) │ │
│  │              │    │                   │    │                │  │
│  │ [Run ▼]──────┼──→ │ ┌─────┬─────┐    │    │ create()       │  │
│  │  Run Normal  │    │ │main │⑂ w1 │    │    │ dispose()      │  │
│  │  Run Parallel│    │ └─────┴─────┘    │    │ merge()        │  │
│  └──────────────┘    └────────┬─────────┘    │ list()         │  │
│                               │               └───────┬───────┘  │
│                               │                       │          │
│  ┌────────────────────────────▼───────────────────────▼───────┐  │
│  │                    executeAgent()                           │  │
│  │                                                            │  │
│  │  if (parallel) {                                           │  │
│  │    workspace = worktreeManager.create(streamId);           │  │
│  │    flowContext.workspaceRoot = workspace.rootPath;          │  │
│  │  }                                                         │  │
│  │                                                            │  │
│  │  runToolUseFlow(flowContext)                                │  │
│  └────────────────────────────┬───────────────────────────────┘  │
│                               │                                  │
│  ┌────────────────────────────▼───────────────────────────────┐  │
│  │              Tool Execution (per tool call)                │  │
│  │                                                            │  │
│  │  withToolFileInteractionContext({                           │  │
│  │    workspace: { rootPath: '/tmp/texra-wt/agent-A' },       │  │
│  │    ...                                                     │  │
│  │  }, async () => {                                          │  │
│  │    // Tool resolves paths against context.workspace         │  │
│  │    // instead of global WorkspaceFS                         │  │
│  │  })                                                        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    File System                             │  │
│  │                                                            │  │
│  │  /home/user/my-paper/          (main workspace)            │  │
│  │  /tmp/texra-wt/agent-A/        (worktree for stream 1)    │  │
│  │  /tmp/texra-wt/agent-B/        (worktree for stream 2)    │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Key Implementation Details

#### Worktree Creation

```typescript
// WorktreeManager.create() implementation sketch
async create(streamId: StreamTabId, baseBranch?: string): Promise<StreamWorkspace> {
  const mainWorkspace = WorkspaceFS.getPath();
  const branchName = `texra/${sanitize(streamId)}`;
  const worktreePath = path.join(this.baseDir, sanitize(streamId));

  // Create worktree with a new branch from current HEAD (or specified base)
  const base = baseBranch ?? 'HEAD';
  await executeCommand(
    ['git', 'worktree', 'add', '-b', branchName, worktreePath, base],
    { cwd: mainWorkspace }
  );

  const workspace: StreamWorkspace = {
    rootPath: worktreePath,
    branch: branchName,
    isWorktree: true,
  };

  this.worktrees.set(streamId, workspace);
  return workspace;
}
```

#### Tool Path Resolution Change

The change to tools is minimal. In `src/tools/utils.ts`:

```typescript
// Before:
export function resolveWorkspaceRelativePath(targetPath?: string): WorkspacePathResolution {
  const workspacePath = WorkspaceFS.getPath();
  // ...
}

// After:
export function resolveWorkspaceRelativePath(
  targetPath?: string,
  overrideRoot?: string,  // NEW parameter
): WorkspacePathResolution {
  const workspacePath = overrideRoot ?? WorkspaceFS.getPath();
  // ... rest unchanged
}
```

Tools pass the override from their execution context:

```typescript
// In ReadFileTool.execute():
const ctx = getCurrentToolFileInteractionContext();
const { path } = resolveWorkspaceRelativePath(input.path, ctx?.workspace?.rootPath);
```

#### Merge Operation

```typescript
async merge(streamId: StreamTabId, targetBranch: string): Promise<MergeResult> {
  const workspace = this.worktrees.get(streamId);
  const mainWorkspace = WorkspaceFS.getPath();

  // Auto-commit any uncommitted changes in the worktree
  await executeCommand(['git', 'add', '-A'], { cwd: workspace.rootPath });
  await executeCommand(
    ['git', 'commit', '-m', `TeXRA: agent changes from ${streamId}`],
    { cwd: workspace.rootPath }
  );

  // Merge into target branch from main workspace
  const result = await executeCommand(
    ['git', 'merge', '--no-ff', workspace.branch, '-m', `Merge ${workspace.branch}`],
    { cwd: mainWorkspace }
  );

  if (!result.success && result.stderr?.includes('CONFLICT')) {
    return { status: 'conflict', conflicts: parseConflicts(result.stderr) };
  }

  return { status: 'success' };
}
```

### 4.3 Safety Constraints

1. **Worktree branch uniqueness**: Git enforces that no two worktrees can have the same branch checked out. The `texra/<streamId>` naming convention prevents collisions.

2. **Lock file handling**: Git uses lock files in `.git/worktrees/`. If TeXRA crashes, stale worktrees can be cleaned up with `git worktree prune`.

3. **Disk space**: Worktrees share the object store, so only modified files consume additional disk space. For LaTeX projects (typically small), this is negligible.

4. **Path escaping prevention**: The existing `resolveWorkspaceRelativePath()` already validates that paths don't escape the workspace root. This protection applies equally to worktree roots.

5. **Concurrent git operations**: Git's internal locking (via `.git/index.lock`) prevents corruption. Since each worktree has its own index, concurrent operations across worktrees are safe. Operations on the shared object store use atomic file operations.

---

## 5. Storage Layer Analysis

A worktree-backed agent operates in a different filesystem root than the main workspace. Every storage layer that reads or writes files—or records paths—must handle this correctly. Here's the audit.

### 5.1 Storage Architecture Overview

TeXRA uses three distinct storage backends:

| Backend | Location | Scope | Used By |
|---------|----------|-------|---------|
| **StorageFS** | `context.storageUri` (VS Code per-workspace) | Per VS Code workspace window | ExecutionKVStore, TaskRunFileService |
| **GlobalStorageFS** | `context.globalStorageUri` | Shared across all workspaces | Model settings, API keys |
| **workspaceSM** | VS Code `Memento` (workspace state) | Per VS Code workspace window | ProgressViewState, AgentHistoryManager |

### 5.2 Impact Matrix

| Component | File | Storage Backend | Worktree Impact | Action Required |
|-----------|------|----------------|-----------------|-----------------|
| **ExecutionKVStore** | `src/agent/storage/ExecutionKVStore.ts` | StorageFS → `executions/{executionId}/` | **Safe.** Keyed by `ExecutionId` (UUID), not by path. All worktree streams share the same StorageFS. | None |
| **PersistedFlow** | `src/agent/node/persisted-flow.ts` | ExecutionKVStore → `flow:{executionId}` | **Safe.** Execution-scoped, no path references in keys. | None |
| **TaskRunFileService** | `src/utils/files/taskRunStorage.ts` | StorageFS → `taskRuns/{executionId}/` | **Needs attention.** Uses `WorkspaceFS.getPath()` via `this.workspaceRoot` (line 288-289) to resolve `relativePath` in `FileLocation` objects. Worktree streams produce `absolutePath` values pointing to the worktree, but `relativePath` is resolved against the main workspace. | Pass worktree root into `TaskRunFileService` constructor or `createLocation()` |
| **FileInteractionState** | `src/agent/core/AgentWorkspaceState.ts` | In-memory (serialized to snapshots) | **Safe.** Stores relative paths (`readFiles`, `edits`). Relative paths are the same in main workspace and worktrees since both checkout the same tree structure. | None |
| **ProgressViewState** | `src/progressView/state/ProgressViewState.ts` | workspaceSM → `texra.streamTabs`, etc. | **Safe.** Keys are stream-scoped constants, not path-derived. All streams (main + worktree) write to the same workspace memento. | None |
| **OutputFilesManager** | `src/progressView/managers/OutputFilesManager.ts` | workspaceSM → `texra.outputFiles` | **Needs attention.** Stores `FileLocation` objects with `absolutePath`. Worktree output paths would point to temp directories. Need to normalize to workspace-relative or store the worktree root alongside. | Store `worktreeRoot` in output file metadata, or translate paths at merge time |
| **AgentHistoryManager** | `src/common/history/AgentHistoryManager.ts` | workspaceSM → key derived from `workspaceFolder.uri.fsPath` (line 160-161) | **Safe for worktree mode.** Worktrees are NOT opened as VS Code workspace folders—they're invisible directories used by the agent. The workspace folder stays the same (the main repo), so the history key doesn't change. | None (but would break if worktrees were added as multi-root workspace folders) |
| **Tool-Use Session Snapshots** | `src/agent/implementations/flows/tooluse/ToolUseSessionTypes.ts` | ExecutionKVStore | **Needs attention.** Snapshots serialize conversation messages that may contain absolute file paths from tool results. On resume, these paths must remain valid. If the worktree was cleaned up, paths in the snapshot point to deleted directories. | Either: (a) keep worktree alive while snapshot exists, or (b) translate paths in snapshot to workspace-relative on save |
| **UsageLogService** | `src/logger/UsageLogService.ts` | Remote (Supabase) | **Safe.** No local path storage. | None |

### 5.3 The `TaskRunFileService` Problem

This is the most significant storage concern. `TaskRunFileService` (line 234-544) manages output file locations and has two modes:

1. **Workspace mode** (`storageMode: 'workspace'`): Outputs written to workspace directory
2. **TaskRunStorage mode** (`storageMode: 'taskRunStorage'`): Outputs written to `StorageFS/taskRuns/{executionId}/`

In workspace mode, `createLocation()` resolves paths against `this.workspaceRoot` (line 288: `WorkspaceFS.getPath()`). For worktree agents, this must resolve against the worktree root instead.

**Fix**: Add an optional `workspaceRoot` override to `TaskRunFileService`:

```typescript
export class TaskRunFileService {
  private readonly workspaceRootOverride?: string;

  constructor(executionId?: ExecutionId, workspaceRoot?: string) {
    this.workspaceRootOverride = workspaceRoot;
    // ...existing init...
  }

  private get workspaceRoot(): string | undefined {
    return this.workspaceRootOverride ?? WorkspaceFS.getPath();
  }
  // ...rest unchanged—workspaceRoot is already accessed via this getter...
}
```

Since `workspaceRoot` is already accessed through a getter (line 288-289), the change is minimal—just add the override source. The `createLocation()`, `createRawOutputLocation()`, and `prepareRunWorkspace()` methods all flow through this getter.

### 5.4 The `pathToLocation()` Problem

The standalone `pathToLocation()` function (line 580-598) is used by code that doesn't have access to `TaskRunFileService`. It calls `WorkspaceFS.getPath()` directly. For worktree contexts, callers would need to use `TaskRunFileService.createLocation()` instead, which supports the root override.

**Mitigation**: In worktree contexts, always use `TaskRunFileService` (which is already available in the flow services) rather than the standalone `pathToLocation()`.

### 5.5 Snapshot Path Stability

Tool-use session snapshots serialize conversation history including tool results with file paths. If an agent in worktree `/tmp/texra-wt/chat-a1b2/` reads `main.tex`, the conversation might contain:

```
Tool result: Read file /tmp/texra-wt/chat-a1b2/main.tex (425 lines)
```

On session resume after worktree cleanup, this path is stale. However, this is acceptable because:
1. The path in conversation history is informational—the agent re-reads files via tool calls
2. The worktree can be recreated from the branch (which persists until explicitly deleted)
3. `PersistedFlow` state contains the flow execution graph, not file contents

**Recommendation**: On resume, if the worktree for a snapshot's stream no longer exists, recreate it from the branch before resuming execution.

### 5.6 Storage Diagram for Worktree Mode

```
StorageFS (per VS Code workspace, shared by all streams)
├── executions/
│   ├── {exec-id-main}/           ← main workspace agent
│   │   └── flow:{exec-id}.json
│   ├── {exec-id-wt-1}/           ← worktree agent 1
│   │   └── flow:{exec-id}.json
│   └── {exec-id-wt-2}/           ← worktree agent 2
│       └── flow:{exec-id}.json
└── taskRuns/
    ├── {exec-id-main}/           ← output files (main)
    ├── {exec-id-wt-1}/           ← output files (worktree 1)
    └── {exec-id-wt-2}/           ← output files (worktree 2)

workspaceSM (VS Code Memento, shared by all streams)
├── texra.streamTabs              ← includes worktree stream metadata
├── texra.taskStates              ← per-stream, includes worktree streams
├── texra.outputFiles             ← FileLocations (may point to worktree paths)
└── texra.agentHistory.{path}     ← keyed by main workspace path (unchanged)

File System
├── /home/user/my-paper/          ← main workspace (user sees this)
├── /tmp/texra-wt/chat-a1b2/      ← worktree (agent operates here)
│   ├── main.tex                  ← independent working copy
│   ├── .git                      ← file pointing to main repo's .git/worktrees/
│   └── ...
└── /tmp/texra-wt/research-c3d4/  ← another worktree
```

**Key insight**: ExecutionKVStore and TaskRunFileService are keyed by `ExecutionId` (UUID), not by filesystem path. This means worktree agents naturally get isolated storage without any key collision, even though they share the same `StorageFS` backend. The only changes needed are in path resolution for `FileLocation` objects.

---

## 6. PR Workflow: Publishing and Retrieving Worktree Branches

Git worktrees create real branches. This opens a natural integration point: push branches to a remote and open pull requests, enabling collaboration with human reviewers or CI pipelines.

### 6.1 Push & PR Creation

After an agent completes work in a worktree, the user can publish the branch and open a PR — either to the same repo or to a fork.

#### UI: Post-Completion Actions

The stream completion panel gains a **"Create PR"** action alongside Merge and Discard:

```
┌──────────────────────────────────────────────────────────────┐
│  Stream: ⑂ chat-a1b2  ✓ Completed                           │
│  Branch: texra/chat-a1b2                                     │
│  Files:  3 changed (+57, -11)                                │
│                                                              │
│  [View Diff]  [Merge Locally]  [Create PR]  [Discard]        │
└──────────────────────────────────────────────────────────────┘
```

Clicking **"Create PR"** opens a dialog:

```
┌──────────────────────────────────────────────────────────────┐
│  Create Pull Request                                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Remote:    [origin              ▼]                          │
│  Base:      [main                ▼]                          │
│  Branch:    texra/chat-a1b2        (will be pushed)          │
│                                                              │
│  Title:                                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Revise introduction and methodology sections          │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Description:               [Auto-generate from agent log]   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ## Changes                                            │  │
│  │ - Rewrote introduction for clarity (introduction.tex) │  │
│  │ - Expanded methodology with three approaches          │  │
│  │ - Added new TikZ diagram (figures/diagram-v2.tikz)    │  │
│  │                                                       │  │
│  │ ## Agent Context                                      │  │
│  │ Agent: chat | Model: claude-4 | Cost: $0.12           │  │
│  │ Instruction: "Rewrite intro to be more engaging"      │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ☑  Include agent execution summary in PR description        │
│  ☐  Request review from: [____________]                      │
│  ☐  Mark as draft PR                                         │
│                                                              │
│         [Cancel]  [Push & Create PR]                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

#### Implementation

The existing Overleaf clone command already demonstrates git remote operations. The PR workflow extends this:

```typescript
interface WorktreePRService {
  /** Push worktree branch to remote */
  push(streamId: StreamTabId, remote?: string): Promise<void>;

  /** Create a pull request via `gh` CLI or GitHub API */
  createPR(options: {
    streamId: StreamTabId;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
    reviewers?: string[];
  }): Promise<{ url: string; number: number }>;

  /** Check PR status (merged, open, closed, checks) */
  getPRStatus(streamId: StreamTabId): Promise<PRStatus>;

  /** Fetch and merge a remote PR's result back into the main workspace */
  pullMergedPR(prNumber: number): Promise<void>;
}
```

**Auto-generated PR description**: The agent's execution log (stored in `ProgressViewState`) contains the instruction, tool calls, and file changes. This can be summarized into a PR description automatically, including:
- The user's original instruction
- Files modified with line change counts
- Agent name, model, and cost
- A condensed log of key tool calls

#### `gh` CLI Integration

For GitHub-hosted repos, use the `gh` CLI (widely installed, handles auth natively):

```typescript
// Push branch
await executeCommand(
  ['git', 'push', '-u', remote, workspace.branch],
  { cwd: workspace.rootPath }
);

// Create PR via gh CLI
const result = await executeCommand(
  ['gh', 'pr', 'create',
   '--base', base,
   '--head', workspace.branch,
   '--title', title,
   '--body', body,
   ...(draft ? ['--draft'] : []),
  ],
  { cwd: workspace.rootPath }
);
// result.stdout contains the PR URL
```

For non-GitHub remotes (GitLab, Bitbucket, Overleaf), fall back to push-only with a link to create the PR manually.

### 6.2 Retrieving Merged PRs

When a PR is merged on the remote (by a collaborator or CI), the user needs to pull those changes back into their main workspace.

#### UI: PR Status Tracking

Worktree streams with published PRs show live status:

```
┌──────────────────────────────────────────────────────────────┐
│  Stream: ⑂ chat-a1b2                                        │
│  Branch: texra/chat-a1b2                                     │
│  PR:     #42 — "Revise introduction" (open)                  │
│          ● 2 checks passing, 1 review pending                │
│                                                              │
│  [View on GitHub]  [Refresh Status]  [Pull & Merge]          │
└──────────────────────────────────────────────────────────────┘
```

When the PR is merged on the remote:

```
┌──────────────────────────────────────────────────────────────┐
│  Stream: ⑂ chat-a1b2                                        │
│  Branch: texra/chat-a1b2                                     │
│  PR:     #42 — "Revise introduction" (merged ✓)              │
│                                                              │
│  The PR was merged on GitHub. Pull changes into your         │
│  local workspace?                                            │
│                                                              │
│  [Pull to Main]  [Dismiss]  [Clean Up Branch]                │
└──────────────────────────────────────────────────────────────┘
```

#### Pull-Back Flow

```typescript
async pullMergedPR(prNumber: number): Promise<void> {
  const mainWorkspace = WorkspaceFS.getPath();

  // Fetch latest from remote
  await executeCommand(['git', 'fetch', 'origin'], { cwd: mainWorkspace });

  // Pull into current branch (typically main)
  await executeCommand(['git', 'pull', 'origin', 'main'], { cwd: mainWorkspace });

  // Clean up local worktree and branch
  const streamId = this.prToStream.get(prNumber);
  if (streamId) {
    await this.worktreeManager.dispose(streamId);
    await executeCommand(
      ['git', 'branch', '-d', this.worktrees.get(streamId).branch],
      { cwd: mainWorkspace }
    );
  }
}
```

### 6.3 Overleaf Integration

For Overleaf-backed repos (cloned via `texra.cloneOverleafProject`), the PR workflow adapts:

- **Push**: Works normally — Overleaf repos have a git remote
- **PR creation**: Not applicable (Overleaf doesn't have PRs), but the pushed branch becomes visible in Overleaf's history
- **Alternative**: Instead of PRs, offer a "Push to Overleaf" action that pushes the worktree branch and fast-forward merges it on the remote, making the changes visible to Overleaf collaborators immediately

### 6.4 End-to-End PR Workflow

```
User                    TeXRA                   GitHub
  │                       │                       │
  │  Agent completes      │                       │
  │  Click "Create PR"    │                       │
  ├──────────────────────>│                       │
  │                       │  git push origin      │
  │                       │  texra/chat-a1b2      │
  │                       ├──────────────────────>│
  │                       │                       │
  │                       │  gh pr create         │
  │                       ├──────────────────────>│
  │                       │  ← PR #42 created     │
  │                       │<──────────────────────┤
  │  "PR #42 created"     │                       │
  │  [View on GitHub]     │                       │
  │<──────────────────────┤                       │
  │                       │                       │
  │  ... reviewer merges  │                       │
  │  ... on GitHub        │                       │
  │                       │                       │
  │                       │  (poll or webhook)    │
  │                       │  PR #42 merged        │
  │  "PR merged! Pull?"   │<──────────────────────┤
  │<──────────────────────┤                       │
  │                       │                       │
  │  Click "Pull to Main" │                       │
  ├──────────────────────>│                       │
  │                       │  git pull origin main │
  │                       ├──────────────────────>│
  │                       │  ← changes pulled     │
  │                       │<──────────────────────┤
  │  "Local workspace     │                       │
  │   updated!"           │  (cleanup worktree)   │
  │<──────────────────────┤                       │
```

### 6.5 PR Status Polling

For tracking PR status without webhooks (simpler, no server needed):

```typescript
// Poll on a timer or on user action ("Refresh Status")
async checkPRStatus(streamId: StreamTabId): Promise<PRStatus> {
  const prNumber = this.streamToPR.get(streamId);
  if (!prNumber) return { state: 'none' };

  const result = await executeCommand(
    ['gh', 'pr', 'view', String(prNumber), '--json', 'state,mergeable,statusCheckRollup'],
    { cwd: WorkspaceFS.getPath() }
  );

  return JSON.parse(result.stdout);
}
```

Poll frequency: check on Progress Board focus, or every 5 minutes while a PR is open. No background daemon needed.

---

## 7. Interaction Flows

### 7.1 Happy Path: Single Parallel Agent

```
User                    TeXRA                   Git
  │                       │                       │
  │  Click "Run Parallel" │                       │
  ├──────────────────────>│                       │
  │                       │  git worktree add     │
  │                       ├──────────────────────>│
  │                       │  ← worktree created   │
  │                       │<──────────────────────┤
  │                       │                       │
  │  New tab appears:     │                       │
  │  "⑂ chat-a1b2"        │                       │
  │<──────────────────────┤                       │
  │                       │                       │
  │                       │  Agent runs in        │
  │                       │  worktree directory   │
  │  Live progress in tab │  (isolated)           │
  │<──────────────────────┤                       │
  │                       │                       │
  │  Agent completes      │                       │
  │  "⑂✓ chat-a1b2"       │                       │
  │<──────────────────────┤                       │
  │                       │                       │
  │  Click "Merge"        │                       │
  ├──────────────────────>│                       │
  │                       │  git commit + merge   │
  │                       ├──────────────────────>│
  │                       │  ← merge successful   │
  │                       │<──────────────────────┤
  │                       │                       │
  │  "Changes merged!"    │  git worktree remove  │
  │<──────────────────────┤──────────────────────>│
  │                       │                       │
```

### 7.2 Fan-Out with Comparison

```
User                    TeXRA
  │                       │
  │  "Run Parallel (×3)"  │
  ├──────────────────────>│
  │                       │  Create 3 worktrees
  │                       │  Start 3 agents
  │                       │
  │  3 tabs appear:       │
  │  ⑂ run-1, ⑂ run-2,   │
  │  ⑂ run-3              │
  │<──────────────────────┤
  │                       │
  │  ... agents complete  │
  │                       │
  │  "Compare Results"    │
  │  opens comparison     │
  │<──────────────────────┤
  │                       │
  │  Select best result   │
  ├──────────────────────>│
  │                       │  Merge selected,
  │                       │  discard others
  │  "Run 2 merged,       │
  │   others cleaned up"  │
  │<──────────────────────┤
```

---

## 8. Edge Cases & Mitigations

| Scenario | Mitigation |
|----------|-----------|
| **Workspace is not a git repo** | Disable "Run in Parallel" button; show tooltip explaining git requirement |
| **Uncommitted changes in main** | Warn user before creating worktree; offer to stash or commit first |
| **Worktree creation fails** (disk space, permissions) | Fall back to normal execution with warning; show error with actionable fix |
| **Agent modifies `.gitignore`** | Changes are branch-local; merge handles normally |
| **Agent tries to run `git checkout`** | Safe — git prevents checking out a branch that's used by another worktree |
| **VS Code file watchers** | Worktree dirs are outside the workspace; no interference with file watchers |
| **Large binary files** | Git worktrees share objects; only working tree copies consume space |
| **Extension restarts mid-execution** | Worktree persists on disk; `git worktree list` can rediscover; resumption via snapshot system |
| **Multiple merges conflict** | Present sequential merge UI; later merges see earlier merged changes |
| **User manually modifies worktree** | No prevention needed; worktree is a regular git checkout |
| **Submodules** | `git worktree add` handles submodules if configured; may need `--recurse-submodules` |

---

## 9. Implementation Phases

### Phase 1: Foundation (Core Infrastructure)
- Implement `WorktreeManager` service (create, dispose, list)
- Add `StreamWorkspace` to `ToolFileInteractionContext`
- Update `resolveWorkspaceRelativePath()` to accept override root
- Update tool implementations to use context-aware path resolution
- Add worktree cleanup on extension deactivation

### Phase 2: Basic Parallel Execution
- Add "Run in Parallel" option to main view execution flow
- Show worktree-backed streams with `⑂` indicators in Progress Board
- Display modified files list per worktree stream
- Implement basic merge (auto-commit + merge to current branch)
- Add "Discard" action to remove worktree without merging

### Phase 3: Merge Experience
- Build merge preview panel with file-by-file review
- Implement conflict detection and resolution UI
- Integrate with existing merge agent for AI-assisted conflict resolution
- Add merge strategy selection (fast-forward, merge commit, squash)
- Show diff viewer leveraging VS Code's built-in diff editor

### Phase 4: Fan-Out & Comparison
- Add fan-out dialog for launching multiple parallel agents
- Build comparison view for side-by-side result review
- Implement "select best" workflow with automatic cleanup of unselected
- Add cost/time/changes metrics to comparison view

### Phase 5: Polish & Settings
- Worktree location configuration
- Cleanup policy settings
- Max parallel worktrees limit
- Keyboard shortcuts for common operations
- Stale worktree detection and cleanup prompts

---

## 10. Risks & Open Questions

### Risks

1. **Complexity vs. usage frequency**: If parallel execution is rare, the maintenance burden may not justify the implementation. Consider measuring demand via telemetry on the existing (non-isolated) parallel execution feature first.

2. **Git requirement**: This feature requires the workspace to be a git repository. LaTeX projects not using git would be excluded. However, most academic projects using TeXRA likely already use git (or Overleaf, which is git-backed).

3. **Worktree awareness in prompts**: The agent's system prompt needs to mention it's operating in a worktree. Without this, the agent might try `git checkout main` or similar operations that would fail or cause confusion.

### Open Questions

1. **Should worktree agents see each other's changes?** Currently proposed as fully isolated. An alternative is periodic sync (rebase on main), but this adds complexity.

2. **Should the user be able to open a worktree in VS Code?** VS Code supports multi-root workspaces — we could add the worktree as a workspace folder for direct editing. This is powerful but may confuse the mental model.

3. **What about non-git version control?** (Mercurial, SVN) — These don't have worktree equivalents. The feature would be git-only.

4. **Workflow agents too?** This proposal focuses on tool-use agents, but workflow agents (which read/write specific files) could also benefit. The same worktree isolation would apply, but the merge UX is different since workflow agents produce output files rather than editing in-place.

---

## 11. Alternatives Considered

### A. Copy-Based Isolation (Rejected)
Copy the entire workspace to a temp directory per agent. Simpler but wasteful — large repos would be slow to copy and consume significant disk space. No built-in merge story; would need custom diff/patch logic.

### B. In-Memory Virtual FS (Rejected)
Intercept all file operations at the tool level and maintain an in-memory overlay. Appealing for speed, but breaks shell commands (`bash` tool runs real processes that need real files). The `latexmk` compiler needs actual files on disk.

### C. Docker/Container Isolation (Rejected)
Run each agent in a container with a bind-mounted workspace. Provides strong isolation but adds Docker as a dependency, increases latency, and complicates the development setup. Overkill for the file-conflict problem.

### D. File Locking (Rejected)
Prevent concurrent writes to the same file. Simpler but doesn't solve the fundamental problem — agents need to make changes to the same file independently (e.g., two agents both improving `introduction.tex`). Locking would serialize the work, defeating the purpose.

### E. Branch-Only (No Worktree) (Rejected)
Switch branches in the main workspace before each tool call. This would disrupt the user's editor state, trigger VS Code file watchers constantly, and create a terrible experience. Worktrees avoid all of this by keeping the main workspace untouched.

---

## 12. Summary

Git worktree mode for parallel tool-use agents is **feasible and architecturally clean**. The key enabler is that TeXRA's tool system already has the right abstraction boundaries:

- Tools are stateless and resolve paths through a central utility
- The stream/tab system already supports parallel executions
- The execution context uses stack-based propagation that can carry workspace overrides
- Git worktrees provide battle-tested isolation with built-in merge semantics

The main implementation effort is in the **path resolution override** (touching ~10 tool files with small changes), the **WorktreeManager service** (new, ~300-400 lines), and the **merge UX** (new webview panels). The existing Progress Board, event bus, and stream infrastructure require minimal changes.

The result would give TeXRA a genuinely differentiated capability: AI agents that work in parallel on the same LaTeX project, each in their own isolated branch, with a clean merge-and-compare workflow for selecting the best results.

---

## Appendix A: Review — Linus Torvalds Style

*The following is a critical review of this proposal written in the style of Linus Torvalds reviewing a kernel patch series.*

---

### On the overall approach

Ok, so I actually *like* the fundamental idea here. Using worktrees for isolation is the correct answer. You correctly rejected the brain-damaged alternatives — copying the whole tree, in-memory virtual FS, Docker containers. Those are the kind of "solutions" that people who don't understand git come up with. Worktrees exist *precisely* for this use case: multiple working trees, shared object store, independent indexes. That's what they were designed for. Good.

But let me tear apart the things that are wrong, because there are several.

### On `git add -A` in the merge operation

This:

```typescript
await executeCommand(['git', 'add', '-A'], { cwd: workspace.rootPath });
await executeCommand(
  ['git', 'commit', '-m', `TeXRA: agent changes from ${streamId}`],
  { cwd: workspace.rootPath }
);
```

No. Absolutely not. `git add -A` is *never* acceptable in automated tooling. You know what `-A` does? It stages **everything**. Every `.aux` file, every `.log` file, every `.synctex.gz`, every temporary build artifact that `latexmk` left behind. You're building a tool for LaTeX users — their working directories are *full* of build garbage.

You need to either:
1. Stage only the files the agent actually modified (you *have* this information in `FileInteractionState.edits`), or
2. At minimum, respect `.gitignore` (which `git add -A` does, but won't save you from untracked files the user forgot to ignore)

The right approach: build the commit from the tracked edits list. You know exactly which files the agent touched because your tool-use system records every `write_file` and `edit_file` call. Use that.

```typescript
const editedFiles = workspace.tracker.getEditedPaths();
await executeCommand(['git', 'add', '--', ...editedFiles], { cwd: workspace.rootPath });
```

Don't be lazy about this. Sloppy staging in automated tools is how people end up with 500MB commits containing `main.pdf` and the entire `__pycache__` directory.

### On the merge strategy

Your merge sketch runs `git merge --no-ff` in the *main workspace*. Think about what this means. The user's main workspace might have a dirty working tree. They might be in the middle of editing a file. You're going to run a merge *into their live checkout* while they're working?

At minimum, you need to check for uncommitted changes and abort if the working tree is dirty. Better yet: do the merge in the worktree itself (merge main into the worktree branch), verify it's clean, *then* fast-forward main to the result. That way you never touch the user's working tree in an unexpected state.

```
# In the worktree:
git merge main          # bring main into the worktree branch
# resolve any conflicts there
git checkout main       # in main workspace
git merge --ff-only texra/chat-a1b2  # guaranteed fast-forward
```

This is the standard pattern for branch-based development. The proposal acts like merge conflicts are an edge case to be handled in the UI. They're not — they're the *normal* case when multiple agents edit the same files, which is the *entire point* of this feature.

### On the storage analysis

The storage audit is solid. I'll give credit where it's due — walking through every storage layer and checking for path assumptions is the right engineering discipline. The `TaskRunFileService` issue with `WorkspaceFS.getPath()` is real, and the fix (override via constructor) is the right approach.

But you missed something. `pathToLocation()` at line 580 is called from various places outside the tool-use flow. You say "in worktree contexts, always use `TaskRunFileService`" — but who enforces this? Nobody. Someone will call `pathToLocation()` from a worktree context six months from now and it'll silently resolve against the wrong root. You need to either:

1. Make `pathToLocation()` context-aware (check the thread-local context), or
2. Deprecate it entirely in favor of the service method, or
3. At minimum, add a runtime assertion that detects when it's called from a worktree context and throws

Don't leave foot-guns lying around and hope people read the documentation.

### On the PR workflow

The `gh` CLI dependency is pragmatic. But the proposal treats it like it's always available. What happens when it's not installed? The current code says "fall back to push-only" — fine, but you should detect this *once* at extension activation, not on every PR creation attempt. Cache the availability.

The PR description auto-generation from agent logs is genuinely good. That's a feature that would make this worth using even outside the parallel execution context. Consider shipping it independently.

The polling approach for PR status is acceptable for v1 but is the wrong long-term answer. VS Code has a proper GitHub authentication provider — the same one you're already using for Supabase auth. Use the GitHub API directly via `@octokit/rest` instead of shelling out to `gh`. It's faster, doesn't require CLI installation, and you can use webhooks via the GitHub VS Code extension's event system.

### On the fan-out comparison view

The comparison view with three columns showing parallel results is the sexiest feature in this proposal and also the one most likely to be useless in practice. Here's why: LaTeX documents are typically 10-50 pages. Showing three versions of the first paragraph tells you nothing about whether the methodology section was ruined.

What you actually need is `latexdiff` — which you *already have* in the codebase. Run `latexdiff` between main and each worktree result, compile the diff PDFs, and show *those* side by side. An academic reviewer doesn't want to read three raw `.tex` snippets; they want to see three marked-up PDFs showing what changed.

Wire the comparison view into your existing `DiffCommandExecutor`. That's where the real value is.

### On the implementation phases

Five phases is too many. You're going to lose momentum after phase 2 and the rest will never ship. Here's what I'd do:

**Phase 1**: Worktree creation + tool path override + basic merge. This is the minimum viable feature. Ship it, get feedback.

**Phase 2**: PR workflow + latexdiff comparison. This is the differentiated value.

That's it. Two phases. The settings panel, the fan-out dialog, the conflict resolution UI with AI-assisted merge — those are premature. Build them when users ask for them, not before.

### On things the proposal doesn't address

**Submodules.** The proposal has one line in the edge cases table: "may need `--recurse-submodules`." If any user has submodules (and in academic repos with shared LaTeX packages, they do), worktree creation will silently produce a broken checkout. Test this properly or document that submodules aren't supported.

**Shallow clones.** If the user cloned from Overleaf with `--depth 1` (common for large repos with many revisions), worktree creation works but merging can fail because the merge base isn't available locally. You need to detect shallow repos and either deepen them or warn the user.

**Disk cleanup on crash.** The proposal says "worktrees persist on disk; `git worktree list` can rediscover." Sure, but who runs the cleanup? If the extension crashes five times in a day, you've got five orphaned worktrees eating disk space. Add a cleanup sweep on extension activation: `git worktree list` → check for worktrees with no matching stream → `git worktree remove`.

**The biggest missing thing**: What happens to the agent's system prompt? The agent is told it's working in a LaTeX project. It has no idea it's in a worktree. If it runs `git status`, it sees a detached-looking branch. If it runs `git log`, it sees the same history as main. If it tries `git push`, it pushes to... where? The agent needs to be told: "You are working in an isolated worktree on branch `texra/chat-a1b2`. Do not attempt to switch branches or push. Your changes will be reviewed and merged by the user."

### Verdict

The core architecture is sound. The storage analysis is thorough. The UI wireframes show genuine thought about the user experience. But the implementation details around merge safety, staging discipline, and edge cases need work before this is ready to build.

Strip it down to two phases. Get the worktree isolation right. Wire it into `latexdiff`. Ship it.

The rest can wait.
