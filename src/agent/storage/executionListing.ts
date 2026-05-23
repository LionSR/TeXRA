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

import pMap from 'p-map';

import { type AgentConfig, AgentConfigSchema } from '@agent/core/AgentConfig';
import * as logger from '@agent/core/logger';
import { getWorkspaceState } from '@agent/core/stateStore';
import { isFileNotFoundError } from '@common/errors';
import { toErrorMessage } from '@common/errors/errorMessage';
import { isDirectory } from '@common/files/fsEntryType';
import type { ExecutionId } from '@shared/schemas';
import { StorageFS, WorkspaceFS } from '@utils/files';

import {
  type ExecutionMeta,
  EXECUTIONS_DIR,
  getExecutionStore,
} from './ExecutionKVStore';

const CHANNEL = 'ExecutionListing';
const INDEX_PATH = 'executions/index.json';
const LEGACY_HISTORY_KEY = 'texra.agentHistory';
const EXECUTION_ID_PATTERN = /^[0-9a-f][-0-9a-f]*$/i;
const EXECUTION_STORAGE_CONCURRENCY = 32;

// ============================================================================
// Public types
// ============================================================================

export interface ExecutionListingEntry {
  id: ExecutionId;
  timestamp: string;
  parentExecutionId?: ExecutionId;
  agent: string;
  model: string;
  agentConfig: AgentConfig | null;
  category?: string;
  terminalStatus?: string;
  /** AI-generated summary of what the session aimed to accomplish. */
  description?: string;
}

// ============================================================================
// Cache
// ============================================================================

let cache: ExecutionListingEntry[] | null = null;
let migrated = false;
let cachedWorkspacePath: string | undefined;

/** Get the current workspace path for cache keying. */
function getWorkspacePath(): string | undefined {
  return WorkspaceFS.getPath();
}

export function invalidateListingCache(): void {
  cache = null;
}

/**
 * Read a storage directory, returning an empty array if it doesn't exist.
 * Other I/O errors propagate.
 */
async function readDirOrEmpty(path: string): Promise<[string, number][]> {
  try {
    return await StorageFS.readDir(path);
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * List all executions by scanning the executions/ directory.
 * Results are cached until invalidated.
 */
export async function listExecutions(): Promise<ExecutionListingEntry[]> {
  // Invalidate if workspace changed since last cache build
  const currentPath = getWorkspacePath();
  if (currentPath !== cachedWorkspacePath) {
    cache = null;
    migrated = false;
    cachedWorkspacePath = currentPath;
  }

  if (cache) return cache;

  if (!migrated) {
    await migrateIfNeeded();
    migrated = true;
  }

  const entries = await readDirOrEmpty(EXECUTIONS_DIR);

  // Filter for directories matching execution ID pattern (hex UUID-like)
  const executionDirs = entries
    .filter(
      ([name, type]) => isDirectory(type) && EXECUTION_ID_PATTERN.test(name),
    )
    .map(([name]) => name as ExecutionId);

  // Read meta + config with bounded concurrency. Large histories should not
  // enqueue one storage read pair per execution all at once.
  const results = await pMap(
    executionDirs,
    async (id): Promise<ExecutionListingEntry | null> => {
      try {
        const store = getExecutionStore(id);
        const [meta, cfg] = await Promise.all([
          store.readMeta(),
          store.readConfig(),
        ]);

        if (!meta) return null;

        return {
          id,
          timestamp: meta.timestamp,
          parentExecutionId: meta.parentExecutionId,
          agent: cfg?.agent ?? 'unknown',
          model: cfg?.model ?? 'unknown',
          agentConfig: cfg ?? null,
          category: meta.category ?? cfg?.agentCategory,
          terminalStatus: meta.terminalStatus,
          description: meta.description,
        };
      } catch (error) {
        logger.warn(
          CHANNEL,
          `Skipping corrupt execution ${id}: ${toErrorMessage(error)}`,
        );
        return null;
      }
    },
    { concurrency: EXECUTION_STORAGE_CONCURRENCY },
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
 * Delete a single execution and its KV data. Returns true if the execution
 * existed and was removed, false if no such execution was present. The
 * `clear()` call silently no-ops on a missing directory, so we have to probe
 * existence ourselves before calling it — otherwise callers can't tell a real
 * delete apart from a no-op on a typo'd id.
 */
export async function deleteExecution(
  executionId: ExecutionId,
): Promise<boolean> {
  const existed = await StorageFS.exists(`${EXECUTIONS_DIR}/${executionId}`);
  if (!existed) return false;
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
 * Delete all executions, optionally excluding a set of IDs (e.g. active runs).
 */
export async function deleteAllExecutions(
  exclude?: ReadonlySet<string>,
): Promise<void> {
  const entries = await readDirOrEmpty(EXECUTIONS_DIR);

  const executionDirs = entries
    .filter(
      ([name, type]) =>
        isDirectory(type) &&
        EXECUTION_ID_PATTERN.test(name) &&
        !exclude?.has(name),
    )
    .map(([name]) => name as ExecutionId);

  try {
    await pMap(executionDirs, (id) => getExecutionStore(id).clear(), {
      concurrency: EXECUTION_STORAGE_CONCURRENCY,
      stopOnError: false,
    });
  } finally {
    invalidateListingCache();
  }
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
    logger.warn(
      CHANNEL,
      `Failed to delete legacy ${INDEX_PATH}: ${toErrorMessage(error)}`,
    );
  }
}

/** Migrate entries from workspace state into per-execution KV. */
async function migrateWorkspaceState(): Promise<void> {
  const storageKey = getWorkspaceStorageKey();
  const legacy = getWorkspaceState().get<unknown[]>(storageKey, []);
  if (!Array.isArray(legacy) || legacy.length === 0) return;

  await backfillEntries(legacy);

  try {
    await getWorkspaceState().update(storageKey, []);
  } catch (error) {
    logger.warn(
      CHANNEL,
      `Failed to clear workspace state key: ${toErrorMessage(error)}`,
    );
  }
}

function getWorkspaceStorageKey(): string {
  const workspacePath = WorkspaceFS.getPath();
  return workspacePath
    ? `${LEGACY_HISTORY_KEY}.${workspacePath}`
    : LEGACY_HISTORY_KEY;
}

/**
 * Backfill per-execution KV from legacy history entries.
 * Only writes if meta.json doesn't already exist (no overwriting).
 */
async function backfillEntries(entries: unknown[]): Promise<void> {
  await pMap(
    entries,
    async (rawEntry) => {
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
        store.writeMeta({
          timestamp: candidate.timestamp,
          parentExecutionId: candidate.parentExecutionId,
        }),
        store.writeConfig(normalizedConfig),
      ]);
    },
    {
      concurrency: EXECUTION_STORAGE_CONCURRENCY,
      stopOnError: false,
    },
  );
}
