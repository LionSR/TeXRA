/**
 * The runtime event plane: the publisher and exhaustive event
 * readers, including the NDJSON projection. Renderers read SessionInputs,
 * which orders this log against the transient text and local levels.
 */
import {
  Array as Arr,
  Context,
  Effect,
  Exit,
  Layer,
  PubSub,
  type Scope,
  Stream,
  SubscriptionRef,
  type Take,
} from 'effect';

import type {
  AggregateId,
  CommitOrdinal,
  OwnerId,
  SessionRow,
  DisplayRow,
  SessionRowDraft,
} from '@shared/schemas';
import type {
  Database,
  DatabaseAggregateClosed,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from './database';
import type { RunStateRowType } from './runState';
import type { WithBlobs } from './historyTurns';

/** One piece of work a run's rows left open (`SessionEvents.openWork`). */
export interface OpenWork {
  readonly kind: 'stage' | 'stream';
  readonly id: string;
}

/** Whether this fiber runs a publisher job: inside one, the store's write
 *  lock is held, so waiting on the publisher would never end. */
export const InPublisherJob = Context.Reference<boolean>(
  '@texra-ai/harness/session/InPublisherJob',
  { defaultValue: () => false },
);

/** How a job runs. By default it is one SQLite transaction; `order` runs it
 *  in its place in the inbox with none, for a barrier or transient state
 *  that writes no row (its `append` is a defect). `failed` hears a detached
 *  job's own failure, a failed commit's included. */
export interface JobOptions {
  readonly order?: boolean;
  readonly failed?: (error: unknown) => void;
}

/** A row that is not part of any run's state, or a run's end, which nothing
 *  continues from until the next open folds it: any job may append it as
 *  is, with the blobs it stores. */
export type UnfoldedDraft = WithBlobs<
  Exclude<
    SessionRowDraft,
    { type: Exclude<RunStateRowType, 'run.end' | 'run.stop'> }
  >
>;

/** Rows another owner decides inside a job, appended with the job's own
 *  batch so both commit or neither. */
export type Alongside<E = never> = Effect.Effect<
  readonly UnfoldedDraft[],
  E,
  Scope.Scope
>;

/** One ordered append to the log, as the publisher hands it to a job: a
 *  savepoint of the job's one transaction. A row that is part of a run's
 *  state goes through `runStateAppend` instead, which only the run's cell
 *  (`RunCell.append`) and the session's requests hold. */
export type Append = (
  events: readonly UnfoldedDraft[],
) => Effect.Effect<
  readonly SessionRow[],
  DatabaseAggregateClosed | DatabaseWriteFailed
>;

/**
 * The canonical hostname, pid, and nullable process-start tuple: the
 * `origin` stamped on every event the process appends. Resolved once at each
 * process entry, where the start identity can be awaited, and provided to
 * the process layer.
 */
export class ProcessIdentity extends Context.Service<
  ProcessIdentity,
  { readonly ownerId: OwnerId }
>()('@texra-ai/harness/session/ProcessIdentity') {
  static layer(ownerId: OwnerId): Layer.Layer<ProcessIdentity> {
    return Layer.succeed(ProcessIdentity)({ ownerId });
  }
}

/**
 * The one publisher of a root's facts. Every write to the
 * log is a job on one inbox drained by one fiber, so the commit order of
 * the table is the order the jobs were enqueued: a trace row the tool
 * emitted, the loop's result batch that follows it, and a surface's
 * decision all land in program order, whichever fiber produced them. A job
 * receives the log's `Append` and writes through it; one that waits on the
 * publisher it runs on is a defect.
 */
export class SessionEvents extends Context.Service<
  SessionEvents,
  {
    /** Run one job as the next transaction of the inbox, one SQLite
     *  transaction, and return its value: reads of committed rows and the
     *  appends that depend on them, committed together or not at all, with
     *  no other write between them. An append refusal is one of two typed
     *  failures: `DatabaseAggregateClosed`, a target the process does not
     *  hold open, and `DatabaseWriteFailed`, the batch rolled back for any
     *  other reason; a job that lets one through writes nothing, and a
     *  transaction that fails to commit is `DatabaseWriteFailed` too.
     *  Neither is retried or converted here. A job is database-only.
     *  Called from inside a job, it is a defect: the job would wait on
     *  itself. */
    readonly transact: <A, E>(
      job: (append: Append) => Effect.Effect<A, E>,
      options?: Pick<JobOptions, 'order'>,
    ) => Effect.Effect<A, E | DatabaseWriteFailed>;
    /** Enqueue one job synchronously and return: the door for a producer
     *  with no fiber to wait on (a trace sink, a follow-up's admission).
     *  Its order is the moment of this call. A refused append is never
     *  retried: the job hears it, `failed` hears the job's own failure (a
     *  run's trace keeps either for the run's end, `RunTrace.lost`), and
     *  the publisher logs it. A job enqueued after the plane closed goes
     *  nowhere, and says so. */
    readonly detach: (
      job: (
        append: Append,
      ) => Effect.Effect<
        unknown,
        DatabaseAggregateClosed | DatabaseReadFailed | DatabaseWriteFailed
      >,
      options?: JobOptions,
    ) => void;
    /** Remove a run and its dependents: the deletion's transaction runs as
     *  the next job, so it commits in enqueue order and what this publisher
     *  tracks forgets every run it names. */
    readonly removeRun: (
      id: AggregateId,
      expectedStartCommit: CommitOrdinal,
    ) => Effect.Effect<
      readonly SessionRow[],
      DatabaseAggregateClosed | DatabaseWriteFailed
    >;
    /** Close the plane: end the inbox and run what it holds, inside the
     *  one close deadline (`SESSION_CLOSE_DEADLINE_MS`). At the deadline
     *  the running job is cut (its transaction rolls back unless it had
     *  committed) and every queued one is refused, never joined without
     *  limit. Idempotent; the
     *  publisher's scope runs it too. */
    readonly drain: Effect.Effect<void>;
    /** What this publisher committed open on one aggregate and nothing has
     *  closed since, in first-appearance order: a stream until its
     *  `stream.end` or a phase move that pauses or ends its run, a stage
     *  until its `stage.end`. What a run's wait (streams) or a host exit
     *  (both) closes. Read on the publisher fiber (inside a job) or after
     *  `SessionLog.settled`, it counts every job committed before. */
    readonly openWork: (aggregateId: AggregateId) => readonly OpenWork[];
    /** The listing read from storage: the latest row per aggregate and type
     *  for the listing fact types plus the outstanding approvals, in commit
     *  order; never a transcript row; completes. */
    readonly listing: () => Stream.Stream<DisplayRow, DatabaseReadFailed>;
    /** Every event with commit above `fromCommit`, in commit order across
     *  aggregates, then the tail, which ends when the session closes; every
     *  tail shares one read of each commit. Transcript rows of unsubscribed
     *  aggregates included: the live tail and the frozen NDJSON projection
     *  read it.
     *  `drained`, when given, receives the commit each forward read of the
     *  tail covered, rows it could not materialize included, once every row
     *  of that read has reached the reader; the transport plane never sets
     *  it. */
    readonly all: (
      fromCommit: CommitOrdinal,
      drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
    ) => Stream.Stream<DisplayRow, DatabaseReadFailed>;
  }
>()('@texra-ai/harness/session/SessionEvents') {}

export type SessionEventsShape = Context.Service.Shape<typeof SessionEvents>;

/** A read's share of the log in commit order: its rows (a page at a time)
 *  and the commit they reach. A read's last share covers its whole range,
 *  rows the store no longer held included. */
interface Delivery<A> {
  readonly rows: readonly A[];
  readonly through: CommitOrdinal;
}

/** A read of the rows above a commit, and what wakes a drain of them: the
 *  committed upper bound to read to, and its moves. */
type Read<A, E> = (fromCommit: CommitOrdinal) => Stream.Stream<A, E>;
interface DrainLevel<E> {
  readonly get: Effect.Effect<CommitOrdinal, E>;
  readonly changes: Stream.Stream<unknown>;
}

/** One read of the rows above `fromCommit` through `upTo`, never past it. */
const readThrough = <A extends SessionRow, E>(
  read: Read<A, E>,
  fromCommit: CommitOrdinal,
  upTo: CommitOrdinal,
): Stream.Stream<Delivery<A>, E> =>
  Stream.concat(
    read(fromCommit).pipe(
      Stream.takeWhile((event) => event.commit <= upTo),
      Stream.mapArray((rows) => [
        { rows, through: Arr.lastNonEmpty(rows).commit },
      ]),
    ),
    Stream.succeed({ rows: [], through: Math.max(fromCommit, upTo) }),
  );

/** The forward reads: on each wake, read on from where the last read
 *  stopped to the upper bound captured for it. A level says "there is
 *  more", not "there is one more", so the wakes during a read collapse into
 *  one further read, and a row a read could not deliver is not read again. */
const forwardReads = <A extends SessionRow, E>(
  read: Read<A, E>,
  level: DrainLevel<E>,
  fromCommit: CommitOrdinal,
): Stream.Stream<Delivery<A>, E> =>
  Stream.suspend(() => {
    let at = fromCommit;
    const forward = Stream.unwrap(
      Effect.map(level.get, (upTo) => readThrough(read, at, upTo)),
    ).pipe(
      Stream.tap(({ through }) =>
        Effect.sync(() => {
          at = through;
        }),
      ),
    );
    return level.changes.pipe(
      Stream.buffer({ capacity: 1, strategy: 'dropping' }),
      Stream.flatMap(() => forward),
    );
  });

/** The rows of `deliveries` above `fromCommit`, each once. `drained`, when
 * given, receives the commit each share covered, rows the store no longer
 * held included, only once its rows have reached the reader (as the reader
 * pulls past them). A row the store no longer holds emits nothing, so a
 * reader that must know the tail passed an ordinal (the NDJSON detach
 * drain) waits on this coordinate, never on the events alone. */
const released = <A extends SessionRow, E>(
  deliveries: Stream.Stream<Delivery<A>, E>,
  fromCommit: CommitOrdinal,
  drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
): Stream.Stream<A, E> =>
  Stream.suspend(() => {
    let at = fromCommit;
    return Stream.flatMap(deliveries, ({ rows, through }) => {
      const fresh = Stream.fromIterable(rows.filter((row) => row.commit > at));
      at = Math.max(at, through);
      if (drained === undefined) return fresh;
      const covered = Stream.fromEffect(SubscriptionRef.set(drained, at));
      return Stream.concat(fresh, Stream.drain(covered));
    });
  });

/** A drain of its own for one reader: {@link forwardReads} on `level`,
 *  {@link released} from `fromCommit`. */
export const tailFrom = <A extends SessionRow, E>(
  read: Read<A, E>,
  level: DrainLevel<E>,
  fromCommit: CommitOrdinal,
  drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
): Stream.Stream<A, E> =>
  released(forwardReads(read, level, fromCommit), fromCommit, drained);

/**
 * The tails of `log`: one drain from its current commit for the caller's
 * scope, fanned out, so a commit costs one read however many tails wait on
 * it. A tail subscribes first, so every share past `published` reaches it,
 * then reads what it starts behind from the database itself. Unbounded, so
 * a slow tail never holds the drain back (the session's own delivery, which
 * settles transactions, is a tail too). It ends with the scope or the
 * drain's read failure, and every tail with it, one opened later at once.
 */
export const logTails = Effect.fnUntraced(function* (
  log: Context.Service.Shape<typeof Database>,
): Effect.fn.Return<
  SessionEventsShape['all'],
  DatabaseReadFailed,
  Scope.Scope
> {
  const fanout =
    yield* PubSub.unbounded<
      Take.Take<Delivery<DisplayRow>, DatabaseReadFailed>
    >();
  let published = yield* log.currentCommit;
  const level = {
    get: log.currentCommit,
    changes: SubscriptionRef.changes(log.level),
  };
  yield* forwardReads(log.readDisplay, level, published).pipe(
    Stream.runForEach((delivery) =>
      Effect.suspend(() => {
        // `published` moves first: a tail that subscribes between the two
        // steps reads the share from the database and drops its copy.
        published = delivery.through;
        return PubSub.publish(fanout, [delivery]);
      }),
    ),
    // A read failure ends every tail with it; the scope's close, cleanly.
    Effect.exit,
    Effect.flatMap((exit) => PubSub.end(fanout, exit)),
    Effect.onInterrupt(() => PubSub.end(fanout, Exit.void)),
    Effect.forkScoped,
  );
  return (fromCommit, drained) =>
    Stream.unwrap(
      Effect.map(PubSub.subscribe(fanout), (subscription) =>
        released(
          Stream.concat(
            fromCommit < published
              ? readThrough(log.readDisplay, fromCommit, published)
              : Stream.empty,
            Stream.flattenTake(Stream.fromSubscription(subscription)),
          ),
          fromCommit,
          drained,
        ),
      ),
    );
});
