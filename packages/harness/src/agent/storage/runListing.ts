/** Run history derived from committed session events. */

import { Effect, Predicate } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { type AgentRunListingEntry, isAgentRunRecord } from '@shared/schemas';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';

import { deriveContinuation } from './continuation';
const CHANNEL = 'RunListing';
const RUN_STORAGE_CONCURRENCY = 32;

/**
 * The runs a user started, newest first, each with its private record: the
 * view rebuilt cold from the log (the same `RunView` a live session holds)
 * beside the same listing's rows, already decoded by the database read: each
 * run's latest `run.config` is its configuration.
 */
export const listRuns = Effect.fn('listRuns')(function* (): Effect.fn.Return<
  AgentRunListingEntry[],
  Error,
  SessionLog | SessionViewAccess
> {
  const log = yield* SessionLog;
  const [view, listing] = yield* Effect.all([
    (yield* SessionViewAccess).read([]),
    log.listing(),
  ]);
  const rows = Map.groupBy(listing, (row) => row.aggregateId);
  const results = yield* Effect.forEach(
    [...view.runs.values()].filter(
      (run) => run.identity.kind === 'agent' && run.parentId === null,
    ),
    (run) =>
      Effect.gen(function* (): Effect.fn.Return<
        AgentRunListingEntry | null,
        never,
        SessionLog
      > {
        const { id, identity } = run;
        const own = rows.get(id) ?? [];
        const record = own.findLast((row) => row.type === 'run.config')?.config;
        // Registration commits `run.config` in the `run.start` batch, so an
        // agent run without an AgentConfig is corrupt: skipped loudly.
        if (identity.kind !== 'agent' || !record || !isAgentRunRecord(record)) {
          yield* Effect.logWarning(
            `Skipping corrupt run ${run.id}: agent run without an AgentConfig`,
          ).pipe(withLogChannel(CHANNEL));
          return null;
        }
        const continuation = yield* deriveContinuation(id);
        return {
          id,
          timestamp: new Date(run.launchedAt).toISOString(),
          outcome: run.outcome,
          ...(run.description === null ? {} : { description: run.description }),
          continuation:
            continuation.kind === 'checkpoint'
              ? { kind: 'continues' }
              : continuation.kind === 'finished'
                ? { kind: 'finished' }
                : { kind: 'blocked', cause: continuation.cause },
          identity,
          record,
        };
      }),
    { concurrency: RUN_STORAGE_CONCURRENCY },
  );

  return results
    .filter(Predicate.isNotNull)
    .toSorted((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
});
