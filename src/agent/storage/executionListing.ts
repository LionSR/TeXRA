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

import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import { platform } from '@platform/platform';
import {
  type AgentConfig,
  AgentConfigSchema,
} from '@agent/core/definition/AgentConfig';
import { isFileNotFoundError } from '@common/errors';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { StorageFS, WorkspaceFS } from '@utils/files';
import { filterNotNull, toNewestFirstByTimestamp } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isDirectory } from '@utils/files/fsEntryType';

import { getExecutionStore } from './ExecutionKVStore';

const CHANNEL = 'ExecutionListing';
const INDEX_PATH = `${RUNS_STORAGE_DIR}/index.json`;
const LEGACY_HISTORY_KEY = 'texra.agentHistory';
const EXECUTION_ID_PATTERN = /^[0-9a-f][-0-9a-f]*$/i;
const EXECUTION_STORAGE_CONCURRENCY = 32;

// ============================================================================
// Public types
// ============================================================================

interface ExecutionListingBase {
  id: ExecutionId;
  timestamp: string;
  parentExecutionId?: ExecutionId;
  terminalStatus?: string;
  /** AI-generated summary of what the session aimed to accomplish. */
  description?: string;
}

export type ExecutionListingEntry =
  | (ExecutionListingBase & {
      kind: 'agent';
      agentConfig: AgentConfig;
      /** Metadata override when it differs from `agentConfig.agentCategory`. */
      runtimeCategory?: string;
    })
  | (ExecutionListingBase & {
      kind: 'process';
      agentConfig: AgentConfig;
    })
  | (ExecutionListingBase & {
      kind: 'incomplete';
      /** Preserved metadata for legacy rows whose config is absent. */
      runtimeCategory?: string;
    });

/**
 * True for executions a user should see in a history list — excludes
 * internal bookkeeping entries: the `category: 'process'` rows
 * `registerExecution` writes for background bash/process invocations (see
 * `src/tools/bash.ts` — these do carry a synthetic `AgentConfig`, but don't
 * represent a user-visible run or conversation), and entries with no
 * `agentConfig` at all. Every host's history listing must apply this filter;
 * `listExecutions()` itself stays unfiltered because tool-facing callers
 * like `ExecutionsTool` need the raw listing to manage background processes.
 */
export function isUserVisibleExecution(
  entry: ExecutionListingEntry,
): entry is Extract<ExecutionListingEntry, { kind: 'agent' }> {
  return entry.kind === 'agent';
}

// ============================================================================
// Cache
// ============================================================================

let cache: ExecutionListingEntry[] | null = null;
let migrated = false;
let cachedWorkspacePath: string | undefined;

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

/**
 * Select execution-id directories (hex UUID-like) from a scanned listing,
 * optionally excluding ids (e.g. active runs). A missing exclude set keeps all.
 */
function listExecutionDirs(
  entries: [string, number][],
  exclude?: ReadonlySet<string>,
): ExecutionId[] {
  return entries
    .filter(
      ([name, type]) =>
        isDirectory(type) &&
        EXECUTION_ID_PATTERN.test(name) &&
        !exclude?.has(name),
    )
    .map(([name]) => name as ExecutionId);
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
  const currentPath = WorkspaceFS.getPath();
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

  const entries = await readDirOrEmpty(RUNS_STORAGE_DIR);
  const executionDirs = listExecutionDirs(entries);

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

        const base: ExecutionListingBase = {
          id,
          timestamp: meta.timestamp,
          parentExecutionId: meta.parentExecutionId,
          terminalStatus: meta.terminalStatus,
          description: meta.description,
        };
        if (!cfg) {
          return {
            ...base,
            kind: 'incomplete',
            runtimeCategory: meta.category,
          };
        }
        if (meta.category === 'process') {
          return { ...base, kind: 'process', agentConfig: cfg };
        }
        return {
          ...base,
          kind: 'agent',
          agentConfig: cfg,
          ...(meta.category && meta.category !== cfg.agentCategory
            ? { runtimeCategory: meta.category }
            : {}),
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

  const listing = toNewestFirstByTimestamp(
    results.filter(filterNotNull),
    (item) => item.timestamp,
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
  const existed = await StorageFS.exists(`${RUNS_STORAGE_DIR}/${executionId}`);
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
 * Returns the execution ids selected for deletion so callers can clean up
 * adjacent per-execution state without re-scanning storage.
 */
export async function deleteAllExecutions(
  exclude?: ReadonlySet<string>,
): Promise<ExecutionId[]> {
  const entries = await readDirOrEmpty(RUNS_STORAGE_DIR);
  const executionDirs = listExecutionDirs(entries, exclude);

  try {
    await pMap(executionDirs, (id) => getExecutionStore(id).clear(), {
      concurrency: EXECUTION_STORAGE_CONCURRENCY,
      stopOnError: false,
    });
  } finally {
    invalidateListingCache();
  }
  return executionDirs;
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
  const legacy = platform().workspaceState.get<unknown[]>(storageKey, []);
  if (!Array.isArray(legacy) || legacy.length === 0) return;

  await backfillEntries(legacy);

  try {
    await platform().workspaceState.update(storageKey, []);
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
