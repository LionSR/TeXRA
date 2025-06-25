// Third-party imports

// Local imports
import { WorkspaceStateKey, workspaceSM } from '@utils/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import { BaseStateManager } from './BaseStateManager';

// Types
import type { TokenUsageStats } from '../../types/UsageTypes';

/**
 * Manages token usage statistics for streams.
 */
export class UsageManager extends BaseStateManager {
  public readonly map: Map<string, TokenUsageStats> = new Map();
  private readonly logger = new AgentLogger('UsageManager');

  async load(): Promise<void> {
    const savedUsage = workspaceSM.get<{
      [key: string]: {
        inputTokens: number;
        outputTokens: number;
        cost: number;
      };
    }>(this._getWorkspaceKey(WorkspaceStateKey.USAGE_STATS));

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
      this._getWorkspaceKey(WorkspaceStateKey.USAGE_STATS),
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
