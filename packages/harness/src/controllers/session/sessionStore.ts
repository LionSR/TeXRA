/**
 * One session's store-facing owners: the log (`SessionLog`, the one
 * transaction door with its reads and claims) and the trace sink
 * (`RunTrace`), over the root's publisher and database.
 *
 * "Published" means folded: a transaction returns once the session's tail
 * has delivered, and its view has folded, every commit it made, so a caller
 * that reads the view next sees what it wrote. The raw tail is delivered
 * here too ({@link SessionStore.deliver}): it drops the transient text a
 * committed row closes and hands a run's removal to the session, and its
 * position is half of what "settled" waits for.
 */
import {
  type Context,
  Deferred,
  Effect,
  Option,
  RcMap,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import type {
  RunTrace,
  SessionLog,
  SessionTransaction,
} from '@agent/runtime/SessionHandle';
import { tailFrom } from '@agent/runtime/SessionEvents';
import { withLogChannel } from '@logger/effectLog';
import {
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  type AggregateId,
  type CommitOrdinal,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  Database,
  type DatabaseNotOwner,
  type DatabaseReadFailed,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import {
  ProcessIdentity,
  SessionEvents,
  type Append,
  type SessionEventsShape,
} from '@shared/session/sessionEvents';

import { makeRunTrace } from './runTrace';
import { SessionViewService } from './SessionView';
import { TextChunkSource } from './sessionSources';

const CHANNEL = 'sessionStore';

/** What the session layer composes a session from, beside the handle. The
 *  store is the one owner of the session's publisher: nothing else reaches
 *  its transactions. */
export interface SessionStore {
  readonly log: SessionLog;
  readonly trace: RunTrace;
  /** The publisher's detached door: for a producer with no fiber to wait on
   *  (the inbox's own sends, an interrupted request's cancellation). */
  readonly detach: SessionEventsShape['detach'];
  /** Remove a run and its dependents, as the publisher's next job. */
  readonly removeRun: SessionEventsShape['removeRun'];
  /** The tail as the view has folded it: every row above the store's
   *  opening commit, released once the view holds the state that folded
   *  it, for a reader that reads the view beside each row. */
  readonly folded: Stream.Stream<SessionEvent, DatabaseReadFailed>;
  /**
   * Deliver the raw tail from the store's opening commit for the caller's
   * scope: each committed row drops the transient text it closes, a run's
   * `run.removed` is handed to `removed`, and the position it reaches is
   * what a transaction's settle waits for.
   */
  readonly deliver: (
    removed: (runId: RunId) => void,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Drain the publisher inside the close deadline, then shut the doors:
   *  from here on a trace row, a transcript subscription and an interrupted
   *  request's cancellation write nothing, and the first late trace row
   *  says so. */
  readonly close: Effect.Effect<void>;
  readonly closed: () => boolean;
}

type DatabaseShape = Context.Service.Shape<typeof Database>;

/** Log a failure on this channel, with the failure attached as its `data`. */
const logFailure =
  (message: string, log = Effect.logWarning) =>
  (data: unknown) =>
    log(message).pipe(Effect.annotateLogs({ data }), withLogChannel(CHANNEL));

/**
 * The settled level: the lesser of what the tail delivered and what the
 * view folded. `to(commit)` waits until it reaches `commit`; it dies with
 * the tail or the fold, so a wait is answered or fails, never hangs.
 */
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
  const to = (commit: CommitOrdinal): Effect.Effect<void> =>
    changes.pipe(
      Stream.filter((level) => level >= commit),
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
              new Error('Session view stopped before publication settled'),
            ),
      ),
    );
  return { cursor, changes, to };
}

/**
 * This process's holds on run claims, counted: the first holder proves any
 * prior owner dead and takes the claim (or finds it already this
 * process's), later holders share it, and the claim's disposition is
 * decided when the last holder's scope closes: given back to how the first
 * found it, or released when a hold `ends` it. The map closes with the
 * session, deciding whatever is still held.
 */
const claimHolds = (database: DatabaseShape) =>
  Effect.map(
    RcMap.make({
      lookup: (id: AggregateId) =>
        Effect.acquireRelease(
          database
            .acquireClaims([id])
            .pipe(
              Effect.map((ids) => ({ taken: ids.length > 0, ended: false })),
            ),
          (hold) =>
            hold.taken || hold.ended
              ? database
                  .releaseClaims([id])
                  .pipe(
                    Effect.catch(
                      logFailure(
                        `The claim on ${id} was not released; the next process proves this one dead before it takes the claim.`,
                      ),
                    ),
                  )
              : Effect.void,
        ),
    }),
    (claims): SessionLog['hold'] =>
      (runId, options = {}) =>
        Effect.map(
          RcMap.get(claims, qualifyAggregateId('run', runId)),
          (hold) => {
            if (options.ends === true) hold.ended = true;
          },
        ),
  );

/**
 * One transaction on the publisher, settled against its own last commit,
 * never another job's: one that appended nothing returns at once. A run the
 * job claimed or gave birth to is given back if the job fails, or if what it
 * committed never reaches the view.
 */
const transaction =
  (
    events: SessionEventsShape,
    database: DatabaseShape,
    settleTo: (commit: CommitOrdinal) => Effect.Effect<void>,
  ) =>
  <A, E>(
    job: (tx: SessionTransaction) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | DatabaseNotOwner | DatabaseWriteFailed> =>
    Effect.gen(function* () {
      let committed: CommitOrdinal | null = null;
      const owned: AggregateId[] = [];
      const release = Effect.suspend(() =>
        owned.length === 0
          ? Effect.void
          : database
              .releaseClaims(owned)
              .pipe(
                Effect.catch(
                  logFailure(
                    'Claims a refused transaction took were not released; the next process proves this one dead before it takes them.',
                  ),
                ),
              ),
      );
      const tx = (append: Append): SessionTransaction => ({
        append: (drafts) =>
          Effect.tap(append(drafts), (rows) =>
            Effect.sync(() => {
              const last = rows.at(-1);
              if (last !== undefined) committed = last.commit;
              for (const row of rows)
                if (row.type === 'run.start') owned.push(row.aggregateId);
            }),
          ),
        claim: (runId) => {
          const id = qualifyAggregateId('run', runId);
          // Only what this call took: a claim the process already held is
          // not this transaction's to give back.
          return Effect.tap(database.acquireClaims([id]), (taken) =>
            Effect.sync(() => owned.push(...taken)),
          );
        },
      });
      const value = yield* events
        .transact((append) => job(tx(append)))
        .pipe(Effect.onError(() => release));
      if (committed !== null)
        yield* settleTo(committed).pipe(Effect.onError(() => release));
      return value;
    });

/**
 * Build one root's {@link SessionStore} in the session's scope. `storage`
 * names the root in what it logs.
 */
export const makeSessionStore = (
  storage: string,
): Effect.Effect<
  SessionStore,
  DatabaseReadFailed,
  | Scope.Scope
  | SessionEvents
  | Database
  | ProcessIdentity
  | SessionViewService
  | TextChunkSource
> =>
  Effect.gen(function* () {
    const events = yield* SessionEvents;
    const database = yield* Database;
    const { ownerId } = yield* ProcessIdentity;
    const view = yield* SessionViewService;
    const chunks = yield* TextChunkSource;
    // Captured before anything can publish: the tails' first reads cover
    // every commit after it.
    const anchor = yield* database.currentCommit;
    const delivered = yield* SubscriptionRef.make(anchor);
    const tailEnded = yield* Deferred.make<void, DatabaseReadFailed>();
    const settle = settlement(view, delivered, tailEnded);
    const transact = transaction(events, database, settle.to);
    let doorsShut = false;
    const closed = () => doorsShut;
    /** Every job enqueued before it has run, and the view folded it. */
    const settled = events
      .transact(() => database.currentCommit)
      .pipe(Effect.orDie, Effect.flatMap(settle.to));
    const trace = makeRunTrace({
      storage,
      events,
      text: chunks.ref,
      settled,
      closed,
    });
    const log: SessionLog = {
      transact: <A, E>(
        work:
          | readonly SessionEventDraft[]
          | ((tx: SessionTransaction) => Effect.Effect<A, E>),
      ) =>
        typeof work === 'function'
          ? transact(work)
          : transact((tx) => tx.append(work)),
      publish: trace.publish,
      settled,
      now: () => SubscriptionRef.getUnsafe(database.observedCommit),
      rows: (id, types) => database.readAggregate(id, 1, types),
      records: (runId) =>
        database.readRunRecords(qualifyAggregateId('run', runId)),
      display: (runId) =>
        Effect.map(
          database.readDisplayAggregate(qualifyAggregateId('run', runId), 1),
          (rows) => (rows.at(-1)?.type === 'run.removed' ? [] : rows),
        ),
      tail: events.all,
      listing: events.listing,
      hold: yield* claimHolds(database),
      owns: (runId) =>
        Effect.map(
          database.aggregateState([qualifyAggregateId('run', runId)]),
          (states) =>
            states.some(
              (state) =>
                state.startCommit !== null &&
                !state.closed &&
                state.ownerId === ownerId,
            ),
        ),
      owner: (runId) => database.claimOwner(qualifyAggregateId('run', runId)),
      movedAside: database.movedAside,
    };
    return {
      log,
      trace,
      detach: events.detach,
      removeRun: events.removeRun,
      folded: tailFrom(
        database.readDisplay,
        { get: Effect.sync(settle.cursor), changes: settle.changes },
        anchor,
      ),
      deliver: (removed) =>
        events.all(anchor, delivered).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              const target = aggregateTarget(event.aggregateId);
              if (event.type === 'run.removed' && target.kind === 'run')
                removed(target.id);
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
  });
