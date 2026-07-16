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
import {
  inspectExecutionLease,
  runWithInactiveExecutionLease,
} from './executionLease';

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
// Legacy migration state
// ============================================================================

let migrated = false;
let migratedWorkspacePath: string | undefined;

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
 * Select execution-id directories (hex UUID-like) from a scanned listing.
 */
function listExecutionDirs(entries: [string, number][]): ExecutionId[] {
  return entries
    .filter(
      ([name, type]) => isDirectory(type) && EXECUTION_ID_PATTERN.test(name),
    )
    .map(([name]) => name as ExecutionId);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * List all executions by scanning the executions/ directory.
 *
 * The storage root is shared by independent CLI, desktop, and extension
 * processes, so every call scans current disk state. A process-local cache
 * cannot observe another host's writes or metadata updates reliably.
 */
export async function listExecutions(): Promise<ExecutionListingEntry[]> {
  const currentPath = WorkspaceFS.getPath();
  if (currentPath !== migratedWorkspacePath) {
    migrated = false;
    migratedWorkspacePath = currentPath;
  }

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

  return listing;
}

/**
 * Delete a single execution and its KV data unless a fresh lease protects it.
 * The structured result distinguishes deletion, absence, and active ownership.
 */
export type DeleteExecutionResult =
  | {
      readonly status: 'deleted' | 'not-found';
      readonly executionId: ExecutionId;
      readonly adjacentCleanupFailure?: string;
    }
  | {
      readonly status: 'active';
      readonly executionId: ExecutionId;
      readonly heartbeatAt: number;
    };

export interface DeleteAllExecutionsResult {
  readonly deleted: ExecutionId[];
  readonly notFound: ExecutionId[];
  readonly active: ExecutionId[];
  readonly failed: readonly {
    readonly executionId: ExecutionId;
    readonly message: string;
  }[];
}

export interface DeleteExecutionOptions {
  /** Adjacent cleanup run under the lock only after execution storage is gone. */
  readonly afterDelete?: () => Promise<void>;
}

export async function deleteExecution(
  executionId: ExecutionId,
  options: DeleteExecutionOptions = {},
): Promise<DeleteExecutionResult> {
  const guarded = await runWithInactiveExecutionLease(
    executionId,
    async (): Promise<DeleteExecutionResult> => {
      const existed = await StorageFS.exists(
        `${RUNS_STORAGE_DIR}/${executionId}`,
      );
      let status: 'deleted' | 'not-found' = 'not-found';
      if (existed) {
        try {
          await getExecutionStore(executionId).clear();
          status = 'deleted';
        } catch (error) {
          if (!isFileNotFoundError(error)) throw error;
        }
      }
      try {
        await options.afterDelete?.();
        return { status, executionId };
      } catch (error) {
        return {
          status,
          executionId,
          adjacentCleanupFailure: toErrorMessage(error),
        };
      }
    },
  );
  if (guarded.status === 'active') {
    return { status: 'active', executionId, heartbeatAt: guarded.heartbeatAt };
  }
  return guarded.value;
}

/**
 * Delete every unleased execution and report deleted, raced-away, and active
 * execution IDs separately.
 */
export async function deleteAllExecutions(): Promise<DeleteAllExecutionsResult> {
  const entries = await readDirOrEmpty(RUNS_STORAGE_DIR);
  const executionDirs = listExecutionDirs(entries);
  // Validate every present lease before the first irreversible deletion. A
  // malformed record fails closed without leaving callers with partial work
  // hidden behind an AggregateError.
  await Promise.all(executionDirs.map(inspectExecutionLease));
  const results = await pMap(
    executionDirs,
    async (id) => {
      try {
        return await deleteExecution(id);
      } catch (error) {
        return {
          status: 'failed' as const,
          executionId: id,
          message: toErrorMessage(error),
        };
      }
    },
    { concurrency: EXECUTION_STORAGE_CONCURRENCY },
  );
  return {
    deleted: results.flatMap((result) =>
      result.status === 'deleted' ? [result.executionId] : [],
    ),
    notFound: results.flatMap((result) =>
      result.status === 'not-found' ? [result.executionId] : [],
    ),
    active: results.flatMap((result) =>
      result.status === 'active' ? [result.executionId] : [],
    ),
    failed: results.flatMap((result) =>
      result.status === 'failed'
        ? [{ executionId: result.executionId, message: result.message }]
        : [],
    ),
  };
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
  const workspace = platform().workspace;
  const paths = [
    workspace.getWorkspacePath(),
    ...(workspace.getLegacyWorkspacePaths?.() ?? []),
  ];
  const storageKeys = [
    ...new Set(paths.map((path) => getWorkspaceStorageKey(path))),
  ];

  for (const storageKey of storageKeys) {
    const legacy = platform().workspaceState.get<unknown[]>(storageKey, []);
    if (!Array.isArray(legacy) || legacy.length === 0) continue;

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
}

function getWorkspaceStorageKey(workspacePath: string | undefined): string {
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
