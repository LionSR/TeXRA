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

## 5. Interaction Flows

### 5.1 Happy Path: Single Parallel Agent

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

### 5.2 Fan-Out with Comparison

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

## 6. Edge Cases & Mitigations

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

## 7. Implementation Phases

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

## 8. Risks & Open Questions

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

## 9. Alternatives Considered

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

## 10. Summary

Git worktree mode for parallel tool-use agents is **feasible and architecturally clean**. The key enabler is that TeXRA's tool system already has the right abstraction boundaries:

- Tools are stateless and resolve paths through a central utility
- The stream/tab system already supports parallel executions
- The execution context uses stack-based propagation that can carry workspace overrides
- Git worktrees provide battle-tested isolation with built-in merge semantics

The main implementation effort is in the **path resolution override** (touching ~10 tool files with small changes), the **WorktreeManager service** (new, ~300-400 lines), and the **merge UX** (new webview panels). The existing Progress Board, event bus, and stream infrastructure require minimal changes.

The result would give TeXRA a genuinely differentiated capability: AI agents that work in parallel on the same LaTeX project, each in their own isolated branch, with a clean merge-and-compare workflow for selecting the best results.
