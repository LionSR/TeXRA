// Standard library imports
import { randomUUID } from 'crypto';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent metadata
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentType,
  deriveAgentCategory,
  type AgentCategory,
} from '@agent/core/AgentDataclass';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - workspace state
import { workspaceSM } from '@common/state/stateManager';

/**
 * Represents a historical agent execution
 */
export interface AgentHistoryItem {
  id: ExecutionId;
  timestamp: string;
  config: AgentConfig;
  agentType?: AgentType;
  agentCategory?: AgentCategory;
}

function resolveCategory(
  candidate: unknown,
  agentType?: AgentType | null,
): AgentCategory {
  return candidate === 'toolUse' || candidate === 'workflow'
    ? candidate
    : deriveAgentCategory(agentType);
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
    const sessionKind = resolveCategory(
      config.agentCategory ??
        (config as { agentSessionKind?: AgentCategory }).agentSessionKind,
      config.agentType,
    );
    const agentType =
      config.agentType ??
      (sessionKind === 'toolUse' ? AgentType.ToolUse : undefined);
    const normalizedConfig: AgentConfig = {
      ...config,
      agentType,
      agentCategory: sessionKind,
    };

    const historyItem: AgentHistoryItem = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      config: normalizedConfig,
      agentType,
      agentCategory: sessionKind,
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
    const history = workspaceSM.get<AgentHistoryItem[]>(storageKey, []);
    return history.map((item) => this.normalizeHistoryItem(item));
  }

  /**
   * Save history items for the current workspace
   */
  private static async saveHistory(history: AgentHistoryItem[]): Promise<void> {
    const storageKey = this.getWorkspaceStorageKey();
    await workspaceSM.update(storageKey, history);
  }

  private static normalizeHistoryItem(
    item: AgentHistoryItem,
  ): AgentHistoryItem {
    const rawAgentType = item.agentType ?? item.config.agentType;
    const rawSessionKind =
      item.agentCategory ??
      (item as { agentSessionKind?: AgentCategory }).agentSessionKind ??
      item.config.agentCategory ??
      (item.config as { agentSessionKind?: AgentCategory }).agentSessionKind;
    const sessionKind = resolveCategory(rawSessionKind, rawAgentType);
    const agentType =
      rawAgentType ??
      (sessionKind === 'toolUse' ? AgentType.ToolUse : undefined);

    const normalizedConfig: AgentConfig = {
      ...item.config,
      agentType,
      agentCategory: sessionKind,
    };

    return {
      ...item,
      config: normalizedConfig,
      agentType,
      agentCategory: sessionKind,
    };
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
