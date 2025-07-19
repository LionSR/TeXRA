// Third-party imports
import * as vscode from 'vscode';

// Standard library imports
import { randomUUID } from 'crypto';

// Local imports
import type { AgentConfig } from '@agent/core/AgentConfig';
import { workspaceSM } from '@common/state/stateManager';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

/**
 * Represents a historical agent execution
 */
export interface AgentHistoryItem {
  id: ExecutionId;
  timestamp: string;
  config: AgentConfig;
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
    const historyItem: AgentHistoryItem = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      config,
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
    return workspaceSM.get<AgentHistoryItem[]>(storageKey, []);
  }

  /**
   * Save history items for the current workspace
   */
  private static async saveHistory(history: AgentHistoryItem[]): Promise<void> {
    const storageKey = this.getWorkspaceStorageKey();
    await workspaceSM.update(storageKey, history);
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
