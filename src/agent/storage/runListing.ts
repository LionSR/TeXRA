/** Run history derived from committed session events. */

import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';

import { type AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  isAgentRunRecord,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import type { LatexRunDiscoveryPort } from '@latex/latexdiff/runDiscovery';
import { createLog } from '@logger/logUtils';
import {
  aggregateTarget,
  type SessionEvent,
  type RunId,
  type RunIdentity,
  type RunOutcome,
} from '@shared/schemas';
import { filterNotNull, toNewestFirstByTimestamp } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import {
  runMetaFromEvents,
  runRecordFromEvents,
} from './RunKVStore';
import { checkpointExists } from './resumability';
const log = createLog('RunListing');
const RUN_STORAGE_CONCURRENCY = 32;

// ============================================================================
// Public types
// ============================================================================

interface RunListingBase {
  id: RunId;
  timestamp: string;
  parentRunId?: RunId;
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
}

/** A native or tool-backed agent run: its record is always an AgentConfig. */
export type AgentRunListingEntry = RunListingBase & {
  kind: 'run';
  /** What the run is — the durable authority, stamped at registration. */
  identity: Extract<RunIdentity, { kind: 'agent' }>;
  record: AgentConfig;
};

export type RunListingEntry =
  | AgentRunListingEntry
  | (RunListingBase & {
      kind: 'run';
      identity: Exclude<RunIdentity, { kind: 'agent' }>;
      /** Honest non-agent record — or a pre-consolidation fabricated
       *  AgentConfig, whose extra fields stay identity-suppressed. */
      record: RunRecord;
    })
  | (RunListingBase & {
      /** Row without a readable identity or record — un-healed or corrupt. */
      kind: 'incomplete';
    });

/** Narrow to the agent arm; nested `identity.kind` cannot discriminate the
 *  entry union for TypeScript, so this is the one spelled-out guard. */
function isAgentRunEntry(
  entry: RunListingEntry,
): entry is AgentRunListingEntry {
  return entry.kind === 'run' && entry.identity.kind === 'agent';
}

/**
 * True for runs a user should see in a history list, meaning the runs a
 * user started themselves. Excludes non-agent runs (background processes,
 * workflow-script containers — `identity.kind` decides), incomplete rows,
 * and runs an agent spawned (delegated subagents, workflow-script children,
 * team members), which belong to their parent's transcript rather than to
 * the history list.
 *
 * Every host's history listing must apply this filter. Lookups by explicit id
 * (`texra history show <id>`, export, resume) must not: naming a child run is
 * an explicit request to see it. `listRuns()` itself stays unfiltered
 * because tool-facing callers like `ExecutionsTool` need the raw listing to
 * manage background processes and child runs.
 */
export function isUserVisibleRun(
  entry: RunListingEntry,
): entry is AgentRunListingEntry {
  return isAgentRunEntry(entry) && entry.parentRunId === undefined;
}

/** Group one committed listing prefix by run without scanning other runs during each fold. */
function groupRunRows(
  rows: readonly SessionEvent[],
): Map<RunId, SessionEvent[]> {
  const runs = new Map<RunId, SessionEvent[]>();
  for (const row of rows) {
    const target = aggregateTarget(row.aggregateId);
    if (target.kind !== 'run') continue;
    // Creation precedes every other row of its run in the committed prefix.
    if (row.type === 'run.start') runs.set(target.id, []);
    runs.get(target.id)?.push(row);
  }
  return runs;
}

/** Read current run identities and metadata from one committed listing. */
export const listRuns = Effect.fn('listRuns')(function* (
  session: SessionHandle,
): Effect.fn.Return<RunListingEntry[], Error> {
  const runs = groupRunRows(yield* session.readRecordListing());
  const results = yield* Effect.forEach(
    runs,
    ([id, rows]) =>
      Effect.gen(function* (): Effect.fn.Return<
        RunListingEntry | null,
        Error
      > {
        const [meta, record] = yield* Effect.try({
          try: () =>
            [
              runMetaFromEvents(rows, id),
              runRecordFromEvents(rows, id),
            ] as const,
          catch: ensureError,
        });
        const checkpointPresent = yield* checkpointExists(id, session);
        if (!meta) return null;

        const base: RunListingBase = {
          id,
          timestamp: meta.timestamp,
          parentRunId: meta.parentRunId,
          outcome: meta.outcome,
          description: meta.description,
          checkpointPresent,
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
              `Skipping corrupt run ${id}: ${toErrorMessage(error)}`,
            );
            return null;
          }),
        ),
      ),
    { concurrency: RUN_STORAGE_CONCURRENCY },
  );

  return toNewestFirstByTimestamp(
    results.filter(filterNotNull),
    (item) => item.timestamp,
  );
});

/**
 * Adapter from the agent storage surface to the latex-owned run
 * discovery port. Hosts inject this into latexdiff orchestration.
 */
export function createLatexRunDiscovery(
  session: SessionHandle,
): LatexRunDiscoveryPort {
  return {
    listAgentRuns: () =>
      listRuns(session).pipe(
        Effect.map((runs) =>
          runs.filter(isAgentRunEntry).map((entry) => ({
            id: entry.id,
            timestamp: entry.timestamp,
            agent: entry.record.agent,
            model: entry.record.model,
            inputFiles: entry.record.inputFiles,
          })),
        ),
      ),
  };
}
