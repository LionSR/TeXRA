/** Run history derived from committed session events. */

import { Effect, Stream, Predicate } from 'effect';

import { isAgentRunRecord } from '@agent/core/definition/RunRecord';
import { withLogChannel } from '@logger/effectLog';
import {
  qualifyAggregateId,
  type AgentRunListingEntry,
  RUN_SUBSTATE,
} from '@shared/schemas';
import { recordsOf } from '@shared/session/runFacts';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { deriveResumability } from './resumability';
const CHANNEL = 'RunListing';
const RUN_STORAGE_CONCURRENCY = 32;

/**
 * The runs a user started, newest first, each with its private record: the
 * view rebuilt cold from the log (the same `RunView` a live session holds)
 * beside the same listing's rows, already decoded by the database read and
 * folded per run (`recordsOf`) for its configuration.
 */
export const listRuns = Effect.fn('listRuns')(function* (): Effect.fn.Return<
  AgentRunListingEntry[],
  Error,
  SessionLog | SessionViewAccess
> {
  const log = yield* SessionLog;
  const [view, listing] = yield* Effect.all([
    (yield* SessionViewAccess).read([]),
    Stream.runCollect(log.listing()),
  ]);
  const rows = Map.groupBy(listing, (row) => row.aggregateId);
  const results = yield* Effect.forEach(
    [...view.runs.values()].filter(
      (run) => run.identity.kind === 'agent' && run.parentId === null,
    ),
    (run) =>
      Effect.gen(function* (): Effect.fn.Return<
        AgentRunListingEntry,
        Error,
        SessionLog
      > {
        const { id, identity } = run;
        const own = rows.get(qualifyAggregateId('run', id)) ?? [];
        const record = recordsOf(own, id).config;
        // Registration commits `run.config` in the `run.start` batch, so an
        // agent run without an AgentConfig is corrupt: skipped loudly below.
        if (identity.kind !== 'agent' || !record || !isAgentRunRecord(record))
          return yield* Effect.fail(
            new Error('agent run without an AgentConfig'),
          );
        const resumeFrom = yield* deriveResumability(id);
        return {
          id,
          timestamp: new Date(run.launchedAt).toISOString(),
          outcome: run.durableOutcome,
          ...(run.substate === RUN_SUBSTATE.PAUSED && { paused: true }),
          ...(run.description === null ? {} : { description: run.description }),
          ...(run.model === null ? {} : { model: run.model }),
          resumable: resumeFrom.kind === 'checkpoint',
          ...('cause' in resumeFrom && { resumeBlocked: resumeFrom.cause }),
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
