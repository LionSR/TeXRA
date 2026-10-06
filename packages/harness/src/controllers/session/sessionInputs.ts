/**
 * Read durable events before the live text that follows them. Changes in
 * the three source levels are only wakeups: each read captures text first,
 * then the log ordinal, and drains that finite prefix before yielding text.
 * Thus a committed run.start has reached this reader before its first chunk.
 */
// Node imports
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import { Effect, Layer, Schedule, Stream, SubscriptionRef } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  DEBUG_MODE_KEY,
  referencedAggregates,
  isDisplaySessionEvent,
  RunIdSchema,
  type AggregateId,
  type BlockedAggregate,
  type ExistenceReconciliation,
  type FoldInput,
  type TextChunk,
} from '@shared/schemas';
import {
  Database,
  type AggregateState,
  type DatabaseReadFailed,
} from '@shared/session/database';
import { SessionInputs } from '@shared/session/sessionInputs';
import { readConfigSettingFrom } from '@utils/config/platformSettings';
import {
  LocalRuntimeSource,
  TextChunkSource,
  type InflightText,
  type InflightTextChunk,
} from './sessionSources';
import { WorkspaceRoots } from './WorkspaceRoots';

/**
 * A read the fold cannot continue without. A failure is logged and retried
 * with backoff, so a transient one (a busy database, an I/O hiccup) costs a
 * delay rather than the session's view; one that persists ends the fold,
 * which fails every reader of the view's changes at that boundary.
 */
const foldRead = <A>(
  read: Effect.Effect<A, DatabaseReadFailed>,
): Effect.Effect<A> =>
  read.pipe(
    Effect.tapError((error) =>
      Effect.logWarning('Session fold read failed; retrying').pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel('sessionInputs'),
      ),
    ),
    Effect.retry({
      schedule: Schedule.exponential('50 millis'),
      times: 5,
    }),
    Effect.orDie,
  );

export const sessionInputsLayer = Layer.effect(
  SessionInputs,
  Effect.gen(function* () {
    const log = yield* Database;
    const local = yield* LocalRuntimeSource;
    const text = yield* TextChunkSource;
    const roots = yield* WorkspaceRoots;
    return {
      read: (aggregates, fromCommit, previousDebug) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const debug = roots.config
              ? readConfigSettingFrom<boolean>(roots.config, DEBUG_MODE_KEY)
              : false;
            const reset = debug !== previousDebug;
            const effectiveAggregates = reset
              ? aggregates.map((entry) => ({ ...entry, fromSeq: 0 }))
              : aggregates;
            const effectiveCommit = reset ? 0 : fromCommit;
            const anchor =
              effectiveCommit === 0
                ? yield* foldRead(log.currentCommit)
                : effectiveCommit;
            const listing = (yield* foldRead(log.readListing())).filter(
              isDisplaySessionEvent,
            );
            // After the listing: a row it found unreadable is among them.
            const blocked = yield* foldRead(log.readBlocked());
            let checked = new Set<AggregateId>(
              effectiveAggregates.map(({ id }) => id),
            );
            for (const event of listing)
              for (const id of referencedAggregates(event)) checked.add(id);
            for (const { aggregateId } of blocked) checked.add(aggregateId);
            const replay: FoldInput[] = [
              {
                _tag: 'debug',
                enabled: debug,
              },
              ...listing.map((event) => ({
                _tag: 'event' as const,
                read: 'listing' as const,
                event,
              })),
              ...blockedInputs(blocked),
            ];
            replay.push({
              _tag: 'subscriptions',
              set: [...effectiveAggregates],
            });
            for (const aggregate of effectiveAggregates) {
              const rows = yield* foldRead(
                log.readDisplayAggregate(aggregate.id, aggregate.fromSeq),
              );
              for (const event of rows) {
                replay.push({ _tag: 'event', read: 'aggregate', event });
              }
            }
            const replayState = yield* foldRead(
              log.readInputBatch(
                effectiveAggregates.map(({ id }) => id),
                anchor,
                [...checked],
              ),
            );
            const replayExistence = reconcileExistence(replayState);
            checked = new Set(
              replayExistence.claims.map(({ aggregateId }) => aggregateId),
            );
            const initialLocal = yield* SubscriptionRef.get(local.ref);
            replay.push(
              { _tag: 'local', local: initialLocal },
              { _tag: 'replay.complete', existence: replayExistence },
            );
            // Every level replays on subscribe; changes during the cold read
            // are therefore covered by the first finite tail read.
            const wakes = Stream.mergeAll<unknown, never, never>(
              [
                SubscriptionRef.changes(log.level),
                SubscriptionRef.changes(local.ref),
                SubscriptionRef.changes(text.ref),
              ],
              { concurrency: 3 },
            );
            const tail = wakes.pipe(
              // Wakeups carry no data: the next read captures every source's
              // current level. Retain one pending read, not a backlog of reads
              // of the same state after a burst of text chunks.
              Stream.buffer({ capacity: 1, strategy: 'dropping' }),
              Stream.mapAccumEffect(
                () => ({
                  cursor: anchor,
                  text: new Map() as InflightText,
                  local: initialLocal,
                  // The first drain must publish the anchor: replay.complete
                  // reconciles existence but does not advance the view cursor.
                  existence: undefined as ExistenceReconciliation | undefined,
                  blocked: new Set(
                    blocked.map(({ aggregateId }) => aggregateId),
                  ),
                }),
                (previous) =>
                  Effect.gen(function* () {
                    const nextText = yield* SubscriptionRef.get(text.ref);
                    const snapshot = yield* SubscriptionRef.get(local.ref);
                    const read = yield* foldRead(
                      log.readInputBatch(
                        aggregates.map(({ id }) => id),
                        previous.cursor,
                        // The read dedups the ids it checks.
                        [
                          ...checked,
                          ...effectiveAggregates.map(({ id }) => id),
                        ],
                      ),
                    );
                    const { cursor, events: rows } = read;
                    const existence = reconcileExistence(read);
                    checked = new Set(
                      existence.claims.map(({ aggregateId }) => aggregateId),
                    );
                    const inputs: FoldInput[] = blockedInputs(
                      read.blocked.filter(
                        ({ aggregateId }) => !previous.blocked.has(aggregateId),
                      ),
                    );
                    for (const [key, value] of nextText) {
                      const held = previous.text.get(key);
                      if (value === held) continue;
                      // Visit only appends since this reader's captured tail.
                      // A replacement row starts a new chain and reads from 0.
                      const parts: string[] = [];
                      let at: InflightTextChunk | undefined = value;
                      while (at !== undefined && at !== held) {
                        parts.push(at.text);
                        at = at.previous;
                      }
                      const from = at === held ? (held?.length ?? 0) : 0;
                      if (value.length <= from) continue;
                      const slash = key.indexOf('/');
                      const chunk: TextChunk = {
                        _tag: 'chunk',
                        runId: RunIdSchema.parse(key.slice(0, slash)),
                        rowId: key.slice(slash + 1),
                        from,
                        to: value.length,
                        text: parts.toReversed().join(''),
                      };
                      inputs.push(chunk);
                    }
                    if (!isDeepStrictEqual(previous.local, snapshot)) {
                      inputs.push({ _tag: 'local', local: snapshot });
                    }
                    if (
                      inputs.length > 0 ||
                      rows.length > 0 ||
                      cursor !== previous.cursor ||
                      !isDeepStrictEqual(previous.existence, existence)
                    ) {
                      // Every nonempty batch needs its closing marker so the
                      // webview decoder can release it as one complete read.
                      inputs.push({ _tag: 'drained', cursor, existence });
                    }
                    const batch: FoldInput[] = [
                      ...rows
                        .filter(isDisplaySessionEvent)
                        .map((event): FoldInput => ({
                          _tag: 'event',
                          read: 'all',
                          event,
                        })),
                      ...inputs,
                    ];
                    return [
                      {
                        cursor,
                        text: nextText,
                        local: snapshot,
                        existence,
                        blocked: new Set(
                          read.blocked.map(({ aggregateId }) => aggregateId),
                        ),
                      },
                      batch.length === 0 ? [] : [batch],
                    ] as const;
                  }),
              ),
            );
            return Stream.concat(Stream.make(replay), tail);
          }),
        ),
    };
  }),
);

/**
 * The fold inputs of blocked verdicts. A run whose own `run.start` is the
 * unreadable row has no row that creates it: it is listed from a
 * `run.start` on its verdict's envelope, with no identity but its id, so it
 * shows as blocked instead of vanishing.
 */
function blockedInputs(verdicts: readonly BlockedAggregate[]): FoldInput[] {
  return verdicts.flatMap((verdict): FoldInput[] =>
    verdict.type === 'run.start'
      ? [
          {
            _tag: 'event',
            read: 'listing',
            event: {
              type: 'run.start',
              aggregateId: verdict.aggregateId,
              seq: 1,
              commit: verdict.commit,
              origin: null,
              at: verdict.at,
              identity: { kind: 'agent', agent: 'unknown' },
              userFollowUpSupport: 'unsupported',
              parent: null,
              provenance: null,
            },
          },
          verdict,
        ]
      : [verdict],
  );
}

/** Closed sequence rows are no longer live, even while their tombstones remain stored. */
function reconcileExistence(read: {
  readonly checkedAggregateIds: readonly AggregateId[];
  readonly state: readonly AggregateState[];
}): ExistenceReconciliation {
  const surviving = read.state.filter((state) => !state.closed);
  const present = new Set(surviving.map(({ aggregateId }) => aggregateId));
  return {
    checkedAggregateIds: [...read.checkedAggregateIds],
    removedAggregateIds: read.checkedAggregateIds.filter(
      (id) => !present.has(id),
    ),
    claims: surviving.map(({ aggregateId, ownerId }) => ({
      aggregateId,
      ownerId,
    })),
  };
}
