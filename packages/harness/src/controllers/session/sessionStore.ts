/** One session's store-facing owner: the log (`SessionLog`, the one
 *  transaction door with its reads and each run's trace), over the
 *  root's publisher and database.
 *
 *  "Published" means folded: a transaction returns once the session's tail
 *  has delivered, and its view has folded, every commit it made, so a caller
 *  that reads the view next sees what it wrote. The raw tail is delivered
 *  here too ({@link SessionStore.deliver}): it drops the transient text a
 *  committed row closes and hands a run's removal to the session. "Settled"
 *  waits further, for the reader of the folded tail to run over a commit. */
import {
  type Context,
  Deferred,
  Effect,
  Option,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  qualifyAggregateId,
  aggregateTarget,
  type CommitOrdinal,
  type RunId,
  type SessionEvent,
} from '@shared/schemas';
import {
  Database,
  type DatabaseAggregateClosed,
  type DatabaseReadFailed,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import {
  SessionEvents,
  tailFrom,
  type Append,
  type SessionEventsShape,
  type UnfoldedDraft,
} from '@shared/session/sessionEvents';
import { RUN_ROW_READS, runRowsFrom } from '@shared/session/runRowReads';
import { RUN_STATE_ROW_TYPES } from '@shared/session/runState';
import type {
  SessionLogShape,
  SessionTransaction,
} from '@shared/session/sessionLog';

import { makeRunTrace } from './runTrace';
import { SessionViewService } from './SessionView';
import { TextChunkSource } from './sessionSources';

/** What the session layer composes a session from, beside the handle. The
 *  store is the one owner of the session's publisher: nothing else reaches
 *  its transactions. */
export interface SessionStore {
  readonly log: SessionLogShape;
  /** The publisher's detached door: for a producer with no fiber to wait on
   *  (the inbox's own sends, an interrupted request's cancellation). */
  readonly detach: SessionEventsShape['detach'];
  /** Remove a run and its dependents, as the publisher's next job. */
  readonly removeRun: SessionEventsShape['removeRun'];
  /** The tail as the view has folded it (each row released once the view
   *  holds its state), for the session's one reader: `settled` waits until
   *  it has run over a commit, so it never waits on `settled` itself. */
  readonly folded: Stream.Stream<SessionEvent, DatabaseReadFailed>;
  /** Deliver the raw tail from the store's opening commit for the caller's
   *  scope: each committed row drops the transient text it closes, a run's
   *  removal is handed to `removed`, and the position it reaches is what a
   *  transaction's settle waits for. */
  readonly deliver: (
    removed: (runId: RunId) => void,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Drain the publisher inside the close deadline, then shut the doors:
   *  from here on a trace row, a transcript subscription and an interrupted
   *  request's cancellation write nothing; the first late trace row says so. */
  readonly close: Effect.Effect<void>;
  readonly closed: () => boolean;
}

const CHANNEL = 'sessionStore';

/** Whether `row` is a run's deletion marker. */
const isRemoval = (row: SessionEvent | undefined): boolean =>
  row?.type === 'run.removed';

/** Log a failure on this channel, with the failure attached as its `data`. */
const logFailure =
  (message: string, log = Effect.logWarning) =>
  (data: unknown) =>
    log(message).pipe(Effect.annotateLogs({ data }), withLogChannel(CHANNEL));

/** The settled level: the lesser of what the tail delivered and what the
 *  view folded. `to(commit)` waits until it (or `level`) reaches `commit`;
 *  it dies with the tail or the level's end, so it never hangs. */
function settlement(
  view: Context.Service.Shape<typeof SessionViewService>,
  delivered: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
  tailEnded: Deferred.Deferred<void, DatabaseReadFailed>,
) {
  const cursor = () =>
    Math.min(
      SubscriptionRef.getUnsafe(view.ref).cursor,
      SubscriptionRef.getUnsafe(delivered),
    );
  /** The level as a stream, re-read on every move of either coordinate; it
   *  ends with the fold (`view.changes`), whose defect it carries. */
  const changes = Stream.merge(
    view.changes,
    SubscriptionRef.changes(delivered),
    { haltStrategy: 'left' },
  ).pipe(Stream.map(cursor));
  const to = (commit: CommitOrdinal, level = changes): Effect.Effect<void> =>
    level.pipe(
      Stream.filter((at) => at >= commit),
      Stream.runHead,
      Effect.raceFirst(
        Deferred.await(tailEnded).pipe(
          Effect.orDie,
          Effect.andThen(
            Effect.die(new Error('Session committed-event consumer stopped')),
          ),
        ),
      ),
      Effect.flatMap((level) =>
        Option.isSome(level)
          ? Effect.void
          : Effect.die(
              new Error('Session view or reader stopped before settling'),
            ),
      ),
    );
  return { cursor, changes, to };
}

/** One transaction on the publisher, settled against its own last commit,
 *  never another job's: one that appended nothing returns at once. */
const transaction =
  (
    events: SessionEventsShape,
    settleTo: (commit: CommitOrdinal) => Effect.Effect<void>,
  ) =>
  <A, E>(
    job: (tx: SessionTransaction) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | DatabaseAggregateClosed | DatabaseWriteFailed> =>
    Effect.gen(function* () {
      let committed: CommitOrdinal | null = null;
      const tx = (append: Append): SessionTransaction => ({
        append: (drafts) =>
          Effect.tap(append(drafts), (rows) =>
            Effect.sync(() => {
              committed = rows.at(-1)?.commit ?? committed;
            }),
          ),
      });
      const value = yield* events.transact((append) => job(tx(append)));
      if (committed !== null) yield* settleTo(committed);
      return value;
    });

/**
 * Build one root's {@link SessionStore} in the session's scope. `storage`
 * names the root in what it logs.
 */
export const makeSessionStore = Effect.fn('sessionStore.makeSessionStore')(
  function* (
    storage: string,
  ): Effect.fn.Return<
    SessionStore,
    DatabaseReadFailed,
    | Scope.Scope
    | SessionEvents
    | Database
    | SessionViewService
    | TextChunkSource
  > {
    const events = yield* SessionEvents;
    const database = yield* Database;
    const view = yield* SessionViewService;
    const chunks = yield* TextChunkSource;
    // Captured before anything can publish: the tails' first reads cover
    // every commit after it.
    const anchor = yield* database.currentCommit;
    const delivered = yield* SubscriptionRef.make(anchor);
    const tailEnded = yield* Deferred.make<void, DatabaseReadFailed>();
    const settle = settlement(view, delivered, tailEnded);
    const foldedRead = yield* SubscriptionRef.make(anchor);
    const foldedEnded = yield* Deferred.make<void>();
    const foldedLevel = SubscriptionRef.changes(foldedRead).pipe(
      Stream.interruptWhen(Deferred.await(foldedEnded)),
    );
    const readPast = (commit: CommitOrdinal) => settle.to(commit, foldedLevel);
    const transact = transaction(events, settle.to);
    let doorsShut = false;
    const closed = () => doorsShut;
    /** Jobs before it ran, `folded` read past them; its end fails only this. */
    const settled = events
      .transact(() => database.currentCommit, { order: true })
      .pipe(Effect.orDie, Effect.flatMap(readPast));
    const trace = makeRunTrace({
      storage,
      events,
      text: chunks.ref,
      settled,
      closed,
    });
    const log: SessionLogShape = {
      transact: <A, E>(
        work:
          | readonly UnfoldedDraft[]
          | ((tx: SessionTransaction) => Effect.Effect<A, E>),
      ) => {
        if (typeof work === 'function') return transact(work);
        // An empty batch is a barrier: every job before it has run.
        return work.length === 0
          ? events.transact(() => Effect.succeed([]), { order: true })
          : transact((tx) => tx.append(work));
      },
      publish: trace.publish,
      lost: trace.lost,
      closure: trace.closure,
      settled,
      now: () => SubscriptionRef.getUnsafe(database.observedCommit),
      history: (id, fromSeq = 1, types = RUN_STATE_ROW_TYPES) =>
        database.readAggregate(id, fromSeq, types),
      runRows: (id, read, through) =>
        database
          .readAggregate(id, 1, RUN_ROW_READS[read], through)
          .pipe(Effect.map(runRowsFrom)),
      blobs: database.readBlobs,
      facts: (runId) =>
        database
          .readRunRecords(qualifyAggregateId('run', runId))
          .pipe(Effect.map((rows) => (rows[0] ? runRowsFrom(rows) : null))),
      // A removed run's rows end with its deletion marker: none to show.
      display: (runId) =>
        Effect.map(
          database.readDisplayAggregate(qualifyAggregateId('run', runId), 1),
          (rows) => (isRemoval(rows.at(-1)) ? [] : rows),
        ),
      tail: events.all,
      listing: events.listing,
      movedAside: database.movedAside,
    };
    return {
      log,
      detach: events.detach,
      removeRun: events.removeRun,
      // Pulled in order: `foldedRead` moves once a read's rows were run.
      folded: tailFrom(
        database.readDisplay,
        { get: Effect.sync(settle.cursor), changes: settle.changes },
        anchor,
        foldedRead,
      ).pipe(Stream.ensuring(Deferred.succeed(foldedEnded, undefined))),
      deliver: (removed) =>
        events.all(anchor, delivered).pipe(
          Stream.runForEach(
            Effect.fnUntraced(function* (event) {
              const target = aggregateTarget(event.aggregateId);
              if (target.kind === 'run' && isRemoval(event)) removed(target.id);
              yield* trace.committed(event);
              yield* SubscriptionRef.set(delivered, event.commit);
            }),
          ),
          Effect.tapError(
            logFailure(
              `Session ${storage} stopped delivering committed rows: the log could not be read.`,
              Effect.logError,
            ),
          ),
          Effect.onExit((exit) => Deferred.done(tailEnded, exit)),
          Effect.forkScoped,
          Effect.asVoid,
        ),
      close: events.drain.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            doorsShut = true;
          }),
        ),
      ),
      closed,
    };
  },
);
