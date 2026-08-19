// Local imports - shared
import { WorkspaceStateKey } from '@shared/state/stateKeys';

// Local imports - platform
import type { StateStore } from '../interfaces';

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
export class WorktreeStateStore implements StateStore {
  constructor(
    private readonly workspaceState: StateStore,
    private readonly globalState: StateStore,
    private readonly repoRoot: string,
    private readonly sharedKeys: ReadonlySet<string> = WORKTREE_SHARED_KEYS,
  ) {}

  get<T>(key: string, defaultValue?: T): T {
    const shared = this.sharedKeys.has(key);
    const store = shared ? this.globalState : this.workspaceState;
    return store.get<T>(
      shared ? this.namespacedKey(key) : key,
      defaultValue as T,
    );
  }

  async update(key: string, value: unknown): Promise<void> {
    if (!this.sharedKeys.has(key)) {
      await this.workspaceState.update(key, value);
      return;
    }

    await this.globalState.update(this.namespacedKey(key), value);
  }

  private namespacedKey(key: string): string {
    return `worktree:${this.repoRoot}:${key}`;
  }
}
