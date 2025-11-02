// Standard library imports
import { randomUUID } from 'crypto';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent metadata
import { type AgentConfig, parseAgentConfig } from '@agent/core/AgentConfig';
import { type AgentSessionDescriptor } from '@agent/core/AgentDataclass';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - workspace state
import { workspaceSM } from '@common/state/stateManager';
// Local imports - logging
import * as logger from '@logger/logUtils';

const CHANNEL = 'AgentHistoryManager';

/**
 * Represents a historical agent execution
 */
export interface AgentHistoryItem {
  id: ExecutionId;
  timestamp: string;
  config: AgentConfig;
  session: AgentSessionDescriptor;
}

/**
 * Manages the storage and retrieval of agent execution history
 */
export class AgentHistoryManager {
  private static readonly HISTORY_STORAGE_KEY = 'texra.agentHistory';
  private static readonly MAX_HISTORY_ITEMS = 100;

  /**
   * Add a new agent execution to history
   */
  public static async addToHistory(config: AgentConfig): Promise<string> {
    const normalizedConfig = parseAgentConfig(config);
    const session = normalizedConfig.session;
    if (!session) {
      throw new Error(
        'Agent history cannot store configs without session metadata.',
      );
    }

    const historyItem: AgentHistoryItem = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      config: normalizedConfig,
      session,
    };

    // Get current workspace-specific history
    const history = await this.getHistory();

    // Add new item at beginning (most recent first)
    history.unshift(historyItem);

    // Limit history size
    if (history.length > this.MAX_HISTORY_ITEMS) {
      history.splice(this.MAX_HISTORY_ITEMS);
    }

    // Save updated history
    await this.saveHistory(history);

    return historyItem.id;
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

      const candidate = rawEntry as Partial<AgentHistoryItem> & {
        config?: AgentConfig;
      };

      if (!candidate.id || !candidate.timestamp || !candidate.config) {
        mutated = true;
        continue;
      }

      let normalizedConfig: AgentConfig;
      try {
        normalizedConfig = parseAgentConfig(candidate.config);
      } catch (error) {
        mutated = true;
        logger.warn(
          CHANNEL,
          'Discarding malformed agent history entry',
          undefined,
          undefined,
          false,
          error,
        );
        continue;
      }

      const session = normalizedConfig.session;
      if (!session) {
        mutated = true;
        continue;
      }

      normalized.push({
        id: candidate.id,
        timestamp: candidate.timestamp,
        config: normalizedConfig,
        session,
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
