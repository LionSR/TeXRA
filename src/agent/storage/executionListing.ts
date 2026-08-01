/**
 * Directory-scanning execution listing.
 *
 * Derives the list of executions by scanning the `executions/` directory
 * and reading per-execution KV data (meta.json, config.json). This replaces
 * the monolithic `index.json` maintained by AgentHistoryManager.
 *
 * A storage-boundary migration handles legacy history before the scan.
 */

import pMap from 'p-map';

import { type AgentConfig } from '@agent/core/definition/AgentConfig';
import { isFileNotFoundError } from '@common/errors';
import * as logger from '@logger/logUtils';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
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
import { migrateLegacyExecutionHistoryOnce } from './legacyExecutionHistoryMigration';

const CHANNEL = 'ExecutionListing';
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
 * True for executions a user should see in a history list, meaning the runs a
 * user started themselves. Excludes internal bookkeeping entries: the
 * `category: 'process'` rows `registerExecution` writes for background
 * bash/process invocations (see `src/tools/bash.ts` — these do carry a
 * synthetic `AgentConfig`, but don't represent a user-visible run or
 * conversation), entries with no `agentConfig` at all, and runs an agent
 * spawned (delegated subagents, workflow-script children, team members), which
 * belong to their parent's transcript rather than to the history list.
 *
 * Every host's history listing must apply this filter. Lookups by explicit id
 * (`texra history show <id>`, export, resume) must not: naming a child run is
 * an explicit request to see it. `listExecutions()` itself stays unfiltered
 * because tool-facing callers like `ExecutionsTool` need the raw listing to
 * manage background processes and child runs.
 */
export function isUserVisibleExecution(
  entry: ExecutionListingEntry,
): entry is Extract<ExecutionListingEntry, { kind: 'agent' }> {
  return entry.kind === 'agent' && entry.parentExecutionId === undefined;
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
  await migrateLegacyExecutionHistoryOnce(WorkspaceFS.getPath());

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

  return toNewestFirstByTimestamp(
    results.filter(filterNotNull),
    (item) => item.timestamp,
  );
}

/**
 * Delete a single execution and its KV data unless a fresh lease protects it.
 * The structured result distinguishes deletion, absence, and active ownership.
 */
export type DeleteExecutionResult =
  | {
      readonly status: 'deleted' | 'not-found';
      readonly executionId: ExecutionId;
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
  /** Cleanup that must succeed under the inactive lease before storage removal. */
  readonly beforeDelete?: () => Promise<void>;
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
      await options.beforeDelete?.();
      let status: 'deleted' | 'not-found' = 'not-found';
      if (existed) {
        try {
          await getExecutionStore(executionId).clear();
          status = 'deleted';
        } catch (error) {
          if (!isFileNotFoundError(error)) throw error;
        }
      }
      return { status, executionId };
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
