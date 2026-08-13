// Third-party imports
import type * as vscode from 'vscode';

/**
 * A `vscode.Memento`-compatible wrapper that transparently shares selected
 * repository-level workspace keys across git worktrees.
 *
 * Shared values are durable repository settings, not a cache. Their global
 * namespaces intentionally survive workspace removal and extension sessions so
 * settings return when a repository is reopened, re-cloned at the same path,
 * or becomes available again after removable storage is reattached.
 */
export class WorktreeMemento implements vscode.Memento {
  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly globalState: vscode.Memento,
    private readonly repoRoot: string,
    private readonly sharedKeys: ReadonlySet<string>,
  ) {}

  keys(): readonly string[] {
    const all = new Set(
      this.workspaceState.keys().filter((key) => !this.sharedKeys.has(key)),
    );
    for (const key of this.sharedKeys) {
      if (this.globalState.get(this.namespacedKey(key)) !== undefined) {
        all.add(key);
      }
    }
    return [...all];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    const shared = this.sharedKeys.has(key);
    const memento = shared ? this.globalState : this.workspaceState;
    const storageKey = shared ? this.namespacedKey(key) : key;
    return defaultValue === undefined
      ? memento.get<T>(storageKey)
      : memento.get<T>(storageKey, defaultValue);
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
