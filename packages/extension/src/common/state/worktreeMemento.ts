// Third-party imports
import type * as vscode from 'vscode';

/**
 * A `vscode.Memento`-compatible wrapper that transparently shares selected
 * repository-level workspace keys across git worktrees.
 */
export class WorktreeMemento implements vscode.Memento {
  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly globalState: vscode.Memento,
    private readonly repoRoot: string,
    private readonly sharedKeys: ReadonlySet<string>,
  ) {}

  keys(): readonly string[] {
    const all = new Set(this.workspaceState.keys());
    for (const key of this.sharedKeys) {
      if (
        this.globalState.get(this.namespacedKey(key)) !== undefined ||
        this.workspaceState.get(key) !== undefined
      ) {
        all.add(key);
      }
    }
    return [...all];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (!this.sharedKeys.has(key)) {
      return defaultValue === undefined
        ? this.workspaceState.get<T>(key)
        : this.workspaceState.get<T>(key, defaultValue);
    }

    const namespacedKey = this.namespacedKey(key);
    const sharedValue = this.globalState.get<T>(namespacedKey);
    if (sharedValue !== undefined) {
      return sharedValue;
    }

    const legacyValue = this.workspaceState.get<T>(key);
    if (legacyValue !== undefined) {
      void this.update(key, legacyValue);
      return legacyValue;
    }

    return defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (!this.sharedKeys.has(key)) {
      return this.workspaceState.update(key, value);
    }

    return this.updateSharedKey(key, value);
  }

  private namespacedKey(key: string): string {
    return `worktree:${this.repoRoot}:${key}`;
  }

  private async updateSharedKey(key: string, value: unknown): Promise<void> {
    await this.globalState.update(this.namespacedKey(key), value);
    await this.workspaceState.update(key, undefined);
  }
}
