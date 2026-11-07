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
  referencedAggregates,
  replayInputs,
  isDisplaySessionEvent,
  type AggregateId,
  type DisplaySessionEvent,
  type ExistenceReconciliation,
  type SessionViewInput,
  type TextChunk,
  type UnreadableRun,
} from '@shared/schemas';
import {
  Database,
  type AggregateState,
  type DatabaseReadFailed,
} from '@shared/session/database';
import { SessionInputs } from '@shared/session/sessionInputs';
import { Settings } from '@shared/config/settings';
import {
  LocalRuntimeSource,
  TextChunkSource,
  textSince,
  type InflightText,
} from './sessionSources';
import { WorkspaceRoots } from './WorkspaceRoots';
import { DEBUG_MODE_SETTING } from '@shared/state/stateSettings';

/**
 * A read the view cannot continue without. A failure is logged and retried
 * with backoff, so a transient one (a busy database, an I/O hiccup) costs a
 * delay rather than the session's view; one that persists ends the view's
 * updates, which fails every reader of the view's changes at that boundary.
 */
const requiredRead = <A>(
  read: Effect.Effect<A, DatabaseReadFailed>,
): Effect.Effect<A> =>
  read.pipe(
    Effect.tapError((error) =>
      Effect.logWarning('Session view read failed; retrying').pipe(
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
              ? Settings.getConfig(roots.config, DEBUG_MODE_SETTING)
              : false;
            const reset = debug !== previousDebug;
            const effectiveAggregates = reset
              ? aggregates.map((entry) => ({ ...entry, fromSeq: 0 }))
              : aggregates;
            const effectiveCommit = reset ? 0 : fromCommit;
            const anchor =
              effectiveCommit === 0
                ? yield* requiredRead(log.currentCommit)
                : effectiveCommit;
            const listing = (yield* requiredRead(log.readListing())).filter(
              isDisplaySessionEvent,
            );
            const checked = new Set<AggregateId>(
              effectiveAggregates.map(({ id }) => id),
            );
            for (const event of listing)
              for (const id of referencedAggregates(event)) checked.add(id);
            const aggregateRows: DisplaySessionEvent[] = [];
            for (const aggregate of effectiveAggregates) {
              aggregateRows.push(
                ...(yield* requiredRead(
                  log.readDisplayAggregate(aggregate.id, aggregate.fromSeq),
                )),
              );
            }
            const replayState = yield* requiredRead(
              log.readInputBatch(
                effectiveAggregates.map(({ id }) => id),
                anchor,
                [...checked],
              ),
            );
            const initialLocal = yield* SubscriptionRef.get(local.ref);
            const replay = replayInputs({
              debug,
              local: initialLocal,
              listing,
              subscriptions: effectiveAggregates,
              aggregateRows,
              existence: reconcileExistence(replayState),
            });
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
             *  `from`, and the existence of the aggregates that changed
             *  after `change` (the replay read every other one). */
            const readDurable = (from: number, change: number) =>
              requiredRead(
                log.readInputBatch(
                  aggregates.map(({ id }) => id),
                  from,
                  [],
                  change,
                ),
              ).pipe(
                Effect.map((read) => ({
                  cursor: read.cursor,
                  change: read.change,
                  rows: read.events,
                  existence: reconcileExistence(read),
                })),
              );
            const tail = wakes.pipe(
              // Wakeups carry no data: the next read captures every source's
              // current level. Retain one pending read, not a backlog of reads
              // of the same state after a burst of text chunks.
              Stream.buffer({ capacity: 1, strategy: 'dropping' }),
              Stream.mapAccumEffect(
                () => {
                  const text: InflightText = new Map();
                  return {
                    cursor: anchor,
                    // The wake level the last durable read saw; none yet, so
                    // the first drain reads.
                    level: -1,
                    text,
                    local: initialLocal,
                    // Every change the record holds: an aggregate that started
                    // during the cold read is checked again once its rows are
                    // in the view, not only by the replay.
                    change: 0,
                  };
                },
                Effect.fnUntraced(function* (previous) {
                  // Text first, then the level: a row committed before a
                  // chunk moved the level this read sees.
                  const nextText = yield* SubscriptionRef.get(text.ref);
                  const snapshot = yield* SubscriptionRef.get(local.ref);
                  const level = yield* SubscriptionRef.get(log.level);
                  // A burst of text, or a local change, moved no durable
                  // state: only a new level is worth a database read.
                  const { cursor, change, rows, existence } =
                    level === previous.level
                      ? {
                          cursor: previous.cursor,
                          change: previous.change,
                          rows: [],
                          existence: {
                            checkedAggregateIds: [],
                            present: [],
                            unreadable: [],
                          },
                        }
                      : yield* readDurable(previous.cursor, previous.change);
                  // The snapshot was read before the rows: it goes before
                  // them, as in the replay.
                  const changed: SessionViewInput[] = isDeepStrictEqual(
                    previous.local,
                    snapshot,
                  )
                    ? []
                    : [{ _tag: 'local', local: snapshot }];
                  const inputs: SessionViewInput[] = textChunks(
                    previous.text,
                    nextText,
                  );
                  if (
                    changed.length > 0 ||
                    inputs.length > 0 ||
                    rows.length > 0 ||
                    cursor !== previous.cursor ||
                    existence.checkedAggregateIds.length > 0 ||
                    // The first drain must publish the anchor: replay.complete
                    // reconciles existence but does not advance the view cursor.
                    previous.level === -1
                  ) {
                    // Every nonempty batch needs its closing marker so the
                    // webview decoder can release it as one complete read.
                    inputs.push({ _tag: 'drained', cursor, existence });
                  }
                  const batch: SessionViewInput[] = [
                    ...changed,
                    ...rows
                      .filter(isDisplaySessionEvent)
                      .map((event): SessionViewInput => ({
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
                      change,
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

/** An aggregate a removal closed no longer exists, even while the
 *  `run.removed` row is still stored; the runs the read found this build
 *  cannot open (`damaged`) ride beside. */
function reconcileExistence(read: {
  readonly checkedAggregateIds: readonly AggregateId[];
  readonly state: readonly AggregateState[];
  readonly damaged: readonly UnreadableRun[];
}): ExistenceReconciliation {
  return {
    checkedAggregateIds: [...read.checkedAggregateIds],
    present: read.state
      .filter((state) => !state.closed)
      .map(({ aggregateId }) => aggregateId),
    unreadable: [...read.damaged],
  };
}

/** The text each row gained since `held`, this reader's captured tail:
 *  only the appends since it, or the whole row when a replacement row
 *  started a new chain. */
function textChunks(held: InflightText, next: InflightText): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const [runId, rows] of next) {
    const heldRows = held.get(runId);
    for (const [rowId, value] of rows) {
      const tail = heldRows?.get(rowId);
      if (value === tail) continue;
      const { from, text } = textSince(value, tail);
      if (value.length <= from) continue;
      chunks.push({
        _tag: 'chunk',
        runId,
        rowId,
        from,
        to: value.length,
        text,
      });
    }
  }
  return chunks;
}
