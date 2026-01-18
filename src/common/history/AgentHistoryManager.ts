// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent metadata
import { type AgentConfig, AgentConfigSchema } from '@agent/core/AgentConfig';
// Type imports
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - workspace state
import { workspaceSM } from '@common/state/stateManager';
import * as logger from '@logger/logUtils';

const CHANNEL = 'AgentHistory';
const HISTORY_STORAGE_KEY = 'texra.agentHistory';
const MAX_HISTORY_ITEMS = 500;

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
 * Get workspace-specific storage key
 */
export function getWorkspaceStorageKey(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return workspaceFolder
    ? `${HISTORY_STORAGE_KEY}.${workspaceFolder.uri.fsPath}`
    : HISTORY_STORAGE_KEY;
}

/**
 * Sanitize and migrate history entries to current format.
 * Handles legacy data with 'config' field and separate 'session' field.
 */
function sanitizeHistoryEntries(entries: unknown[]): {
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

    if (!normalizedConfig.session) {
      continue;
    }

    normalized.push({
      id: candidate.id,
      timestamp: candidate.timestamp,
      agentConfig: normalizedConfig,
    });
  }

  const mutated = hasLegacyEntries || normalized.length !== entries.length;
  return { normalized, mutated };
}

/**
 * Save history items for the current workspace
 */
async function saveHistory(history: AgentHistoryItem[]): Promise<void> {
  const storageKey = getWorkspaceStorageKey();
  await workspaceSM.update(storageKey, history);
}

/**
 * Get all history items for the current workspace
 */
export async function getHistory(): Promise<AgentHistoryItem[]> {
  const storageKey = getWorkspaceStorageKey();
  const history = workspaceSM.get<unknown[]>(storageKey, []);
  const { normalized, mutated } = sanitizeHistoryEntries(history);

  if (mutated) {
    await saveHistory(normalized);
  }

  return normalized;
}

/**
 * Add an agent execution to history with the given ID.
 */
export async function addToHistory(
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

  const history = await getHistory();
  history.unshift(historyItem);

  if (history.length > MAX_HISTORY_ITEMS) {
    history.splice(MAX_HISTORY_ITEMS);
  }

  await saveHistory(history);
}

/**
 * Get history item by ID
 */
export async function getHistoryItemById(
  id: string,
): Promise<AgentHistoryItem | undefined> {
  const history = await getHistory();
  return history.find((item) => item.id === id);
}

/**
 * Clear all history for current workspace
 */
export async function clearHistory(): Promise<void> {
  const storageKey = getWorkspaceStorageKey();
  await workspaceSM.update(storageKey, []);
}

/**
 * Delete a history item by ID
 */
export async function deleteHistoryItemById(id: string): Promise<boolean> {
  const history = await getHistory();
  const filteredHistory = history.filter((item) => item.id !== id);

  if (filteredHistory.length === history.length) {
    return false;
  }

  await saveHistory(filteredHistory);
  return true;
}
