/** One session's store-facing owner: the log (`SessionLog`, the one
 *  transaction door with its reads and each run's trace), over the
 *  root's publisher and database.
 *
 *  "Published" means applied: a transaction returns once the session's view
 *  has applied every commit it made, so a caller that reads the view next
 *  sees what it wrote. The view, the presenter and the trace's text all take
 *  the publisher's batches, published from what each job wrote; nothing here
 *  reads the store back. "Settled" waits further, for the presenter to run
 *  over a commit. */
import {
  Deferred,
  Effect,
  FiberSet,
  Option,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import {
  qualifyAggregateId,
  type CommitOrdinal,
  type DisplayRow,
} from '@shared/schemas';
import {
  Database,
  type DatabaseAggregateClosed,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import {
  SessionEvents,
  type SessionEventsShape,
  type UnfoldedDraft,
} from '@shared/session/sessionEvents';
import { foldRunRows, RUN_ROW_READS } from '@shared/session/runRowReads';
import { RUN_STATE_ROW_TYPES } from '@shared/session/runState';
import type {
  SessionLogShape,
  SessionTransaction,
} from '@shared/session/sessionLog';

import { makeRunTrace } from './runTrace';
import { SessionViewService } from './sessionViewService';
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
  /** The committed display rows, each batch released once the view has
   *  applied it, for the session's one presenter: `settled` waits until it
   *  has run over a commit, so the presenter never waits on `settled`. */
  readonly applied: Stream.Stream<DisplayRow>;
  /** Drain the publisher inside the close deadline, then shut the doors:
   *  from here on a trace row, a transcript subscription and an interrupted
   *  request's cancellation write nothing; the first late trace row says so. */
  readonly close: Effect.Effect<void>;
  readonly closed: () => boolean;
}

/** Wait until `level` reaches `commit`; it dies if `level` ends first
 *  (`stopped` names what stopped), so it never hangs. */
const reach = (
  level: Stream.Stream<CommitOrdinal>,
  commit: CommitOrdinal,
  stopped: string,
): Effect.Effect<void> =>
  level.pipe(
    Stream.filter((at) => at >= commit),
    Stream.runHead,
    Effect.flatMap((at) =>
      Option.isSome(at) ? Effect.void : Effect.die(new Error(stopped)),
    ),
  );

/**
 * Build one root's {@link SessionStore} in the session's scope. `storage`
 * names the root in what it logs.
 */
export const makeSessionStore = Effect.fn('sessionStore.makeSessionStore')(
  function* (
    storage: string,
  ): Effect.fn.Return<
    SessionStore,
    never,
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
    // Taken now, before anything can publish: they see every batch.
    const textFeed = yield* events.subscribe;
    const presenterFeed = yield* events.subscribe;
    const presented = yield* SubscriptionRef.make(events.head());
    const presenterEnded = yield* Deferred.make<void>();
    const viewApplied = (commit: CommitOrdinal) =>
      reach(
        Stream.map(view.changes, ({ cursor }) => cursor),
        commit,
        'Session view stopped before applying a commit',
      );
    /** One transaction on the publisher, returned once the view applied its
     *  own last commit, never another job's: one that appended nothing
     *  returns at once. */
    const transact = <A, E>(
      job: (tx: SessionTransaction) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | DatabaseAggregateClosed | DatabaseWriteFailed> =>
      Effect.flatMap(
        events.transact((append) => job({ append })),
        ({ value, through }) =>
          through === null
            ? Effect.succeed(value)
            : Effect.as(viewApplied(through), value),
      );
    let doorsShut = false;
    const closed = () => doorsShut;
    /** The presenter ran past every job committed so far; its end fails
     *  only this. */
    const settled = Effect.suspend(() =>
      reach(
        SubscriptionRef.changes(presented).pipe(
          Stream.interruptWhen(Deferred.await(presenterEnded)),
        ),
        events.head(),
        'Session presenter stopped before settling',
      ),
    );
    const trace = makeRunTrace({
      storage,
      events,
      text: chunks.ref,
      run: yield* FiberSet.makeRuntime<never, void, never>(),
      closed,
    });
    // The text a committed row closes is dropped as its batch is published.
    yield* Stream.flattenTake(Stream.fromSubscription(textFeed)).pipe(
      Stream.runForEach(({ rows }) =>
        Effect.forEach(rows, trace.committed, { discard: true }),
      ),
      Effect.forkScoped,
    );
    const log: SessionLogShape = {
      transact: <A, E>(
        work:
          | readonly UnfoldedDraft[]
          | ((tx: SessionTransaction) => Effect.Effect<A, E>),
      ) => {
        if (typeof work === 'function') return transact(work);
        return work.length === 0
          ? Effect.succeed([])
          : transact((tx) => tx.append(work));
      },
      publish: trace.publish,
      lost: trace.lost,
      closure: trace.closure,
      settled,
      now: events.head,
      history: (id, fromSeq = 1, types = RUN_STATE_ROW_TYPES) =>
        database.readAggregate(id, fromSeq, types),
      runRows: (id, read, through) =>
        database
          .readAggregate(id, 1, RUN_ROW_READS[read].kinds, through)
          .pipe(Effect.map((rows) => foldRunRows(read, rows))),
      blobs: database.readBlobs,
      facts: (runId) =>
        database.readRunRecord(qualifyAggregateId('run', runId)),
      // A removed run's rows end with its deletion marker: none to show.
      display: (runId) =>
        Effect.map(
          database.readDisplayAggregate(qualifyAggregateId('run', runId), 1),
          (rows) => (rows.at(-1)?.type === 'run.removed' ? [] : rows),
        ),
      tail: events.all,
      listing: database.readListing,
      movedAside: database.movedAside,
    };
    return {
      log,
      detach: events.detach,
      removeRun: events.removeRun,
      // Pulled in order: `presented` moves once a batch's rows were run.
      applied: Stream.flattenTake(Stream.fromSubscription(presenterFeed)).pipe(
        Stream.mapEffect((batch) =>
          Effect.as(viewApplied(batch.through), batch),
        ),
        Stream.flatMap(({ rows, through }) =>
          Stream.concat(
            Stream.fromIterable(rows),
            Stream.drain(
              Stream.fromEffect(SubscriptionRef.set(presented, through)),
            ),
          ),
        ),
        Stream.ensuring(Deferred.succeed(presenterEnded, undefined)),
      ),
      close: events.close.pipe(
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
