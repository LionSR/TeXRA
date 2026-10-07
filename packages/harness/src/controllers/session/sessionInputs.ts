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
  aggregateTarget,
  type AggregateId,
  type LocalRuntimeState,
  type ExistenceReconciliation,
  type FoldInput,
  type TextChunk,
} from '@shared/schemas';
import {
  Database,
  type AggregateState,
  type DatabaseReadFailed,
} from '@shared/session/database';
import { RUN_DAMAGED_MESSAGE } from '@shared/runs/runStatusDisplay';
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
            let checked = new Set<AggregateId>(
              effectiveAggregates.map(({ id }) => id),
            );
            for (const event of listing)
              for (const id of referencedAggregates(event)) checked.add(id);
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
            yield* markDamaged(local.ref, replayState.damaged);
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
            /** The durable half of a drain: the rows committed past
             *  `from`, and the existence of the aggregates still checked. */
            const readDurable = (from: number) =>
              foldRead(
                log.readInputBatch(
                  aggregates.map(({ id }) => id),
                  from,
                  // The read dedups the ids it checks.
                  [...checked, ...effectiveAggregates.map(({ id }) => id)],
                ),
              ).pipe(
                Effect.tap((read) => markDamaged(local.ref, read.damaged)),
                Effect.map((read) => {
                  const existence = reconcileExistence(read);
                  checked = new Set(
                    existence.claims.map(({ aggregateId }) => aggregateId),
                  );
                  return { cursor: read.cursor, rows: read.events, existence };
                }),
              );
            const tail = wakes.pipe(
              // Wakeups carry no data: the next read captures every source's
              // current level. Retain one pending read, not a backlog of reads
              // of the same state after a burst of text chunks.
              Stream.buffer({ capacity: 1, strategy: 'dropping' }),
              Stream.mapAccumEffect(
                () => ({
                  cursor: anchor,
                  // The wake level the last durable read saw; none yet, so
                  // the first drain reads.
                  level: -1,
                  text: new Map() as InflightText,
                  local: initialLocal,
                  // The first drain must publish the anchor: replay.complete
                  // reconciles existence but does not advance the view cursor.
                  existence: undefined as ExistenceReconciliation | undefined,
                }),
                (previous) =>
                  Effect.gen(function* () {
                    // Text first, then the level: a row committed before a
                    // chunk moved the level this read sees.
                    const nextText = yield* SubscriptionRef.get(text.ref);
                    const snapshot = yield* SubscriptionRef.get(local.ref);
                    const level = yield* SubscriptionRef.get(log.level);
                    // A burst of text, or a local change, moved no durable
                    // state: only a new level is worth a database read.
                    const {
                      cursor,
                      rows,
                      existence,
                    }: Omit<
                      Effect.Success<ReturnType<typeof readDurable>>,
                      'existence'
                    > & { existence?: ExistenceReconciliation } =
                      level === previous.level
                        ? {
                            cursor: previous.cursor,
                            rows: [],
                            existence: previous.existence,
                          }
                        : yield* readDurable(previous.cursor);
                    const inputs: FoldInput[] = textChunks(
                      previous.text,
                      nextText,
                    );
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
                      inputs.push({
                        _tag: 'drained',
                        cursor,
                        existence: existence ?? replayExistence,
                      });
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
                        level,
                        text: nextText,
                        local: snapshot,
                        existence,
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

/** Show each damaged run read-only with why (`unreadable`): one of its rows
 *  does not decode, so it never opens. */
const markDamaged = (
  ref: SubscriptionRef.SubscriptionRef<LocalRuntimeState>,
  damaged: readonly AggregateId[],
) =>
  Effect.gen(function* () {
    const local = yield* SubscriptionRef.get(ref);
    const known = new Set(local.unreadable.map(({ runId }) => runId));
    const fresh = damaged.flatMap((id) => {
      const target = aggregateTarget(id);
      return target.kind === 'run' && !known.has(target.id)
        ? [{ runId: RunIdSchema.parse(target.id), detail: RUN_DAMAGED_MESSAGE }]
        : [];
    });
    // Only a new damaged run moves the level: an unchanged one would wake
    // this reader again for nothing, forever.
    if (fresh.length > 0)
      yield* SubscriptionRef.set(ref, {
        ...local,
        unreadable: [...local.unreadable, ...fresh],
      });
  });

/** Closed sequence rows are no longer live, even while their tombstones remain stored. */
function reconcileExistence(read: {
  readonly checkedAggregateIds: readonly AggregateId[];
  readonly state: readonly AggregateState[];
}): ExistenceReconciliation {
  const surviving = read.state.filter((state) => !state.closed);
  return {
    checkedAggregateIds: [...read.checkedAggregateIds],
    claims: surviving.map(({ aggregateId, ownerId }) => ({
      aggregateId,
      ownerId,
    })),
  };
}

/** The text each row gained since `held`, this reader's captured tail:
 *  only the appends since it, or the whole row when a replacement row
 *  started a new chain. */
function textChunks(held: InflightText, next: InflightText): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const [key, value] of next) {
    const tail = held.get(key);
    if (value === tail) continue;
    const parts: string[] = [];
    let at: InflightTextChunk | undefined = value;
    while (at !== undefined && at !== tail) {
      parts.push(at.text);
      at = at.previous;
    }
    const from = at === tail ? (tail?.length ?? 0) : 0;
    if (value.length <= from) continue;
    const slash = key.indexOf('/');
    chunks.push({
      _tag: 'chunk',
      runId: RunIdSchema.parse(key.slice(0, slash)),
      rowId: key.slice(slash + 1),
      from,
      to: value.length,
      text: parts.toReversed().join(''),
    });
  }
  return chunks;
}
