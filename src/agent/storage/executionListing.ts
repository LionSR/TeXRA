/**
 * Directory-scanning execution listing.
 *
 * Derives the list of executions by scanning the `executions/` directory
 * and reading per-execution KV data (meta.json, config.json). This replaces
 * the monolithic `index.json` maintained by AgentHistoryManager.
 *
 * On first access, migrates legacy data (index.json and workspace state)
 * into per-execution KV stores, then deletes the legacy sources.
 */

import * as vscode from 'vscode';

import { type AgentConfig, AgentConfigSchema } from '@agent/core/AgentConfig';
import { isFileNotFoundError } from '@common/errors';
import { isDirectory } from '@common/files/fsEntryType';
import { workspaceSM } from '@common/state/stateManager';
import * as logger from '@logger/logUtils';
import { StorageFS } from '@utils/files';

import {
  type ExecutionMeta,
  EXECUTIONS_DIR,
  getExecutionStore,
} from './ExecutionKVStore';
import type { ExecutionId } from '@shared/schemas';

const CHANNEL = 'ExecutionListing';
const INDEX_PATH = 'executions/index.json';
const LEGACY_HISTORY_KEY = 'texra.agentHistory';

// ============================================================================
// Public types
// ============================================================================

export interface ExecutionListingEntry {
  id: ExecutionId;
  timestamp: string;
  parentExecutionId?: ExecutionId;
  agent: string;
  model: string;
  agentConfig: unknown;
  category?: string;
  terminalStatus?: string;
}

// ============================================================================
// Cache
// ============================================================================

let cache: ExecutionListingEntry[] | null = null;
let migrated = false;

export function invalidateListingCache(): void {
  cache = null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * List all executions by scanning the executions/ directory.
 * Results are cached until invalidated.
 */
export async function listExecutions(): Promise<ExecutionListingEntry[]> {
  if (cache) return cache;

  if (!migrated) {
    await migrateIfNeeded();
    migrated = true;
  }

  let entries: [string, vscode.FileType][];
  try {
    entries = await StorageFS.readDir(EXECUTIONS_DIR);
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }

  // Filter for directories matching execution ID pattern (hex UUID-like)
  const executionDirs = entries
    .filter(
      ([name, type]) => isDirectory(type) && /^[0-9a-f][-0-9a-f]*$/i.test(name),
    )
    .map(([name]) => name as ExecutionId);

  // Read meta + config in parallel
  const results = await Promise.all(
    executionDirs.map(async (id): Promise<ExecutionListingEntry | null> => {
      try {
        const store = getExecutionStore(id);
        const [meta, config] = await Promise.all([
          store.read<ExecutionMeta>('meta'),
          store.read<unknown>('config'),
        ]);

        if (!meta?.timestamp) return null;

        const cfg = config as Record<string, unknown> | undefined;
        return {
          id,
          timestamp: meta.timestamp,
          parentExecutionId: meta.parentExecutionId,
          agent: (cfg?.agent as string) ?? 'unknown',
          model: (cfg?.model as string) ?? 'unknown',
          agentConfig: config ?? {},
          category: (cfg?.agentCategory as string) ?? undefined,
          terminalStatus: meta.terminalStatus,
        };
      } catch (error) {
        logger.warn(CHANNEL, `Skipping corrupt execution ${id}`, {
          data: error,
        });
        return null;
      }
    }),
  );

  const listing = results
    .filter((e): e is ExecutionListingEntry => e !== null)
    .sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

  cache = listing;
  return listing;
}

/**
 * Delete a single execution and its KV data.
 */
export async function deleteExecution(
  executionId: ExecutionId,
): Promise<boolean> {
  try {
    await getExecutionStore(executionId).clear();
    invalidateListingCache();
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}

/**
 * Delete all executions.
 */
export async function deleteAllExecutions(): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await StorageFS.readDir(EXECUTIONS_DIR);
  } catch (error) {
    if (isFileNotFoundError(error)) return;
    throw error;
  }

  const executionDirs = entries
    .filter(
      ([name, type]) => isDirectory(type) && /^[0-9a-f][-0-9a-f]*$/i.test(name),
    )
    .map(([name]) => name as ExecutionId);

  await Promise.all(executionDirs.map((id) => getExecutionStore(id).clear()));

  invalidateListingCache();
}

// ============================================================================
// Legacy migration (runs once on first listExecutions() call)
// ============================================================================

async function migrateIfNeeded(): Promise<void> {
  await migrateIndexJson();
  await migrateWorkspaceState();
}

/** Migrate entries from executions/index.json into per-execution KV. */
async function migrateIndexJson(): Promise<void> {
  let items: unknown[];
  try {
    const raw = await StorageFS.readJson<unknown[]>(INDEX_PATH);
    if (!Array.isArray(raw) || raw.length === 0) return;
    items = raw;
  } catch {
    return; // File doesn't exist
  }

  await backfillEntries(items);

  try {
    await StorageFS.delete(INDEX_PATH);
  } catch (error) {
    logger.warn(CHANNEL, `Failed to delete legacy ${INDEX_PATH}`, {
      data: error,
    });
  }
}

/** Migrate entries from workspace state into per-execution KV. */
async function migrateWorkspaceState(): Promise<void> {
  const storageKey = getWorkspaceStorageKey();
  const legacy = workspaceSM.get<unknown[]>(storageKey, []);
  if (!Array.isArray(legacy) || legacy.length === 0) return;

  await backfillEntries(legacy);

  try {
    await workspaceSM.update(storageKey, []);
  } catch (error) {
    logger.warn(CHANNEL, `Failed to clear workspace state key`, {
      data: error,
    });
  }
}

function getWorkspaceStorageKey(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return workspaceFolder
    ? `${LEGACY_HISTORY_KEY}.${workspaceFolder.uri.fsPath}`
    : LEGACY_HISTORY_KEY;
}

/**
 * Backfill per-execution KV from legacy history entries.
 * Only writes if meta.json doesn't already exist (no overwriting).
 */
async function backfillEntries(entries: unknown[]): Promise<void> {
  await Promise.all(
    entries.map(async (rawEntry) => {
      if (!rawEntry || typeof rawEntry !== 'object') return;

      const candidate = rawEntry as {
        id?: ExecutionId;
        timestamp?: string;
        agentConfig?: AgentConfig;
        config?: AgentConfig; // Legacy field name
        parentExecutionId?: ExecutionId;
      };

      const rawConfig = candidate.agentConfig ?? candidate.config;
      if (!candidate.id || !candidate.timestamp || !rawConfig) return;

      let normalizedConfig: AgentConfig;
      try {
        normalizedConfig = AgentConfigSchema.parse(rawConfig);
      } catch {
        logger.warn(CHANNEL, `Skipping malformed legacy entry ${candidate.id}`);
        return;
      }

      const store = getExecutionStore(candidate.id);

      // Don't overwrite existing KV data
      if (await store.exists('meta')) return;

      await Promise.all([
        store.write('meta', {
          timestamp: candidate.timestamp,
          parentExecutionId: candidate.parentExecutionId,
        } satisfies ExecutionMeta),
        store.write('config', normalizedConfig),
      ]);
    }),
  );
}
