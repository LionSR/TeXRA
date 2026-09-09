/** Execution history derived from committed session events. */

import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';

import { type AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  isAgentRunRecord,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import type { LatexExecutionDiscoveryPort } from '@latex/latexdiff/executionDiscovery';
import { createLog } from '@logger/logUtils';
import {
  aggregateTarget,
  type AggregateId,
  type SessionEvent,
  type ExecutionId,
  type RunIdentity,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import { filterNotNull, toNewestFirstByTimestamp } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import {
  getExecutionRecords,
  executionMetaFromEvents,
  executionRunRecordFromEvents,
} from './ExecutionKVStore';
import { checkpointExists } from './resumability';
const log = createLog('ExecutionListing');
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
  /**
   * Whether a checkpoint (persisted flow record) exists on disk — one `stat`
   * per row, never a parse. This is what a listing needs to advertise "this
   * run can be continued"; deciding whether the record is actually loadable
   * belongs to the resume path, which parses it once for the one run asked
   * for and refuses loudly.
   */
  checkpointPresent: boolean;
  /**
   * The stream stamped on metadata at registration — the reproduction
   * contract. Absent on rows written before stamping, which have no
   * persisted stream to continue.
   */
  streamId?: StreamTabId;
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

/** Group one committed listing prefix without scanning other runs during each fold. */
function groupExecutionRows(
  rows: readonly SessionEvent[],
): Map<ExecutionId, SessionEvent[]> {
  const executions = new Map<ExecutionId, SessionEvent[]>();
  const streamExecutions = new Map<AggregateId, ExecutionId>();
  for (const row of rows) {
    // Creation precedes its stream and execution rows in the committed prefix.
    if (row.type === 'run.start') {
      streamExecutions.set(row.aggregateId, row.executionId);
      executions.set(row.executionId, []);
    }
    const target = aggregateTarget(row.aggregateId);
    const id =
      target.kind === 'execution'
        ? target.id
        : streamExecutions.get(row.aggregateId);
    if (id !== undefined) executions.get(id)?.push(row);
  }
  return executions;
}

/** Read current execution identities and metadata from one committed listing. */
export const listExecutions = Effect.fn('listExecutions')(function* (
  session: SessionHandle,
): Effect.fn.Return<ExecutionListingEntry[], Error> {
  const executions = groupExecutionRows(yield* session.readRecordListing());
  const results = yield* Effect.forEach(
    executions,
    ([id, rows]) =>
      Effect.gen(function* (): Effect.fn.Return<
        ExecutionListingEntry | null,
        Error
      > {
        const [meta, record] = yield* Effect.try({
          try: () =>
            [
              executionMetaFromEvents(rows, id),
              executionRunRecordFromEvents(rows, id),
            ] as const,
          catch: ensureError,
        });
        const checkpointPresent = yield* checkpointExists(id, session);
        if (!meta) return null;

        const base: ExecutionListingBase = {
          id,
          timestamp: meta.timestamp,
          parentExecutionId: meta.parentExecutionId,
          outcome: meta.outcome,
          description: meta.description,
          checkpointPresent,
          streamId: meta.streamId,
        };
        const agentRecord = record && isAgentRunRecord(record) ? record : null;
        const identity = meta.identity;
        if (!record) return { ...base, kind: 'incomplete' };
        if (identity.kind === 'agent') {
          // An agent row's record is always an AgentConfig; anything else is
          // corrupt and lists as incomplete rather than lying about shape.
          if (!agentRecord) return { ...base, kind: 'incomplete' };
          return { ...base, kind: 'run', identity, record: agentRecord };
        }
        return { ...base, kind: 'run', identity, record };
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            log.warn(
              `Skipping corrupt execution ${id}: ${toErrorMessage(error)}`,
            );
            return null;
          }),
        ),
      ),
    { concurrency: EXECUTION_STORAGE_CONCURRENCY },
  );

  return toNewestFirstByTimestamp(
    results.filter(filterNotNull),
    (item) => item.timestamp,
  );
});

/**
 * Adapter from the agent storage surface to the latex-owned execution
 * discovery port. Hosts inject this into latexdiff orchestration.
 */
export function createLatexExecutionDiscovery(
  session: SessionHandle,
): LatexExecutionDiscoveryPort {
  return {
    listAgentRuns: () =>
      listExecutions(session).pipe(
        Effect.map((executions) =>
          executions.filter(isAgentRunEntry).map((entry) => ({
            id: entry.id,
            timestamp: entry.timestamp,
            agent: entry.record.agent,
            model: entry.record.model,
            inputFiles: entry.record.inputFiles,
          })),
        ),
      ),
    readStreamId: (executionId) =>
      getExecutionRecords(session, executionId)
        .readMeta()
        .pipe(Effect.map((meta) => meta?.streamId)),
  };
}
