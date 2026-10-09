/** Run history derived from committed session events. */

import { Effect, Stream } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';

import { type AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  isAgentRunRecord,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import { withLogChannel } from '@logger/effectLog';
import {
  aggregateTarget,
  type SessionEvent,
  type RunId,
  type RunIdentity,
  RUN_SUBSTATE,
  type RunLifecycleStatus,
} from '@shared/schemas';
import { filterNotNull, toNewestFirstByTimestamp } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { deriveResumability } from './resumability';
const CHANNEL = 'RunListing';
const RUN_STORAGE_CONCURRENCY = 32;

// ============================================================================
// Public types
// ============================================================================

interface RunListingBase {
  id: RunId;
  timestamp: string;
  parentRunId?: RunId;
  /** The run's folded status; a terminal outcome phase is its durable
   *  outcome. */
  status: RunLifecycleStatus;
  /** A stop rested the run (the fold's paused substate), a status of its own. */
  paused?: true;
  /** AI-generated summary of what the session aimed to accomplish. */
  description?: string;
  /** The model the run is on, as the view folds it: its newest
   *  `run.config`'s. */
  model?: string;
  /** `deriveResumability` finds a point to continue from. Ownership and
   *  loadability are settled when the run is opened. */
  resumable: boolean;
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
      record: RunRecord;
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
 * background scripts — `identity.kind` decides) and runs an agent
 * spawned (delegated subagents, a script's children, team members),
 * which belong to their parent's transcript rather than to the history list.
 *
 * Every host's history listing must apply this filter. Lookups by explicit id
 * (`texra history show <id>`, export, resume) must not: naming a child run is
 * an explicit request to see it, and `listRuns()` itself therefore stays
 * unfiltered.
 */
export function isUserVisibleRun(
  entry: RunListingEntry,
): entry is AgentRunListingEntry {
  return isAgentRunEntry(entry) && entry.parentRunId === undefined;
}

/** The latest `run.config` row of each run in one committed listing. */
function recordRows(
  rows: readonly SessionEvent[],
): Map<RunId, Extract<SessionEvent, { type: 'run.config' }>> {
  const records = new Map<
    RunId,
    Extract<SessionEvent, { type: 'run.config' }>
  >();
  for (const row of rows) {
    if (row.type !== 'run.config') continue;
    const target = aggregateTarget(row.aggregateId);
    if (target.kind === 'run') records.set(target.id, row);
  }
  return records;
}

/**
 * Every run the session's fold lists, with its private record: the view
 * folded cold from the log (one run model, R1) beside the same listing's
 * `run.config` rows, already decoded by the database read.
 */
export const listRuns = Effect.fn('listRuns')(function* (
  session: SessionHandle,
): Effect.fn.Return<RunListingEntry[], Error> {
  const [view, listing] = yield* Effect.all([
    session.view.read([]),
    Stream.runCollect(session.log.listing()),
  ]);
  const records = recordRows(listing);
  const results = yield* Effect.forEach(
    view.runs.values(),
    (run) =>
      Effect.gen(function* (): Effect.fn.Return<RunListingEntry | null, Error> {
        const id = run.id;
        const record = records.get(id)?.config ?? null;
        const resumeFrom = yield* deriveResumability(id, session);

        const base: RunListingBase = {
          id,
          timestamp: new Date(run.launchedAt).toISOString(),
          ...(run.parentId === null ? {} : { parentRunId: run.parentId }),
          status: run.status,
          ...(run.substate === RUN_SUBSTATE.PAUSED && { paused: true }),
          ...(run.description === null ? {} : { description: run.description }),
          ...(run.model === null ? {} : { model: run.model }),
          resumable: resumeFrom.kind === 'checkpoint',
        };
        const identity = run.identity;
        // Registration commits `run.config` in the `run.start` batch, so a
        // readable run without one, or an agent run without an AgentConfig,
        // is corrupt: skipped loudly below.
        if (!record) return yield* Effect.fail(new Error('no run.config row'));
        if (identity.kind === 'agent') {
          if (!isAgentRunRecord(record))
            return yield* Effect.fail(
              new Error('agent run without an AgentConfig'),
            );
          return { ...base, kind: 'run', identity, record };
        }
        return { ...base, kind: 'run', identity, record };
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Skipping corrupt run ${run.id}: ${toErrorMessage(error)}`,
          ).pipe(withLogChannel(CHANNEL), Effect.as(null)),
        ),
      ),
    { concurrency: RUN_STORAGE_CONCURRENCY },
  );

  return toNewestFirstByTimestamp(
    results.filter(filterNotNull),
    (item) => item.timestamp,
  );
});
