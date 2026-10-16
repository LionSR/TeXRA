/** Run history derived from committed session events. */

import { Effect, Stream, Predicate } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';

import { type AgentConfig } from '@agent/core/definition/AgentConfig';
import { isAgentRunRecord } from '@agent/core/definition/RunRecord';
import { withLogChannel } from '@logger/effectLog';
import {
  aggregateTarget,
  type SessionEvent,
  type RunId,
  type RunIdentity,
  RUN_SUBSTATE,
  type RunLifecycleStatus,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { deriveResumability } from './resumability';
const CHANNEL = 'RunListing';
const RUN_STORAGE_CONCURRENCY = 32;

/**
 * A run a user started themselves, as a history list shows it: an agent run
 * with no parent. Background processes and scripts (`identity.kind`) and the
 * runs an agent spawned, which belong to their parent's transcript, are not
 * listed; a lookup by explicit id reads the run's records instead.
 */
export interface AgentRunListingEntry {
  id: RunId;
  timestamp: string;
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
  /** What the run is — the durable authority, stamped at registration. */
  identity: Extract<RunIdentity, { kind: 'agent' }>;
  record: AgentConfig;
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
 * The runs a user started, newest first, each with its private record: the
 * view folded cold from the log (one run model, R1) beside the same
 * listing's `run.config` rows, already decoded by the database read.
 */
export const listRuns = Effect.fn('listRuns')(function* (
  session: SessionHandle,
): Effect.fn.Return<AgentRunListingEntry[], Error> {
  const [view, listing] = yield* Effect.all([
    session.view.read([]),
    Stream.runCollect(session.log.listing()),
  ]);
  const records = recordRows(listing);
  const results = yield* Effect.forEach(
    [...view.runs.values()].filter(
      (run) => run.identity.kind === 'agent' && run.parentId === null,
    ),
    (run) =>
      Effect.gen(function* (): Effect.fn.Return<AgentRunListingEntry, Error> {
        const { id, identity } = run;
        const record = records.get(id)?.config;
        // Registration commits `run.config` in the `run.start` batch, so an
        // agent run without an AgentConfig is corrupt: skipped loudly below.
        if (identity.kind !== 'agent' || !record || !isAgentRunRecord(record))
          return yield* Effect.fail(
            new Error('agent run without an AgentConfig'),
          );
        const resumeFrom = yield* deriveResumability(id, session);
        return {
          id,
          timestamp: new Date(run.launchedAt).toISOString(),
          status: run.status,
          ...(run.substate === RUN_SUBSTATE.PAUSED && { paused: true }),
          ...(run.description === null ? {} : { description: run.description }),
          ...(run.model === null ? {} : { model: run.model }),
          resumable: resumeFrom.kind === 'checkpoint',
          identity,
          record,
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Skipping corrupt run ${run.id}: ${toErrorMessage(error)}`,
          ).pipe(withLogChannel(CHANNEL), Effect.as(null)),
        ),
      ),
    { concurrency: RUN_STORAGE_CONCURRENCY },
  );

  return results
    .filter(Predicate.isNotNull)
    .toSorted((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
});
