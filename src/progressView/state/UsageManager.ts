// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { WorkspaceStateKey, workspaceSM } from '@utils/stateManager';
import { AgentLogger } from '@logger/AgentLogger';

// Types
import type { TokenUsageStats } from '../../types/UsageTypes';

/**
 * Manages token usage statistics for streams.
 */
export class UsageManager {
  public readonly map: Map<string, TokenUsageStats> = new Map();
  private readonly logger = new AgentLogger('UsageManager');

  private _getWorkspaceKey(key: WorkspaceStateKey | string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? `${key}.${workspaceFolder.uri.fsPath}` : key;
  }

  async load(): Promise<void> {
    const savedUsage = workspaceSM.get<{
      [key: string]: {
        inputTokens: number;
        outputTokens: number;
        cost: number;
      };
    }>(WorkspaceStateKey.USAGE_STATS);

    if (savedUsage) {
      this.map.clear();
      for (const [stream, stats] of Object.entries(savedUsage)) {
        this.map.set(stream, stats);
      }
    } else {
      this.map.clear();
    }
  }

  save(): void {
    workspaceSM.update(
      WorkspaceStateKey.USAGE_STATS,
      Object.fromEntries(this.map.entries()),
    );
  }

  clear(stream: string): void {
    this.map.delete(stream);
  }

  clearAll(): void {
    this.map.clear();
  }
}
