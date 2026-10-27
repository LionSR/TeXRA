/**
 * Read durable events before the live text that follows them. Changes in
 * the three source levels are only wakeups: each read captures text first,
 * then the log ordinal, and drains that finite prefix before yielding text.
 * Thus a committed run.start has reached this reader before its first chunk.
 */
// Node imports
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import {
  Effect,
  Layer,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  DEBUG_MODE_KEY,
  referencedAggregates,
  isDisplaySessionEvent,
  RunIdSchema,
  type AggregateId,
  type CommitOrdinal,
  type LocalRuntimeState,
  type ExistenceReconciliation,
  type SessionEvent,
  type SessionViewInput,
  type TextChunk,
  type TranscriptSubscription,
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
  type InflightText,
  type InflightTextChunk,
} from './sessionSources';
import { WorkspaceRoots } from './WorkspaceRoots';

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

/** The three levels a read captures: the store's (its wake level and its
 *  rows), this process's local state, and the in-flight text. */
interface Sources {
  readonly log: Database['Service'];
  readonly local: LocalRuntimeSource['Service'];
  readonly text: TextChunkSource['Service'];
}

/** What the tail carries from one drain to the next. */
interface TailState {
  readonly cursor: CommitOrdinal;
  /** The wake level the last durable read saw; -1 before the first, so the
   *  first drain reads. */
  readonly level: number;
  readonly text: InflightText;
  readonly local: LocalRuntimeState;
  /** The last durable read's existence, whose surviving claims the next read
   *  checks. None before the first drain, which must publish the anchor:
   *  replay.complete reconciles existence but does not advance the cursor. */
  readonly existence: ExistenceReconciliation | undefined;
}

/** The durable half of a drain: the rows committed past the cursor, and the
 *  existence of the aggregates still checked. */
interface DurableRead {
  readonly cursor: CommitOrdinal;
  readonly rows: readonly SessionEvent[];
  readonly existence: ExistenceReconciliation | undefined;
}

/** The process's `SessionInputs`: a replay batch read from the store, then
 *  each later batch of committed rows, in-flight text and local state. */
export const sessionInputsLayer = Layer.effect(
  SessionInputs,
  Effect.gen(function* () {
    const sources: Sources = {
      log: yield* Database,
      local: yield* LocalRuntimeSource,
      text: yield* TextChunkSource,
    };
    const roots = yield* WorkspaceRoots;
    return {
      read: (aggregates, fromCommit, previousDebug) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const debug = roots.config
              ? Settings.getConfig<boolean>(roots.config, DEBUG_MODE_KEY)
              : false;
            const reset = debug !== previousDebug;
            const { replay, initial, existence } = yield* coldReplay(
              sources,
              reset
                ? aggregates.map((entry) => ({ ...entry, fromSeq: 0 }))
                : aggregates,
              reset ? 0 : fromCommit,
              debug,
            );
            const ids = aggregates.map(({ id }) => id);
            // Every level replays on subscribe; changes during the cold read
            // are therefore covered by the first finite tail read.
            const tail = Stream.mergeAll<unknown, never, never>(
              [
                SubscriptionRef.changes(sources.log.level),
                SubscriptionRef.changes(sources.local.ref),
                SubscriptionRef.changes(sources.text.ref),
              ],
              { concurrency: 3 },
            ).pipe(
              // Wakeups carry no data: the next read captures every source's
              // current level. Retain one pending read, not a backlog of reads
              // of the same state after a burst of text chunks.
              Stream.buffer({ capacity: 1, strategy: 'dropping' }),
              Stream.mapAccumEffect(
                () => initial,
                (previous) => drain(sources, ids, existence, previous),
              ),
            );
            return Stream.concat(Stream.make(replay), tail);
          }),
        ),
    };
  }),
);

/** The cold read a subscription starts with: the debug flag, the listing,
 *  each subscribed aggregate's display rows from its seq, then the local
 *  state and the existence the tail starts from, closed by `replay.complete`. */
const coldReplay = Effect.fnUntraced(function* (
  { log, local }: Sources,
  aggregates: readonly TranscriptSubscription[],
  fromCommit: CommitOrdinal,
  debug: boolean,
) {
  const anchor =
    fromCommit === 0 ? yield* requiredRead(log.currentCommit) : fromCommit;
  const listing = (yield* requiredRead(log.readListing())).filter(
    isDisplaySessionEvent,
  );
  const checked = new Set<AggregateId>(aggregates.map(({ id }) => id));
  for (const event of listing)
    for (const id of referencedAggregates(event)) checked.add(id);
  const replay: SessionViewInput[] = [
    { _tag: 'debug', enabled: debug },
    ...listing.map((event) => ({
      _tag: 'event' as const,
      read: 'listing' as const,
      event,
    })),
    { _tag: 'subscriptions', set: [...aggregates] },
  ];
  for (const aggregate of aggregates) {
    const rows = yield* requiredRead(
      log.readDisplayAggregate(aggregate.id, aggregate.fromSeq),
    );
    for (const event of rows)
      replay.push({ _tag: 'event', read: 'aggregate', event });
  }
  const state = yield* requiredRead(
    log.readInputBatch(
      aggregates.map(({ id }) => id),
      anchor,
      [...checked],
    ),
  );
  yield* markDamaged(local.ref, state.damaged);
  const existence = reconcileExistence(state);
  const initialLocal = yield* SubscriptionRef.get(local.ref);
  replay.push(
    { _tag: 'local', local: initialLocal },
    { _tag: 'replay.complete', existence },
  );
  const initial: TailState = {
    cursor: anchor,
    level: -1,
    text: new Map(),
    local: initialLocal,
    existence: undefined,
  };
  return { replay, initial, existence };
});

/** The rows committed past `from`, and the existence of the aggregates the
 *  last read found surviving (`known`) and of the subscribed ones. */
const readDurable = (
  { log, local }: Sources,
  ids: readonly AggregateId[],
  from: CommitOrdinal,
  known: ExistenceReconciliation,
): Effect.Effect<DurableRead> => {
  const checked = new Set(known.claims.map(({ aggregateId }) => aggregateId));
  // The read dedups the ids it checks.
  return requiredRead(log.readInputBatch(ids, from, [...checked, ...ids])).pipe(
    Effect.tap((read) => markDamaged(local.ref, read.damaged)),
    Effect.map((read) => ({
      cursor: read.cursor,
      rows: read.events,
      existence: reconcileExistence(read),
    })),
  );
};

/** One drain of the tail after a wakeup: the batch of what changed since
 *  `previous`, closed by its `drained` marker, or none. */
const drain = Effect.fnUntraced(function* (
  sources: Sources,
  ids: readonly AggregateId[],
  replayed: ExistenceReconciliation,
  previous: TailState,
) {
  // Text first, then the level: a row committed before a chunk moved the
  // level this read sees.
  const nextText = yield* SubscriptionRef.get(sources.text.ref);
  const snapshot = yield* SubscriptionRef.get(sources.local.ref);
  const level = yield* SubscriptionRef.get(sources.log.level);
  // A burst of text, or a local change, moved no durable state: only a new
  // level is worth a database read.
  const { cursor, rows, existence }: DurableRead =
    level === previous.level
      ? { cursor: previous.cursor, rows: [], existence: previous.existence }
      : yield* readDurable(
          sources,
          ids,
          previous.cursor,
          previous.existence ?? replayed,
        );
  const inputs: SessionViewInput[] = textChunks(previous.text, nextText);
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
    inputs.push({ _tag: 'drained', cursor, existence: existence ?? replayed });
  }
  const batch: SessionViewInput[] = [
    ...rows.filter(isDisplaySessionEvent).map((event): SessionViewInput => ({
      _tag: 'event',
      read: 'all',
      event,
    })),
    ...inputs,
  ];
  const next: TailState = {
    cursor,
    level,
    text: nextText,
    local: snapshot,
    existence,
  };
  return [next, batch.length === 0 ? [] : [batch]] as const;
});

/** Show each run that cannot open read-only with why (`unreadable`): a
 *  row of it does not decode, or an earlier build wrote one. */
const markDamaged = (
  ref: SubscriptionRef.SubscriptionRef<LocalRuntimeState>,
  damaged: LocalRuntimeState['unreadable'],
) =>
  // One atomic update against the other writers of this ref (the liveness
  // prober's `dead`, `updateLocal`'s `resumeBlocked`).
  SubscriptionRef.update(ref, (local) => {
    const known = new Set(local.unreadable.map(({ runId }) => runId));
    const fresh = damaged.filter(({ runId }) => !known.has(runId));
    // Only a new damaged run moves the level: an unchanged one would wake
    // this reader again for nothing, forever.
    return fresh.length > 0
      ? { ...local, unreadable: [...local.unreadable, ...fresh] }
      : local;
  });

/** An aggregate a removal closed no longer exists, even while the
 *  `run.removed` row is still stored. */
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
      runId: Schema.decodeUnknownSync(RunIdSchema)(key.slice(0, slash)),
      rowId: key.slice(slash + 1),
      from,
      to: value.length,
      text: parts.toReversed().join(''),
    });
  }
  return chunks;
}
