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

}
