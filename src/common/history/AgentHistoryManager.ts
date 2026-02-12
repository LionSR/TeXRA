// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent metadata
import { type AgentConfig, AgentConfigSchema } from '@agent/core/AgentConfig';

// Local imports - workspace state
import { workspaceSM } from '@common/state/stateManager';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { StorageFS } from '@utils/files';

const CHANNEL = 'AgentHistoryManager';
const INDEX_PATH = 'executions/index.json';

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
  /** Execution ID of the parent that launched this execution (subagents and background processes). */
  parentExecutionId?: ExecutionId;
}

/**
 * Manages the storage and retrieval of agent execution history
 */
export class AgentHistoryManager {
  private static readonly HISTORY_STORAGE_KEY = 'texra.agentHistory';
  private static readonly MAX_HISTORY_ITEMS = 500;
  private static cache: AgentHistoryItem[] | null = null;
  private static dirEnsured = false;

  /**
   * Add an agent execution to history with the given ID.
   */
  public static async addToHistory(
    executionId: ExecutionId,
    config: AgentConfig,
    parentExecutionId?: ExecutionId,
  ): Promise<void> {
    const normalizedConfig = AgentConfigSchema.parse(config);

    const historyItem: AgentHistoryItem = {
      id: executionId,
      timestamp: new Date().toISOString(),
      agentConfig: normalizedConfig,
      parentExecutionId,
    };

    const history = await this.getHistory();
    history.unshift(historyItem);

    if (history.length > this.MAX_HISTORY_ITEMS) {
      history.splice(this.MAX_HISTORY_ITEMS);
    }

    await this.persistIndex(history);
  }

  /**
   * Get all history items for the current workspace.
   * On first access, tries filesystem, then migrates from workspace state.
   */
  public static async getHistory(): Promise<AgentHistoryItem[]> {
    if (this.cache) return this.cache;

    // Try filesystem first
    let items: unknown[] | null = null;
    try {
      items = await StorageFS.readJson<unknown[]>(INDEX_PATH);
    } catch {
      // File doesn't exist yet — try migration
    }

    if (Array.isArray(items)) {
      const { normalized, mutated } = this.sanitizeHistoryEntries(items);
      if (mutated) {
        await this.persistIndex(normalized);
      } else {
        this.cache = normalized;
      }
      return normalized;
    }

    // TODO: Remove legacy migration after all users have migrated (added 2026-02)
    const normalized = await this.migrateFromWorkspaceState();
    return normalized;
  }

  /**
   * One-time migration from workspace state to filesystem.
   * TODO: Remove after all users have migrated (added 2026-02)
   */
  private static async migrateFromWorkspaceState(): Promise<
    AgentHistoryItem[]
  > {
    const storageKey = this.getWorkspaceStorageKey();
    const legacy = workspaceSM.get<unknown[]>(storageKey, []);
    const { normalized } = this.sanitizeHistoryEntries(legacy);

    // Persist to filesystem so migration never re-runs.
    // On failure, cache in-memory so the current session still works.
    try {
      await this.persistIndex(normalized);
      if (normalized.length > 0) {
        await workspaceSM.update(storageKey, []);
      }
    } catch (err) {
      logger.error(CHANNEL, `Failed to persist history migration: ${err}`);
      this.cache = normalized;
    }

    return normalized;
  }

  /**
   * Persist the index to filesystem and update the in-memory cache.
   */
  private static async persistIndex(
    history: AgentHistoryItem[],
  ): Promise<void> {
    if (!this.dirEnsured) {
      await StorageFS.ensureDir('executions');
      this.dirEnsured = true;
    }
    await StorageFS.writeJson(INDEX_PATH, history);
    this.cache = history;
  }

  /**
   * Sanitize and migrate history entries to current format.
   * Handles legacy data with 'config' field and separate 'session' field.
   */
  private static sanitizeHistoryEntries(entries: unknown[]): {
    normalized: AgentHistoryItem[];
    mutated: boolean;
  } {
    let hasLegacyEntries = false;
    const normalized: AgentHistoryItem[] = [];

    for (const rawEntry of entries) {
      if (!rawEntry || typeof rawEntry !== 'object') {
        continue;
      }

      // Support both new 'agentConfig' and legacy 'config' field names
      const candidate = rawEntry as {
        id?: ExecutionId;
        timestamp?: string;
        agentConfig?: AgentConfig;
        config?: AgentConfig; // Legacy field name
        parentExecutionId?: ExecutionId;
      };

      const rawConfig = candidate.agentConfig || candidate.config;
      if (!candidate.id || !candidate.timestamp || !rawConfig) {
        continue;
      }

      // Track legacy entries that need migration
      if (candidate.config && !candidate.agentConfig) {
        hasLegacyEntries = true;
      }

      let normalizedConfig: AgentConfig;
      try {
        normalizedConfig = AgentConfigSchema.parse(rawConfig);
      } catch (error) {
        logger.warn(CHANNEL, 'Discarding malformed agent history entry', {
          data: error,
        });
        continue;
      }

      normalized.push({
        id: candidate.id,
        timestamp: candidate.timestamp,
        agentConfig: normalizedConfig,
        parentExecutionId: candidate.parentExecutionId,
      });
    }

    const mutated = hasLegacyEntries || normalized.length !== entries.length;
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
    await this.persistIndex([]);
  }

  /**
   * Get workspace-specific storage key (used only for legacy migration)
   */
  private static getWorkspaceStorageKey(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder
      ? `${this.HISTORY_STORAGE_KEY}.${workspaceFolder.uri.fsPath}`
      : this.HISTORY_STORAGE_KEY;
  }

  /**
   * Get all history items that are children of a given execution.
   */
  public static async getChildrenOf(
    parentExecutionId: ExecutionId,
  ): Promise<AgentHistoryItem[]> {
    const history = await this.getHistory();
    return history.filter(
      (item) => item.parentExecutionId === parentExecutionId,
    );
  }

  /**
   * Delete a history item by ID
   */
  public static async deleteHistoryItemById(id: string): Promise<boolean> {
    const history = await this.getHistory();
    const filteredHistory = history.filter((item) => item.id !== id);

    if (filteredHistory.length === history.length) {
      return false;
    }

    await this.persistIndex(filteredHistory);
    return true;
  }
}
