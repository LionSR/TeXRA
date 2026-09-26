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
  Queue,
  Ref,
  Stream,
  SubscriptionRef,
} from 'effect';

import type { AgentEvent } from '@agent/trace';
import { withLogChannel } from '@logger/effectLog';
import { writeLogLine } from '@logger/logSink';
import {
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  isDisplaySessionEvent,
  isTerminalWorkflowCallProgress,
  type AggregateId,
  type CommitOrdinal,
  type SessionEvent,
  type DisplaySessionEvent,
  type SessionEventDraft,
  type RunId,
} from '@shared/schemas';
import {
  Database,
  type DatabaseNotOwner,
  type DatabaseReadFailed,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import {
  applyRunRow,
  closesRunWindow,
  foldRunRows,
  freshRunRows,
  isFollowUpRow,
  type RunRows,
} from '@shared/session/runRows';
import {
  SessionEvents,
  type Append,
  type OpenWork,
  type SessionCursor,
  type SessionEventsShape,
} from '@shared/session/sessionEvents';

const CHANNEL = 'sessionEvents';

/** One unit of the publisher's work: a job over the log's append that
 *  settles the deferred its enqueuer waits on with the job's own exit. */
type PublicationJob = (append: Append) => Effect.Effect<void>;

/** What a detached job may refuse with: the log append's own failures. */
type DetachedJobFailure =
  DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed;

/** Run `job` and complete `done` with however it ended. */
function settling<A, E>(
  job: (append: Append) => Effect.Effect<A, E>,
  done: Deferred.Deferred<A, E>,
): PublicationJob {
  return (append) =>
    job(append).pipe(
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(done, exit)),
      Effect.asVoid,
    );
}

/** The log's append, reporting the last commit each call produced. */
function trackingAppend(
  append: Append,
  onCommit: (commit: CommitOrdinal) => void,
): Append {
  return (events) =>
    append(events).pipe(
      Effect.tap((rows) =>
        Effect.sync(() => {
          const last = rows.at(-1);
          if (last !== undefined) onCommit(last.commit);
        }),
      ),
    );
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
 * order is that order. The fiber runs each job uninterruptibly, so closing
 * the plane ends the inbox and drains what it holds before the fiber ends;
 * a job enqueued after that is refused: a detached one is logged and
 * dropped, an awaited one is the caller's defect.
 */
export const sessionEventsLayer = Layer.effect(
  SessionEvents,
  Effect.gen(function* () {
    const log = yield* Database;
    // What each aggregate has open, kept as this publisher commits it, so
    // closing it at a park, an end or a host exit reads no rows. The fold
    // closes every stream at a phase move that rests or ends the run, and so
    // does this; stages and workflow calls close only on their own rows,
    // there and here. Work some earlier process opened is not here: its
    // streams close at that same phase move, and a stage or call it left
    // open reads as its run's settled outcome once the run is durably final
    // (`taskGroupDisplayStatus`, `workflowRunModel`'s interrupted card).
    const open = new Map<AggregateId, Map<string, OpenWork>>();
    // Each run's follow-ups, kept the same way by the one reducer
    // (`applyRunRow`). Rows an earlier owner committed enter where a claim
    // moves here (`hydrateFollowUps`); while this process holds the claim,
    // no other process commits to the run, so what it tracks stays whole.
    const followUps = new Map<AggregateId, RunRows>();
    const hydrated = new Set<AggregateId>();
    const track = (rows: readonly SessionEvent[]) => {
      for (const row of rows) {
        if (row.type === 'run.removed') {
          open.delete(row.aggregateId);
          followUps.delete(row.aggregateId);
          hydrated.delete(row.aggregateId);
          continue;
        }
        if (isFollowUpRow(row)) {
          const slice = followUps.get(row.aggregateId) ?? freshRunRows();
          const verdict = applyRunRow(slice, row);
          if (verdict.kind === 'applied')
            followUps.set(row.aggregateId, { ...slice, ...verdict.rows });
          continue;
        }
        const work = open.get(row.aggregateId) ?? new Map<string, OpenWork>();
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
        } else if (row.type === 'workflow.call') {
          if (isTerminalWorkflowCallProgress(row.call)) {
            close('call', row.logId);
          } else {
            const { logId: id, stageId, call } = row;
            work.set(id, { kind: 'call', id, stageId, call });
          }
        } else {
          continue;
        }
        if (work.size === 0) open.delete(row.aggregateId);
        else open.set(row.aggregateId, work);
      }
    };
    // Both of `appendAll`'s refusals pass through typed (D6 b): a lost
    // single-owner race is the caller's fact to act on, not a defect.
    const append: Append = (events) =>
      log
        .appendAll(events)
        .pipe(Effect.tap((rows) => Effect.sync(() => track(rows))));
    const inbox = yield* Queue.unbounded<PublicationJob, Cause.Done>();
    const consumer = yield* Effect.forkScoped(
      Stream.fromQueue(inbox).pipe(
        Stream.runForEach((job) => Effect.uninterruptible(job(append))),
      ),
    );
    // Registered after the fork, so it runs before the fork's own finalizer:
    // the inbox ends, the fiber drains what is queued, and only then goes.
    yield* Effect.addFinalizer(() =>
      Queue.end(inbox).pipe(
        Effect.andThen(Fiber.join(consumer)),
        // Every job's refusal is kept on its own Exit, so the consumer ends
        // abnormally only on a defect; closing still proceeds, and says so.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning(
                'Session publisher ended abnormally on close',
              ).pipe(
                Effect.annotateLogs({ data: Cause.squash(cause) }),
                withLogChannel(CHANNEL),
              ),
        ),
      ),
    );
    const enqueue = (job: PublicationJob): boolean =>
      Queue.offerUnsafe(inbox, job);
    const exclusive = <A, E>(
      job: (append: Append) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E> =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<A, E>();
        const admitted = enqueue(settling(job, done));
        if (!admitted) {
          return yield* Effect.die(
            new Error('Session publication after the plane closed'),
          );
        }
        return yield* Deferred.await(done);
      });
    const publish = Effect.fn('SessionEvents.publish')(function* (
      events: readonly SessionEventDraft[],
    ) {
      return yield* exclusive((append) => append(events));
    });
    /** Detached jobs still running or queued: what `settle` waits for. Each
     *  completes with the last commit its job appended, so a settler waits
     *  for exactly its cohort. A job's own refusal is logged where it
     *  happened and belongs to whoever enqueued it (`SessionHandle` keeps it
     *  for the drain that decides its run's terminal row), so this cohort
     *  reports position and never failure. */
    const pending = new Set<
      Deferred.Deferred<CommitOrdinal | null, DetachedJobFailure>
    >();
    const detach: SessionEventsShape['detach'] = (job) => {
      const done = Deferred.makeUnsafe<
        CommitOrdinal | null,
        DetachedJobFailure
      >();
      pending.add(done);
      let committed: CommitOrdinal | null = null;
      const admitted = enqueue(
        settling(
          (append) =>
            job(
              trackingAppend(append, (commit) => {
                committed = commit;
              }),
            ).pipe(
              Effect.map(() => committed),
              Effect.tapCause((cause) =>
                Effect.logError('Session publication failed').pipe(
                  Effect.annotateLogs({ data: cause }),
                  withLogChannel(CHANNEL),
                ),
              ),
              Effect.onExit(() => Effect.sync(() => pending.delete(done))),
            ),
          done,
        ),
      );
      if (!admitted) {
        pending.delete(done);
        // Direct sink write: `detach` is the synchronous door for producers
        // with no fiber, and the refusing plane's publisher fiber has ended.
        writeLogLine(
          'WARN',
          CHANNEL,
          'Session publication dropped: the plane has closed',
        );
      }
    };
    const settle: Effect.Effect<CommitOrdinal | null> = Effect.suspend(() =>
      Effect.forEach([...pending], (done) => Effect.exit(Deferred.await(done))),
    ).pipe(
      Effect.map((exits) => {
        const commits = exits.flatMap((exit) =>
          Exit.isSuccess(exit) && exit.value !== null ? [exit.value] : [],
        );
        return commits.length === 0
          ? null
          : commits.reduce((a, b) => Math.max(a, b));
      }),
    );
    // THE tail (C7): the drain woken by the log's level.
    const all = (
      fromCommit: SessionCursor,
      drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
    ): Stream.Stream<DisplaySessionEvent, DatabaseReadFailed> =>
      tailFrom(
        (from) => Stream.fromIterableEffect(log.readDisplay(from)),
        {
          get: log.currentCommit,
          changes: SubscriptionRef.changes(log.level),
        },
        fromCommit,
        drained,
      );
    return {
      publish,
      exclusive,
      detach,
      settle,
      openWork: (aggregateId) => [...(open.get(aggregateId)?.values() ?? [])],
      pendingFollowUps: (aggregateId) =>
        followUps.get(aggregateId)?.followUps ?? [],
      hydrateFollowUps: (aggregateId, claimMoved, rows) =>
        Effect.gen(function* () {
          if (aggregateTarget(aggregateId).kind !== 'run') return;
          if (!claimMoved && hydrated.has(aggregateId)) return;
          const read = foldRunRows(
            (rows ?? (yield* log.readAggregate(aggregateId, 1))).filter(
              isFollowUpRow,
            ),
          );
          const live = followUps.get(aggregateId) ?? freshRunRows();
          const livePending = new Set(live.followUps.map((f) => f.followUpId));
          // A row the read holds keeps its place unless this publisher
          // consumed it since; one it tracked that the read does not name
          // committed after the read, and follows it.
          followUps.set(aggregateId, {
            ...read,
            followUps: [
              ...read.followUps.filter(
                ({ followUpId: id }) =>
                  !live.followUpIds.has(id) || livePending.has(id),
              ),
              ...live.followUps.filter(
                ({ followUpId }) => !read.followUpIds.has(followUpId),
              ),
            ],
            followUpIds: new Set([...read.followUpIds, ...live.followUpIds]),
          });
          hydrated.add(aggregateId);
        }),
      listing: () =>
        Stream.fromIterableEffect(log.readListing()).pipe(
          Stream.filter(isDisplaySessionEvent),
        ),
      all,
      aggregate: (aggregateId, fromSeq) =>
        Stream.fromIterableEffect(log.readAggregate(aggregateId, fromSeq)).pipe(
          Stream.filter(isDisplaySessionEvent),
        ),
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
