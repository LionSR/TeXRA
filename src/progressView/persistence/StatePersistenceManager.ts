// Third-party imports
// Third-party imports
import * as vscode from 'vscode';

/**
 * Manages persistence operations for progress view state.
 * Provides a clean interface for workspace storage with automatic
 * workspace-specific key generation.
 */
export class StatePersistenceManager {
  constructor(private workspaceState: vscode.Memento) {}

  /**
   * Load a value from workspace storage
   */
  async load<T>(key: string, defaultValue: T): Promise<T> {
    const workspaceKey = this.getWorkspaceKey(key);
    const value = this.workspaceState.get<T>(workspaceKey);
    return value !== undefined ? value : defaultValue;
  }

  /**
   * Save a value to workspace storage
   */
  async save<T>(key: string, value: T): Promise<void> {
    const workspaceKey = this.getWorkspaceKey(key);
    await this.workspaceState.update(workspaceKey, value);
  }

  /**
   * Delete a value from workspace storage
   */
  async delete(key: string): Promise<void> {
    const workspaceKey = this.getWorkspaceKey(key);
    await this.workspaceState.update(workspaceKey, undefined);
  }

  /**
   * Get workspace-specific storage key
   */
  private getWorkspaceKey(key: string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? `${key}.${workspaceFolder.uri.fsPath}` : key;
  }

  /**
   * Load with legacy key fallback and migration
   */
  async loadWithMigration<T>(
    newKey: string,
    legacyKey: string,
    defaultValue: T,
  ): Promise<T> {
    // Try new key first
    let value = await this.load(newKey, undefined as any);

    if (value === undefined) {
      // Try legacy key
      value = await this.load(legacyKey, defaultValue);
      if (value !== defaultValue) {
        // Migrate to new key and clean up old key
        await this.save(newKey, value);
        await this.delete(legacyKey);
      }
    }

    return value !== undefined ? value : defaultValue;
  }
}
