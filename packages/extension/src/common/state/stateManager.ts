// Third-party imports
import * as vscode from 'vscode';

// Local imports - shared state
import { WorkspaceStateKey } from '@shared/state/stateKeys';

// Local imports - state
import { WorktreeMemento } from './worktreeMemento';

/**
 * WorkspaceStateKeys that represent repository-level configuration rather
 * than per-workspace run data. These are shared across git worktrees of the
 * same repository by routing them through globalState with a repo namespace.
 */
const WORKTREE_SHARED_KEYS: ReadonlySet<WorkspaceStateKey> =
  new Set<WorkspaceStateKey>([
    WorkspaceStateKey.AGENT_ROSTER_SELECTION,
    WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
    WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
    WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
    WorkspaceStateKey.CODEX_SANDBOX_MODE,
    WorkspaceStateKey.CODEX_REASONING_EFFORT,
    WorkspaceStateKey.CODEX_APPROVAL_POLICY,
    WorkspaceStateKey.CLAUDE_AGENT_MODEL,
    WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
    WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
    WorkspaceStateKey.GIT_MARK_COMMITS,
    WorkspaceStateKey.GIT_AUTHOR_NAME,
    WorkspaceStateKey.GIT_AUTHOR_EMAIL,
    WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
  ]);

/** Workspace state manager (initialized via initializeStateManagers) */
export let workspaceSM: vscode.Memento;

/** Global state manager (initialized via initializeStateManagers) */
export let globalSM: vscode.Memento;

/**
 * Initialize the state managers with the extension context.
 *
 * When `repoRoot` is available, selected repository-level workspace keys are
 * shared across all git worktrees for that repository. All run/session keys
 * remain in VS Code's normal workspaceState.
 */
export function initializeStateManagers(
  context: vscode.ExtensionContext,
  repoRoot?: string,
): void {
  globalSM = context.globalState;
  workspaceSM = repoRoot
    ? new WorktreeMemento(
        context.workspaceState,
        context.globalState,
        repoRoot,
        WORKTREE_SHARED_KEYS,
      )
    : context.workspaceState;
}
