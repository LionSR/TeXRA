/**
 * Read durable events before the live text that follows them. The replay
 * reads the store; after it the rows come from the publisher's batches as
 * each job commits. Each step captures the text first, then the batches
 * published by then, so a row committed before a chunk (the publisher
 * applies chunks in its order) reaches this reader first.
 */
// Node imports
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import {
  type Context,
  Effect,
  Exit,
  Layer,
  PubSub,
  Schedule,
  Stream,
  SubscriptionRef,
} from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  qualifyAggregateId,
  referencedAggregates,
  replayInputs,
  isDisplayRow,
  type AggregateId,
  type DisplayRow,
  type ExistenceReconciliation,
  type LocalRuntimeState,
  type SessionViewInput,
  type TextChunk,
  type TranscriptSubscription,
  type UnreadableRun,
} from '@shared/schemas';
import {
  Database,
  type AggregateState,
  type DatabaseReadFailed,
} from '@shared/session/database';
import {
  SessionEvents,
  type CommittedBatch,
} from '@shared/session/sessionEvents';
import { SessionInputs } from '@shared/session/sessionInputs';
import { Settings } from '@shared/config/settings';
import { LISTED_KINDS } from './projections';
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

/**
 * The replay a view starts from, read from the store as of `at`: the
 * listing, the subscribed aggregates' rows, and the existence of every
 * aggregate they name. A session's reader and a cold read of a store no
 * session holds both start here.
 */
export const readReplay = Effect.fnUntraced(function* (
  log: Context.Service.Shape<typeof Database>,
  read: {
    readonly debug: boolean;
    readonly local: LocalRuntimeState;
    readonly subscriptions: readonly TranscriptSubscription[];
    readonly at: number;
  },
) {
  const listing = (yield* requiredRead(log.readListing())).filter(isDisplayRow);
  const checked = new Set<AggregateId>(read.subscriptions.map(({ id }) => id));
  for (const event of listing)
    for (const id of referencedAggregates(event)) checked.add(id);
  const aggregateRows: DisplayRow[] = [];
  for (const aggregate of read.subscriptions) {
    aggregateRows.push(
      ...(yield* requiredRead(
        log.readDisplayAggregate(aggregate.id, aggregate.fromSeq),
      )),
    );
  }
  const checkedIds = [...checked];
  const replayState = yield* requiredRead(
    log.readInputBatch([], read.at, read.at, checkedIds),
  );
  return replayInputs({
    debug: read.debug,
    local: read.local,
    listing,
    subscriptions: read.subscriptions,
    aggregateRows,
    existence: reconcileExistence(checkedIds, replayState),
  });
});

export const sessionInputsLayer = Layer.effect(
  SessionInputs,
  Effect.gen(function* () {
    const log = yield* Database;
    const events = yield* SessionEvents;
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
            // Both before the head is read: every batch past it reaches
            // them, one to wake this reader, one to take the batches from.
            const wake = yield* events.subscribe;
            const batches = yield* events.subscribe;
            const head = events.head();
            const anchor = effectiveCommit === 0 ? head : effectiveCommit;
            const initialLocal = yield* SubscriptionRef.get(local.ref);
            const replay = yield* readReplay(log, {
              debug,
              local: initialLocal,
              subscriptions: effectiveAggregates,
              at: anchor,
            });
            const subscribed = new Set(aggregates.map(({ id }) => id));
            /** What this view reads of a committed row: a listing kind of
             *  any aggregate, any row of a subscribed one. */
            const wanted = (row: DisplayRow) =>
              LISTED_KINDS.has(row.type) || subscribed.has(row.aggregateId);
            /** What the view starts behind the publisher: read once, by
             *  the first step. */
            const behind =
              anchor < head
                ? requiredRead(
                    log.readInputBatch(
                      aggregates.map(({ id }) => id),
                      anchor,
                      head,
                      [],
                    ),
                  )
                : Effect.succeed({ events: [], state: [], damaged: [] });
            // Every level replays on subscribe, so the first step captures
            // the text and the local state as of now.
            const wakes = Stream.mergeAll<unknown, never, never>(
              [
                Stream.flattenTake(Stream.fromSubscription(wake)),
                SubscriptionRef.changes(local.ref),
                SubscriptionRef.changes(text.ref),
              ],
              { concurrency: 3 },
            );
            const tail = wakes.pipe(
              // Wakeups carry no data: the next step takes every source's
              // current state. Retain one pending step, not a backlog.
              Stream.buffer({ capacity: 1, strategy: 'dropping' }),
              Stream.mapAccumEffect(
                () => ({
                  cursor: anchor,
                  first: true,
                  text: new Map() as InflightText,
                  local: initialLocal,
                }),
                Effect.fnUntraced(function* (previous) {
                  // Text first, then the batches: a row committed before a
                  // chunk was published before the chunk reached the text.
                  const nextText = yield* SubscriptionRef.get(text.ref);
                  const snapshot = yield* SubscriptionRef.get(local.ref);
                  const caughtUp = previous.first
                    ? yield* behind
                    : { events: [], state: [], damaged: [] };
                  const from = previous.first
                    ? Math.max(anchor, head)
                    : previous.cursor;
                  const taken = (yield* PubSub.takeUpTo(
                    batches,
                    Number.MAX_SAFE_INTEGER,
                  )).flatMap((take): readonly CommittedBatch[] =>
                    Exit.isExit(take) ? [] : take,
                  );
                  const cursor = Math.max(
                    from,
                    ...taken.map(({ through }) => through),
                  );
                  const rows = [
                    ...caughtUp.events,
                    ...taken.flatMap(({ rows }) =>
                      rows.filter((row) => row.commit > from && wanted(row)),
                    ),
                  ];
                  // A removal closes its run and the runs under it, which
                  // the marker names.
                  const closed = rows.flatMap((row) =>
                    row.type === 'run.removed'
                      ? row.runIds.map((id) => qualifyAggregateId('run', id))
                      : [],
                  );
                  const existence: ExistenceReconciliation = {
                    ...reconcileExistence([], caughtUp),
                    checkedAggregateIds: closed,
                  };
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
                    // The first step publishes the anchor: the replay
                    // reconciles existence but moves no cursor.
                    previous.first
                  ) {
                    // Every nonempty batch needs its closing marker so the
                    // webview decoder can release it as one complete read.
                    inputs.push({ _tag: 'drained', cursor, existence });
                  }
                  const batch: SessionViewInput[] = [
                    ...changed,
                    ...rows.map((event): SessionViewInput => ({
                      _tag: 'event',
                      read: 'all',
                      event,
                    })),
                    ...inputs,
                  ];
                  return [
                    { cursor, first: false, text: nextText, local: snapshot },
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
function reconcileExistence(
  checkedAggregateIds: readonly AggregateId[],
  read: {
    readonly state: readonly AggregateState[];
    readonly damaged: readonly UnreadableRun[];
  },
): ExistenceReconciliation {
  return {
    checkedAggregateIds: [...checkedAggregateIds],
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
