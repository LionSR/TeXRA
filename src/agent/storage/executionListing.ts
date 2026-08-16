/**
 * Directory-scanning execution listing.
 *
 * Derives the list of executions by scanning the `executions/` directory
 * and reading per-execution KV data (meta.json, config.json).
 */

import pMap from 'p-map';

import { type AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  isAgentRunRecord,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import { isFileNotFoundError } from '@common/errors';
import type {
  LatexAgentRunEntry,
  LatexExecutionDiscoveryPort,
} from '@latex/latexdiff/executionDiscovery';
import { createLog } from '@logger/logUtils';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import type {
  ExecutionId,
  ExecutionMeta,
  RunIdentity,
  RunOutcome,
  StreamTabId,
} from '@shared/schemas';
import { filterNotNull, toNewestFirstByTimestamp } from '@utils/core';
import { StorageFS } from '@utils/files/storageFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isDirectory } from '@utils/files/fsEntryType';

import { getExecutionStore } from './ExecutionKVStore';
import {
  inspectExecutionLease,
  runWithInactiveExecutionLease,
} from './executionLease';

const log = createLog('ExecutionListing');
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

/** A native or tool-backed agent run: its record is always an AgentConfig. */
export type AgentExecutionListingEntry = ExecutionListingBase & {
  kind: 'run';
  /** What the run is — the durable authority, stamped at registration. */
  identity: Extract<RunIdentity, { kind: 'agent' }>;
  record: AgentConfig;
};

export type ExecutionListingEntry =
  | AgentExecutionListingEntry
  | (ExecutionListingBase & {
      kind: 'run';
      identity: Exclude<RunIdentity, { kind: 'agent' }>;
      /** Honest non-agent record — or a pre-consolidation fabricated
       *  AgentConfig, whose extra fields stay identity-suppressed. */
      record: RunRecord;
    })
  | (ExecutionListingBase & {
      /** Row without a readable identity or record — un-healed or corrupt. */
      kind: 'incomplete';
    });

/** Narrow to the agent arm; nested `identity.kind` cannot discriminate the
 *  entry union for TypeScript, so this is the one spelled-out guard. */
function isAgentRunEntry(
  entry: ExecutionListingEntry,
): entry is AgentExecutionListingEntry {
  return entry.kind === 'run' && entry.identity.kind === 'agent';
}

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
): entry is AgentExecutionListingEntry {
  return isAgentRunEntry(entry) && entry.parentExecutionId === undefined;
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

export interface ExecutionStreamReference {
  readonly executionId: ExecutionId;
  readonly streamId: StreamTabId;
}

/**
 * List execution→stream references recorded in readable execution metadata.
 *
 * This deliberately does not infer ownership for metadata without `streamId`,
 * or for malformed metadata. Those rows are retained: the sweep's only safe
 * deletion authority is the registered execution→stream edge itself.
 */
export async function listExecutionStreamReferences(): Promise<
  ExecutionStreamReference[]
> {
  const entries = await readDirOrEmpty(RUNS_STORAGE_DIR);
  const executionDirs = listExecutionDirs(entries);
  const results = await pMap(
    executionDirs,
    async (executionId): Promise<ExecutionStreamReference | null> => {
      try {
        const meta = await getExecutionStore(executionId).readMetaStrict();
        if (!meta?.streamId) return null;
        return { executionId, streamId: meta.streamId };
      } catch (error) {
        log.warn(
          `Skipping execution ${executionId} with unreadable metadata during orphan cleanup: ${toErrorMessage(error)}`,
          { data: error },
        );
        return null;
      }
    },
    { concurrency: EXECUTION_STORAGE_CONCURRENCY },
  );
  return results.filter(filterNotNull);
}

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

  // Rows registered before `identity` stamping existed. Their reader (derive
  // + write-back healing) was retired per #9590 Stage 7; they now list as
  // `incomplete`, loudly, and are never reconstructed.
  const preIdentityIds: ExecutionId[] = [];

  // Read meta + config with bounded concurrency. Large histories should not
  // enqueue one storage read pair per execution all at once.
  const results = await pMap(
    executionDirs,
    async (id): Promise<ExecutionListingEntry | null> => {
      try {
        const store = getExecutionStore(id);
        const [meta, record] = await Promise.all([
          store.readMeta(),
          store.readRunRecord(),
        ]);

        if (!meta) return null;

        const base: ExecutionListingBase = {
          id,
          timestamp: meta.timestamp,
          parentExecutionId: meta.parentExecutionId,
          outcome: meta.outcome,
          description: meta.description,
        };
        const agentRecord = record && isAgentRunRecord(record) ? record : null;
        const identity = meta.identity;
        if (!identity) preIdentityIds.push(id);
        if (!record || !identity) {
          return { ...base, kind: 'incomplete' };
        }
        if (identity.kind === 'agent') {
          // An agent row's record is always an AgentConfig; anything else is
          // corrupt and lists as incomplete rather than lying about shape.
          if (!agentRecord) return { ...base, kind: 'incomplete' };
          return { ...base, kind: 'run', identity, record: agentRecord };
        }
        return { ...base, kind: 'run', identity, record };
      } catch (error) {
        log.warn(`Skipping corrupt execution ${id}: ${toErrorMessage(error)}`);
        return null;
      }
    },
    { concurrency: EXECUTION_STORAGE_CONCURRENCY },
  );

  // One warning per listing pass, not one per row — a directory full of old
  // rows must degrade loudly, not spam.
  if (preIdentityIds.length > 0) {
    log.warn(
      `${preIdentityIds.length} pre-identity execution row(s) listed as incomplete (e.g. ${preIdentityIds[0]}): reader retired per #9590 Stage 7`,
    );
  }

  return toNewestFirstByTimestamp(
    results.filter(filterNotNull),
    (item) => item.timestamp,
  );
}

interface LatexExecutionDiscoveryDependencies {
  readonly listExecutions: typeof listExecutions;
  readonly readStreamMeta: (
    executionId: ExecutionId,
  ) => Promise<ExecutionMeta | null>;
}

const DEFAULT_LATEX_EXECUTION_DISCOVERY_DEPENDENCIES = Object.freeze({
  listExecutions,
  readStreamMeta: (executionId: ExecutionId) =>
    getExecutionStore(executionId).readMeta(),
} as const satisfies LatexExecutionDiscoveryDependencies);

/**
 * Adapter from the agent storage surface to the latex-owned execution
 * discovery port. Hosts inject this into latexdiff orchestration.
 *
 * Dependencies are injectable so the projection/filter contract can be unit
 * tested without scanning real execution storage.
 */
export function createLatexExecutionDiscovery(
  dependencies: LatexExecutionDiscoveryDependencies = DEFAULT_LATEX_EXECUTION_DISCOVERY_DEPENDENCIES,
): LatexExecutionDiscoveryPort {
  return {
    async listAgentRuns(): Promise<readonly LatexAgentRunEntry[]> {
      const executions = await dependencies.listExecutions();
      return executions.filter(isAgentRunEntry).map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        agent: entry.record.agent,
        model: entry.record.model,
        inputFiles: entry.record.inputFiles,
      }));
    },
    async readStreamId(executionId) {
      return (await dependencies.readStreamMeta(executionId))?.streamId;
    },
  };
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
          if (!isFileNotFoundError(error)) {
            if (options.beforeDelete) {
              // `beforeDelete` already ran and did not throw, so any cleanup
              // it performed (irreversible once committed — see
              // `@transcript/adjacentStreamCleanup`) has already happened.
              // Preserve that fact in the propagated error so both single and
              // bulk callers can report the partial deletion accurately.
              throw new Error(
                `Execution ${executionId}'s pre-delete cleanup completed, but its storage directory could not be removed: ${toErrorMessage(error)}`,
                { cause: error },
              );
            }
            throw error;
          }
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
export interface DeleteAllExecutionsOptions {
  /** Per-execution cleanup that must succeed under its inactive lease before
   *  storage removal — see {@link DeleteExecutionOptions.beforeDelete}. */
  readonly beforeDelete?: (executionId: ExecutionId) => Promise<void>;
}

export async function deleteAllExecutions(
  options: DeleteAllExecutionsOptions = {},
): Promise<DeleteAllExecutionsResult> {
  const entries = await readDirOrEmpty(RUNS_STORAGE_DIR);
  const executionDirs = listExecutionDirs(entries);
  // Validate every present lease before the first irreversible deletion. A
  // malformed record fails closed without leaving callers with partial work
  // hidden behind an AggregateError.
  await Promise.all(executionDirs.map(inspectExecutionLease));
  const { beforeDelete } = options;
  const results = await pMap(
    executionDirs,
    async (id) => {
      try {
        return await deleteExecution(id, {
          beforeDelete: beforeDelete ? () => beforeDelete(id) : undefined,
        });
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
