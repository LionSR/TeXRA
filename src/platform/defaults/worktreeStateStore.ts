// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { normalizeFilePath } from '@utils/core';
import { executeCommand } from '@utils/system/execUtils';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import type {
  StateReadFailed,
  StateStore,
  StateWriteFailed,
} from '../interfaces';

/**
 * WorkspaceStateKeys that represent repository-level configuration rather
 * than per-workspace run data. These are shared across git worktrees of the
 * same repository by routing them through the global store under a repo
 * namespace.
 */
const WORKTREE_SHARED_KEYS: ReadonlySet<string> = new Set<string>([
  WorkspaceStateKey.AGENT_ROSTER_SELECTION,
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

/**
 * A workspace {@link StateStore} that transparently shares selected
 * repository-level keys across git worktrees, by reading and writing them in
 * the global store under a `worktree:<repoRoot>:` namespace.
 *
 * Shared values are durable repository settings, not a cache. Their global
 * namespaces intentionally survive workspace removal and host sessions so
 * settings return when a repository is reopened, re-cloned at the same path,
 * or becomes available again after removable storage is reattached.
 */
class WorktreeStateStore implements StateStore {
  constructor(
    private readonly workspaceState: StateStore,
    private readonly globalState: StateStore,
    private readonly repoRoot: string,
    private readonly sharedKeys: ReadonlySet<string> = WORKTREE_SHARED_KEYS,
  ) {}

  get<T>(key: string, defaultValue?: T): Effect.Effect<T, StateReadFailed> {
    const shared = this.sharedKeys.has(key);
    const store = shared ? this.globalState : this.workspaceState;
    return store.get<T>(
      shared ? this.namespacedKey(key) : key,
      defaultValue as T,
    );
  }

  /** The target store's own write, so its failure is what the caller reads. */
  update(key: string, value: unknown): Effect.Effect<void, StateWriteFailed> {
    if (!this.sharedKeys.has(key)) {
      return this.workspaceState.update(key, value);
    }

    return this.globalState.update(this.namespacedKey(key), value);
  }

  private namespacedKey(key: string): string {
    return `worktree:${this.repoRoot}:${key}`;
  }
}

/**
 * The workspace state store a Node host (extension, desktop) serves for
 * `workspaceRoot`: `projectState` itself outside a git repository, and inside
 * one a {@link WorktreeStateStore} keyed by the repository every worktree of
 * it shares.
 *
 * The key is the checkout the main worktree of a plain repository lives in:
 * a linked worktree, whose git dir is `<repo>/.git/worktrees/<name>`, keys by
 * `<repo>`; every other checkout (a main worktree, a submodule under
 * `.git/modules/…`, a worktree of a bare repository or of a submodule) keys
 * by its own top level, so two submodules never share one namespace.
 * "Not a git repository" is the expected answer for a plain folder; any
 * other failure (git missing, a timeout) is logged at warn and the workspace
 * keeps its own state unshared, so host startup is never aborted by it.
 */
export const openWorktreeStateStore = Effect.fn('openWorktreeStateStore')(
  function* (
    projectState: StateStore,
    globalState: StateStore,
    workspaceRoot: string,
  ): Effect.fn.Return<StateStore, never, ChildProcessSpawner> {
    const result = yield* executeCommand(
      [
        'git',
        'rev-parse',
        '--path-format=absolute',
        '--git-dir',
        '--show-toplevel',
      ],
      { cwd: workspaceRoot, settings: undefined, timeout: 5_000, quiet: true },
    );
    if (!result.success) {
      if (!/not a git repository/i.test(result.stderr)) {
        yield* Effect.logWarning(
          `Cannot resolve the git repository of ${workspaceRoot}; worktree-shared settings stay per workspace. Cause: ${result.stderr}`,
        ).pipe(withLogChannel('platform'));
      }
      return projectState;
    }
    const [gitDirLine = '', topLevelLine = ''] = result.stdout
      .trim()
      .split(/\r?\n/);
    const worktreesDir = path.dirname(path.normalize(gitDirLine.trim()));
    const commonDir = path.dirname(worktreesDir);
    const repoRoot =
      path.basename(worktreesDir) === 'worktrees' &&
      path.basename(commonDir) === '.git'
        ? path.dirname(commonDir)
        : path.normalize(topLevelLine.trim());
    return new WorktreeStateStore(
      projectState,
      globalState,
      normalizeFilePath(repoRoot),
    );
  },
);
