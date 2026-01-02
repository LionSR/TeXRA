// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent metadata
import { type AgentConfig, AgentConfigSchema } from '@agent/core/AgentConfig';
// Type imports
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - workspace state
import { workspaceSM } from '@common/state/stateManager';
import * as logger from '@logger/logUtils';

const CHANNEL = 'AgentHistoryManager';

/**
 * Represents a historical agent execution.
 *
 * Uses `agentConfig` field name for consistency with TaskState interface.
 * Session metadata is accessed via `agentConfig.session` - single source of truth.
 */
export interface AgentHistoryItem {
  id: ExecutionId;
  timestamp: string;
  agentConfig: AgentConfig;
}

/**
 * Manages the storage and retrieval of agent execution history
 */
export class AgentHistoryManager {
  private static readonly HISTORY_STORAGE_KEY = 'texra.agentHistory';
  private static readonly MAX_HISTORY_ITEMS = 500;

  /**
   * Add an agent execution to history with the given ID.
   */
  public static async addToHistory(
    executionId: ExecutionId,
    config: AgentConfig,
  ): Promise<void> {
    const normalizedConfig = AgentConfigSchema.parse(config);
    if (!normalizedConfig.session) {
      throw new Error(
        'Agent history cannot store configs without session metadata.',
      );
    }

    const historyItem: AgentHistoryItem = {
      id: executionId,
      timestamp: new Date().toISOString(),
      agentConfig: normalizedConfig,
    };

    const history = await this.getHistory();
    history.unshift(historyItem);

    if (history.length > this.MAX_HISTORY_ITEMS) {
      history.splice(this.MAX_HISTORY_ITEMS);
    }

    await this.saveHistory(history);
  }

  /**
   * Get all history items for the current workspace
   */
  public static async getHistory(): Promise<AgentHistoryItem[]> {
    const storageKey = this.getWorkspaceStorageKey();
    const history = workspaceSM.get<unknown[]>(storageKey, []);
    const { normalized, mutated } = this.sanitizeHistoryEntries(history);

    if (mutated) {
      await this.saveHistory(normalized);
    }

    return normalized;
  }

  /**
   * Save history items for the current workspace
   */
  private static async saveHistory(history: AgentHistoryItem[]): Promise<void> {
    const storageKey = this.getWorkspaceStorageKey();
    await workspaceSM.update(storageKey, history);
  }

  /**
   * Sanitize and migrate history entries to current format.
   * Handles legacy data with 'config' field and separate 'session' field.
   */
  private static sanitizeHistoryEntries(entries: unknown[]): {
    normalized: AgentHistoryItem[];
    mutated: boolean;
  } {
    let mutated = false;
    const normalized: AgentHistoryItem[] = [];

    for (const rawEntry of entries) {
      if (!rawEntry || typeof rawEntry !== 'object') {
        mutated = true;
        continue;
      }

      // Support both new 'agentConfig' and legacy 'config' field names
      const candidate = rawEntry as {
        id?: ExecutionId;
        timestamp?: string;
        agentConfig?: AgentConfig;
        config?: AgentConfig; // Legacy field name
      };

      const rawConfig = candidate.agentConfig || candidate.config;
      if (!candidate.id || !candidate.timestamp || !rawConfig) {
        mutated = true;
        continue;
      }

      // Legacy entries use 'config' field; mark for persistence with new 'agentConfig' field
      if (candidate.config && !candidate.agentConfig) {
        mutated = true;
      }

      let normalizedConfig: AgentConfig;
      try {
        normalizedConfig = AgentConfigSchema.parse(rawConfig);
      } catch (error) {
        mutated = true;
        logger.warn(CHANNEL, 'Discarding malformed agent history entry', {
          data: error,
        });
        continue;
      }

      if (!normalizedConfig.session) {
        mutated = true;
        continue;
      }

      normalized.push({
        id: candidate.id,
        timestamp: candidate.timestamp,
        agentConfig: normalizedConfig,
      });
    }

    if (normalized.length !== entries.length) {
      mutated = true;
    }

    return { normalized, mutated };
  }

  /**
   * Get history item by ID
   */
  public static async getHistoryItemById(
    id: string,
  ): Promise<AgentHistoryItem | undefined> {
    const history = await this.getHistory();
    return history.find((item) => item.id === id);
  }

  /**
   * Clear all history for current workspace
   */
  public static async clearHistory(): Promise<void> {
    const storageKey = this.getWorkspaceStorageKey();
    await workspaceSM.update(storageKey, []);
  }

  /**
   * Get workspace-specific storage key
   */
  public static getWorkspaceStorageKey(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder
      ? `${this.HISTORY_STORAGE_KEY}.${workspaceFolder.uri.fsPath}`
      : this.HISTORY_STORAGE_KEY;
  }

  /**
   * Delete a history item by ID
   */
  public static async deleteHistoryItemById(id: string): Promise<boolean> {
    const history = await this.getHistory();
    const initialLength = history.length;

    // Filter out the item to delete
    const filteredHistory = history.filter((item) => item.id !== id);

    if (filteredHistory.length !== initialLength) {
      // Item was found and removed
      await this.saveHistory(filteredHistory);
      return true;
    }

    // Item was not found
    return false;
  }
}
