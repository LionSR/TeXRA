/**
 * The session event plane over its root's SQLite database. Publication commits
 * an ordered batch before waking readers. Listing and aggregate reads are
 * finite; each tail wake captures a committed upper bound and drains that
 * prefix. Wake counters and commit ordinals are separate coordinates, so a
 * claim change can wake a reader without inventing an event.
 */
// Third-party imports
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Stream,
  SubscriptionRef,
} from 'effect';

import type { AgentEvent } from '@agent/trace';
import { SESSION_CLOSE_DEADLINE_MS } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import { writeLogLine } from '@logger/logSink';
import {
  aggregateId as qualifyAggregateId,
  isDisplaySessionEvent,
  type AggregateId,
  type CommitOrdinal,
  type SessionEvent,
  type DisplaySessionEvent,
  type SessionEventDraft,
  type RunId,
} from '@shared/schemas';
import { Database, type DatabaseReadFailed } from '@shared/session/database';
import { closesRunWindow } from '@shared/session/runRows';
import {
  SessionEvents,
  type Append,
  type OpenWork,
  type SessionCursor,
  type SessionEventsShape,
} from '@shared/session/sessionEvents';

const CHANNEL = 'sessionEvents';

/** What the publisher keeps per aggregate: its open work, so closing it at
 *  a park, an end or a host exit reads no rows. Streams close at a phase
 *  move that rests or ends the run, stages only on their own rows. An
 *  earlier process's work is not here: its streams close at that same move,
 *  and a stage it left open reads as settled once the run is durably final
 *  (`taskGroupDisplayStatus`). */
type OpenWorkByAggregate = Map<AggregateId, Map<string, OpenWork>>;

/** One unit of the publisher's work, bound to its append and built when
 *  the publisher runs it: an awaited one settles the deferred its enqueuer
 *  waits on with the job's own exit. `refuse` is what the close does with
 *  a job it will not run (past the close deadline). */
interface PublicationJob {
  readonly run: Effect.Effect<void>;
  readonly refuse: Effect.Effect<void>;
}

/** Why the close settled a publication it did not finish: never run, or
 *  cut at the deadline (it may have committed before the cut). */
const refusal = (cut: boolean): Error =>
  new Error(
    cut
      ? 'Session publication cut at the close deadline; whether it committed is unknown'
      : 'Session publication refused: the plane has closed',
  );

/** What the publisher keeps open per aggregate, from the rows it commits:
 *  `track` folds a committed batch in, `openWork` reads one aggregate's. */
function openWorkTracker(): {
  readonly track: (rows: readonly SessionEvent[]) => void;
  readonly openWork: SessionEventsShape['openWork'];
} {
  const aggregates: OpenWorkByAggregate = new Map();
  const track = (rows: readonly SessionEvent[]) => {
    for (const row of rows) {
      if (row.type === 'run.removed') {
        aggregates.delete(row.aggregateId);
        continue;
      }
      const work = aggregates.get(row.aggregateId) ?? new Map();
      const close = (kind: OpenWork['kind'], id: string) => {
        if (work.get(id)?.kind === kind) work.delete(id);
      };
      if (closesRunWindow(row)) {
        for (const [id, { kind }] of work) {
          if (kind === 'stream') work.delete(id);
        }
      } else if (row.type === 'stream.start' || row.type === 'stage.start') {
        const kind = row.type === 'stream.start' ? 'stream' : 'stage';
        work.set(row.id, { kind, id: row.id });
      } else if (row.type === 'stream.end') {
        close('stream', row.id);
      } else if (row.type === 'stage.end') {
        close('stage', row.id);
      } else {
        continue;
      }
      if (work.size > 0) aggregates.set(row.aggregateId, work);
      else aggregates.delete(row.aggregateId);
    }
  };
  return {
    track,
    openWork: (id) => [...(aggregates.get(id)?.values() ?? [])],
  };
}

/** Run `job` and complete `done` with however it ended; one the close cut
 *  short, or never ran, is refused. */
function settling<A, E>(
  job: Effect.Effect<A, E>,
  done: Deferred.Deferred<A, E>,
): PublicationJob {
  const refuse = (cut: boolean) =>
    Effect.asVoid(Deferred.die(done, refusal(cut)));
  return {
    run: job.pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Exit.hasInterrupts(exit) ? refuse(true) : Deferred.done(done, exit),
      ),
      Effect.onInterrupt(() => refuse(true)),
      Effect.asVoid,
    ),
    refuse: refuse(false),
  };
}

/** The tail drain (C7): read forward from the caller's position on each
 * wake, never past the committed upper bound captured for that read. A level says "there is more", not "there is one more", so a
 * burst of commits during a read collapses into one further read. A read
 * delivers up to the level it started at whether or not every row in
 * between materialized, so a row the read could not deliver is not read
 * again on every later wake.
 *
 * `drained`, when given, receives the commit each forward read covered,
 * rows the read could not materialize included, and only once every row of
 * that read has reached the reader (it is set after the read's stream
 * completes). A row the store no longer holds emits nothing, so a reader
 * that must know the tail passed an ordinal (the NDJSON detach drain) waits
 * on this coordinate, never on the events alone.
 */
export function tailFrom<A extends SessionEvent, E>(
  read: (fromCommit: SessionCursor) => Stream.Stream<A, E>,
  level: {
    readonly get: Effect.Effect<CommitOrdinal, E>;
    readonly changes: Stream.Stream<CommitOrdinal>;
  },
  fromCommit: SessionCursor,
  drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
): Stream.Stream<A, E> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const at = yield* Ref.make(fromCommit);
      const forward = Stream.unwrap(
        Effect.gen(function* () {
          const cursor = yield* Ref.get(at);
          const upTo = yield* level.get;
          return Stream.concat(
            read(cursor).pipe(
              Stream.takeWhile((event) => event.commit <= upTo),
              Stream.tap((event) => Ref.set(at, event.commit)),
            ),
            Stream.fromEffect(
              Effect.gen(function* () {
                const covered = yield* Ref.updateAndGet(at, (delivered) =>
                  Math.max(delivered, upTo),
                );
                if (drained) yield* SubscriptionRef.set(drained, covered);
              }),
            ).pipe(Stream.drain),
          );
        }),
      );
      return level.changes.pipe(
        Stream.flatMap(() => forward, { concurrency: 1 }),
      );
    }),
  );
}

/**
 * The publisher and public event readers over the root's database. Each
 * reader supplies its own starting position.
 *
 * Publication is one inbox and one consumer fiber (C6): every job, awaited
 * or detached, runs in the order it was enqueued, and the table's commit
 * order is that order. A job stays interruptible; only its atomic write
 * (the append and what the publisher tracks of it) is masked. Closing the
 * plane ({@link SessionEventsShape.drain}) ends the inbox and drains it
 * inside one deadline; at the deadline the running job is cut and every
 * queued one refused. A job enqueued after that is refused too: a detached
 * one is logged and dropped, an awaited one is the caller's defect.
 */
export const sessionEventsLayer = Layer.effect(
  SessionEvents,
  Effect.gen(function* () {
    const log = yield* Database;
    const { track, openWork } = openWorkTracker();
    // Both of `appendAll`'s refusals pass through typed (D6 b): a lost
    // single-owner race is the caller's fact to act on, not a defect.
    const append: Append = (events) =>
      log.appendAll(events).pipe(
        Effect.tap((rows) => Effect.sync(() => track(rows))),
        Effect.uninterruptible,
      );
    const inbox = yield* Queue.unbounded<PublicationJob, Cause.Done>();
    // One job per take, never a batch: a job the close refuses is one the
    // consumer never took. It ends when the ended inbox runs dry.
    const consumer = yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(Queue.take(inbox), (job) => job.run),
        { disableYield: true },
      ).pipe(Effect.catchIf(Cause.isDone, () => Effect.void)),
    );
    // Cached: the session's close and the publisher's scope both run it,
    // and only the first waits.
    const drain: SessionEventsShape['drain'] = yield* Effect.cached(
      Effect.gen(function* () {
        yield* Queue.end(inbox);
        // Interruptible inside the close's uninterruptible region, so the
        // deadline can cut the wait.
        const ended = yield* Fiber.await(consumer).pipe(
          Effect.interruptible,
          Effect.timeoutOption(SESSION_CLOSE_DEADLINE_MS),
        );
        // At the deadline the running job is cut; the interrupt waits only for
        // its masked atomic write.
        if (Option.isNone(ended)) yield* Fiber.interrupt(consumer);
        else if (
          Exit.isFailure(ended.value) &&
          !Cause.hasInterruptsOnly(ended.value.cause)
        ) {
          yield* Effect.logWarning(
            'Session publisher ended abnormally on close',
          ).pipe(
            Effect.annotateLogs({ data: Cause.squash(ended.value.cause) }),
            withLogChannel(CHANNEL),
          );
        }
        // Whatever the consumer never ran (the deadline cut it, or it died)
        // is refused, never left for its awaiter to wait on.
        const refused = yield* Queue.clear(inbox).pipe(Effect.orDie);
        yield* Effect.forEach(refused, (job) => job.refuse, { discard: true });
        if (refused.length > 0)
          yield* Effect.logWarning(
            `Session publisher closed; ${refused.length} queued publications refused`,
          ).pipe(withLogChannel(CHANNEL));
      }),
    );
    yield* Effect.addFinalizer(() => drain);
    const enqueue = (job: PublicationJob): boolean =>
      Queue.offerUnsafe(inbox, job);
    const transact = <A, E>(
      job: (append: Append) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E> =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<A, E>();
        const admitted = enqueue(
          settling(
            Effect.suspend(() => job(append)),
            done,
          ),
        );
        if (!admitted) {
          return yield* Effect.die(
            new Error('Session publication after the plane closed'),
          );
        }
        return yield* Deferred.await(done);
      });
    const removeRun: SessionEventsShape['removeRun'] = Effect.fn(
      'SessionEvents.removeRun',
    )(function* (id, mode, expectedStartCommit) {
      const removal = yield* log.prepareRunRemoval(
        id,
        mode,
        expectedStartCommit,
      );
      return yield* transact(() =>
        removal.pipe(
          Effect.tap((rows) => Effect.sync(() => track(rows))),
          Effect.uninterruptible,
        ),
      );
    });
    const detach: SessionEventsShape['detach'] = (job) => {
      const admitted = enqueue({
        run: Effect.suspend(() => job(append)).pipe(
          Effect.catchCause((cause) =>
            Effect.logError('Session publication failed').pipe(
              Effect.annotateLogs({ data: Cause.squash(cause) }),
              withLogChannel(CHANNEL),
            ),
          ),
        ),
        refuse: Effect.void,
      });
      // Direct sink write: `detach` is the synchronous door for producers
      // with no fiber, and the refusing plane's publisher fiber has ended.
      if (!admitted)
        writeLogLine(
          'WARN',
          CHANNEL,
          'Session publication dropped: the plane has closed',
        );
    };
    // THE tail (C7): the drain woken by the log's level.
    const all = (
      fromCommit: SessionCursor,
      drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
    ): Stream.Stream<DisplaySessionEvent, DatabaseReadFailed> =>
      tailFrom(
        log.readDisplay,
        {
          get: log.currentCommit,
          changes: SubscriptionRef.changes(log.level),
        },
        fromCommit,
        drained,
      );
    return {
      transact,
      detach,
      removeRun,
      drain,
      openWork,
      listing: () =>
        Stream.fromIterableEffect(log.readListing()).pipe(
          Stream.filter(isDisplaySessionEvent),
        ),
      all,
    };
  }),
);

/** A source trace fact on its run aggregate. Streaming chunks remain transient. */
export function runEventDraft(
  runId: RunId,
  event: AgentEvent,
): SessionEventDraft | null {
  if (event.type === 'stream.chunk') return null;
  const aggregateId = qualifyAggregateId('run', runId);
  if (event.type === 'run.config') {
    // The aggregate is the run: the row carries no second copy of its id.
    const { runId: _runId, ...body } = event;
    return { ...body, aggregateId };
  }
  return { ...event, aggregateId };
}
