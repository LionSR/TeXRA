/**
 * Directory-scanning execution listing.
 *
 * Derives the list of executions by scanning the `executions/` directory
 * and reading per-execution KV data (meta.json, config.json).
 */

import pMap from 'p-map';

import { type AgentConfig } from '@agent/core/definition/AgentConfig';
import { isFileNotFoundError } from '@common/errors';
import * as logger from '@logger/logUtils';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import {
  executionStatusToRunOutcome,
  RUN_OUTCOME,
  type ExecutionId,
  type ExecutionMeta,
  type RunIdentity,
  type RunOutcome,
} from '@shared/schemas';
import { StorageFS } from '@utils/files';
import { filterNotNull, toNewestFirstByTimestamp } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isDirectory } from '@utils/files/fsEntryType';

import { getExecutionStore } from './ExecutionKVStore';
import {
  EXECUTION_LEASE_STALE_MS,
  inspectExecutionLease,
  runWithInactiveExecutionLease,
} from './executionLease';

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
  /** Canonical terminal outcome; absent for a run still in flight. */
  outcome?: RunOutcome;
  /** AI-generated summary of what the session aimed to accomplish. */
  description?: string;
}

export type ExecutionListingEntry =
  | (ExecutionListingBase & {
      kind: 'run';
      /** What the run is — the durable authority, stamped at registration. */
      identity: RunIdentity;
      agentConfig: AgentConfig;
    })
  | (ExecutionListingBase & {
      /** Row without a readable identity or config — un-healed or corrupt. */
      kind: 'incomplete';
    });

/**
 * True for executions a user should see in a history list, meaning the runs a
 * user started themselves. Excludes non-agent runs (background processes,
 * workflow-script containers — `identity.kind` decides), incomplete rows,
 * and runs an agent spawned (delegated subagents, workflow-script children,
 * team members), which belong to their parent's transcript rather than to
 * the history list.
 *
 * Every host's history listing must apply this filter. Lookups by explicit id
 * (`texra history show <id>`, export, resume) must not: naming a child run is
 * an explicit request to see it. `listExecutions()` itself stays unfiltered
 * because tool-facing callers like `ExecutionsTool` need the raw listing to
 * manage background processes and child runs.
 */
export function isUserVisibleExecution(
  entry: ExecutionListingEntry,
): entry is Extract<ExecutionListingEntry, { kind: 'run' }> {
  return (
    entry.kind === 'run' &&
    entry.identity.kind === 'agent' &&
    entry.parentExecutionId === undefined
  );
}

// ============================================================================
// Idempotent entrance stamping — the only legacy-migration artifact.
//
// Pre-consolidation rows carry no `identity`. The listing is the store's read
// entrance that already visits every row, so an unstamped row is healed here:
// identity derived once from the legacy evidence (`meta.category` +
// config), the derived `outcome` persisted beside it, written back under an
// inactive execution lease. Runs every time with no generation marker —
// idempotent because stamped rows never reach it, and re-runnable because an
// old binary's read-modify-write stripping the field, a legacy-bucket merge
// injecting v1 rows, or a restored backup simply re-heals on the next pass.
// ============================================================================

/** Rows younger than the lease-stale horizon may be mid-registration by an
 *  old binary — a half-born row must not be classified. */
const STAMP_MIN_AGE_MS = EXECUTION_LEASE_STALE_MS;

/**
 * Legacy terminal residue → canonical outcome. An unmappable string maps to
 * `failed` — the same non-resumable treatment those rows already get.
 */
function deriveLegacyOutcome(meta: ExecutionMeta): RunOutcome | undefined {
  if (meta.outcome) return meta.outcome;
  if (meta.terminalStatus === undefined) return undefined;
  return executionStatusToRunOutcome(meta.terminalStatus) ?? RUN_OUTCOME.FAILED;
}

function deriveLegacyIdentity(
  meta: ExecutionMeta,
  cfg: AgentConfig | null,
): RunIdentity | undefined {
  if (meta.category === 'process') {
    return { kind: 'process', tool: cfg?.agent ?? 'bash' };
  }
  // Rows without a readable config are left unstamped: they keep parsing and
  // keep listing as `incomplete`. No sentinel names are fabricated.
  return cfg ? { kind: 'agent', agent: cfg.agent } : undefined;
}

/**
 * Durably stamp a derived identity onto an unstamped row. Best-effort: an
 * active lease or a write failure leaves the row to heal on the next pass,
 * and the caller still uses the derived value for this read.
 */
async function stampExecutionRow(id: ExecutionId, meta: ExecutionMeta): Promise<void> {
  if (Date.now() - Date.parse(meta.timestamp) < STAMP_MIN_AGE_MS) return;
  try {
    await runWithInactiveExecutionLease(id, async () => {
      const store = getExecutionStore(id);
      const [current, cfg] = await Promise.all([
        store.readMeta(),
        store.readConfig(),
      ]);
      if (!current) return;
      const identity = current.identity ?? deriveLegacyIdentity(current, cfg);
      const outcome = deriveLegacyOutcome(current);
      if (current.identity && current.outcome === outcome) return;
      await store.writeMeta({
        ...current,
        ...(identity && { identity }),
        ...(outcome && { outcome }),
      });
    });
  } catch (error) {
    logger.warn(
      CHANNEL,
      `Could not stamp identity onto execution ${id}: ${toErrorMessage(error)}`,
    );
  }
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

        const outcome = deriveLegacyOutcome(meta);
        const base: ExecutionListingBase = {
          id,
          timestamp: meta.timestamp,
          parentExecutionId: meta.parentExecutionId,
          outcome,
          description: meta.description,
        };
        const identity = meta.identity ?? deriveLegacyIdentity(meta, cfg);
        // Durable healing is async and best-effort; this read already has
        // the derived values either way.
        if (identity !== meta.identity || outcome !== meta.outcome) {
          void stampExecutionRow(id, meta);
        }
        if (!cfg || !identity) {
          return { ...base, kind: 'incomplete' };
        }
        return { ...base, kind: 'run', identity, agentConfig: cfg };
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
