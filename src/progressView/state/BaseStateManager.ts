// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { WorkspaceStateKey } from '@utils/stateManager';

/**
 * Base interface for progress view state managers.
 */
export abstract class BaseStateManager {
  protected _getWorkspaceKey(key: WorkspaceStateKey | string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? `${key}.${workspaceFolder.uri.fsPath}` : key;
  }

  abstract load(): Promise<void>;
  abstract save(): void;
  abstract clear(stream: string): void;
  abstract clearAll(): void;
}
