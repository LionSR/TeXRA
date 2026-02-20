# Design: Git Worktree Isolation for Agents

## Problem

Agents operate directly on the user's workspace. We want them to work in
dedicated git worktrees without affecting the user's working tree, enabling
parallel work on several directions of a project.

**Core challenge:** `WorkspaceFS` is a static class that resolves to
`vscode.workspace.workspaceFolders[0]`, used by ~38 files for all file I/O.

## Solution

One `AsyncLocalStorage<string>`, one activation pattern.

### 1. Workspace Root Override (`workspaceRootStorage`)

A single `AsyncLocalStorage<string>` in `@utils/files/workspaceRootContext.ts`.
`WorkspaceFS` checks `storage.getStore()` before falling back to VS Code.

- `getBasePath()`, `getPath()`, `relativePath()` are all context-aware
- **Zero changes** needed in individual tools or pipeline nodes
- Safe for concurrent agents (AsyncLocalStorage is per-async-context)
- `relativePath()` uses `path.relative()` when overridden, with a
  `path.isAbsolute()` guard for Windows cross-drive paths

### 2. Activation

`workspacePath?` on `BaseFlowContextInit` threads automatically to all services
via `extends`. Both flow types wrap `pf.run()` in `storage.run()`:

- **`runToolUseFlow.ts`** — tool-use agents (prompts, tools, subagents)
- **`runReflectionFlow.ts`** — workflow agents (file I/O, output generation)

Subagents (both tool-use and workflow) inherit the worktree via
`workspaceRootStorage.getStore()` in `WorkflowTool`, so an orchestrator
and all its children operate on the same worktree.

### 3. Worktree Lifecycle

`createWorktree()` / `removeWorktree()` in `src/agent/worktree/`.

- Stored under VS Code workspace storage (`StorageFS.getBasePath()/worktrees/`)
  — already per-workspace, cross-platform, cleaned up on uninstall
- Uses `vscode.workspace.workspaceFolders` directly (not `WorkspaceFS`) to
  always target the real repository root
- `removeWorktree()` evicts the gitignore cache entry for the removed root

### Concurrency

`AsyncLocalStorage` gives each async execution chain its own isolated store.
Concurrent agents in different worktrees see their own `workspacePath` with
no interference. Same primitive as the project's logging context.

### Gitignore Cache

The matcher cache is keyed by effective workspace root. Entries are evicted
on worktree removal via `clearGitignoreCache(root)`.

## Files Changed

| File                      | Change                                             |
| ------------------------- | -------------------------------------------------- |
| `workspaceRootContext.ts` | New: `AsyncLocalStorage<string>`                   |
| `workspaceFS.ts`          | Check `storage.getStore()` in 3 methods            |
| `BaseFlowServices.ts`     | Add `workspacePath?` (threads everywhere)          |
| `runToolUseFlow.ts`       | Wrap `pf.run()` in `storage.run()`                 |
| `runReflectionFlow.ts`    | Wrap `pf.run()` in `storage.run()`                 |
| `executeAgent.ts`         | Pass `workspacePath` to both flow types            |
| `WorkflowTool.ts`         | Read `storage.getStore()` for subagent inheritance |
| `gitignore.ts`            | Root-keyed cache with targeted eviction            |
| `worktreeManager.ts`      | New: create/remove worktrees                       |
