// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { WorkspaceStateKey, workspaceSM } from '@utils/stateManager';
import { AgentLogger } from '@logger/AgentLogger';

// Types
import { TokenUsageStats } from '../../types/UsageTypes';

/**
 * Manages token usage statistics per stream.
 */
export class UsageStats {
  private readonly logger = new AgentLogger('UsageStats');
  private _stats: Map<string, TokenUsageStats> = new Map();

  private _getWorkspaceKey(key: WorkspaceStateKey | string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? `${key}.${workspaceFolder.uri.fsPath}` : key;
  }

  async load(): Promise<void> {
    const saved = workspaceSM.get<{ [key: string]: TokenUsageStats }>(
      this._getWorkspaceKey(WorkspaceStateKey.USAGE_STATS),
    );
    if (saved) {
      this._stats = new Map(Object.entries(saved));
    } else {
      this._stats.clear();
    }
  }

  save(): void {
    const obj = Object.fromEntries(this._stats.entries());
    workspaceSM.update(
      this._getWorkspaceKey(WorkspaceStateKey.USAGE_STATS),
      obj,
    );
  }

  get(stream: string): TokenUsageStats | undefined {
    return this._stats.get(stream);
  }

  set(stream: string, stats: TokenUsageStats): void {
    this._stats.set(stream, stats);
  }

  delete(stream: string): void {
    this._stats.delete(stream);
  }

  clear(): void {
    this._stats.clear();
  }

  entries(): IterableIterator<[string, TokenUsageStats]> {
    return this._stats.entries();
  }

  keys(): IterableIterator<string> {
    return this._stats.keys();
  }

  has(stream: string): boolean {
    return this._stats.has(stream);
  }
}
