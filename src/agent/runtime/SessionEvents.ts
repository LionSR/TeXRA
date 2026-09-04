/**
 * `SessionEvents`: the session's event plane (PRD one-fold-three-renderers,
 * 7.1; contract C6 and C7). One ordered log per session, one publisher under
 * one permit, three reads and nothing else: `listing()` (the cold listing
 * hydrate, completes), `all(fromCommit)` (every row above a commit ordinal in
 * commit order, then the tail), and `aggregate(id, fromSeq)` (one aggregate's
 * rows from a seq, completes). The wake is a level, never an edge: the log's
 * last commit ordinal in a `SubscriptionRef`, which replays its current value
 * on subscribe, so no commit can land between a read and a subscribe.
 *
 * Before the persistence cutover the log is in memory (`SessionEventLog.memoryLayer`),
 * the substrate stand-in for the cutover's `DurableWrite`: the cutover swaps
 * that layer for the SQLite one and adds the `data_version` poll to the
 * publisher here; the shape of this service is the contract and does not move.
 *
 * Every publisher hands this a `SessionEventDraft`, the body plus its
 * aggregate; `seq`, `commit`, `ownerId` (the process identity, C5), and `at`
 * are stamped here and nowhere else. The run trace's durable arms translate
 * by naming fields (`runEventDraft`); the trace events with no durable arm
 * (log lines, tool patches, streaming deltas) never enter the plane. The
 * runtime's ordering-sensitive bookkeeping (the status machine's
 * consumers, the snapshot store, the transcript recorders' status ports) is
 * called by `SessionHandle.publish` before the log moves, so it observes
 * every fact in publish order; renderers read `all(cursor)`.
 */
import {
  Context,
  Effect,
  Layer,
  Ref,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';

import type { AgentEvent, StatusEvent } from '@agent/trace';
import type {
  AggregateId,
  CommitOrdinal,
  OwnerId,
  SessionEvent,
  SessionEventDraft,
  StreamTabId,
} from '@shared/schemas';

/** A publisher's position in the commit space: what `all` reads from. */
export type SessionCursor = CommitOrdinal;

/**
 * The identity of this process, `${pid}:${processStart}` (contract C5): the
 * `ownerId` stamped on every event the process appends and the `self` entry
 * of its local runtime snapshot. Resolved once at each process entry, where
 * the start identity can be awaited, and provided to the process layer.
 */
export class ProcessIdentity extends Context.Service<
  ProcessIdentity,
  { readonly ownerId: OwnerId }
>()('@texra/session/ProcessIdentity') {
  static layer(ownerId: OwnerId): Layer.Layer<ProcessIdentity> {
    return Layer.succeed(ProcessIdentity)({ ownerId });
  }
}

/** Every non-transcript row is a listing fact (C8); the approval pair folds
 *  to one outstanding set keyed by request id. */
function listingRows(rows: readonly SessionEvent[]): SessionEvent[] {
  const latest = new Map<string, SessionEvent>();
  const outstanding = new Map<string, SessionEvent>();
  for (const row of rows) {
    switch (row.type) {
      case 'transcript.entry':
        continue;
      case 'approval.requested':
        outstanding.set(`${row.aggregateId}/${row.requestId}`, row);
        continue;
      case 'approval.resolved':
        outstanding.delete(`${row.aggregateId}/${row.requestId}`);
        continue;
      default:
        latest.set(`${row.aggregateId}/${row.type}`, row);
    }
  }
  return [...latest.values(), ...outstanding.values()].sort(
    (a, b) => a.commit - b.commit,
  );
}

/**
 * The substrate: the append-only log the publisher writes and the three
 * reads query. `level` is the last commit ordinal appended, the one number
 * space a cursor lives in (C1). `appendAll` is the write path of contract
 * C6: one `Semaphore.make(1)` per log, seq assignment and the append under
 * its permit, uninterruptible, and the level set before the permit is
 * released, so seq order and commit order cannot diverge and a commit that
 * wakes nobody cannot exist. The memory layer is the pre-cutover store;
 * nothing here reaches disk, and the cutover replaces it with the SQLite
 * write path under the same shape.
 */
export class SessionEventLog extends Context.Service<
  SessionEventLog,
  {
    readonly level: SubscriptionRef.SubscriptionRef<CommitOrdinal>;
    /** Assign each draft its aggregate seq and commit ordinal, append it
     *  under the log's permit, and move the level; returns the last ordinal.
     *  `stamp` is the writer: the process identity for a live publish, the
     *  historical owner (or null) for the pre-cutover importer's rows. */
    readonly appendAll: (
      drafts: readonly SessionEventDraft[],
      stamp: { readonly ownerId: OwnerId | null; readonly at: number },
    ) => Effect.Effect<CommitOrdinal>;
    readonly readAll: (
      fromCommit: SessionCursor,
    ) => Stream.Stream<SessionEvent>;
    readonly readListing: () => Stream.Stream<SessionEvent>;
    readonly readAggregate: (
      aggregateId: AggregateId,
      fromSeq: number,
    ) => Stream.Stream<SessionEvent>;
  }
>()('@texra/session/SessionEventLog') {
  static readonly memoryLayer = Layer.effect(
    SessionEventLog,
    Effect.gen(function* () {
      const level = yield* SubscriptionRef.make<CommitOrdinal>(0);
      const gate = yield* Semaphore.make(1);
      const rows: SessionEvent[] = [];
      const seqs = new Map<AggregateId, number>();
      const snapshot = (
        select: (rows: readonly SessionEvent[]) => readonly SessionEvent[],
      ): Stream.Stream<SessionEvent> =>
        Stream.unwrap(Effect.sync(() => Stream.fromIterable(select(rows))));
      return {
        level,
        appendAll: (drafts, stamp) =>
          gate.withPermit(
            Effect.uninterruptible(
              Effect.gen(function* () {
                for (const draft of drafts) {
                  const seq = (seqs.get(draft.aggregateId) ?? 0) + 1;
                  seqs.set(draft.aggregateId, seq);
                  rows.push({
                    ...draft,
                    seq,
                    commit: rows.length + 1,
                    ownerId: stamp.ownerId,
                    at: stamp.at,
                  } as SessionEvent);
                }
                const at = rows.length;
                yield* SubscriptionRef.set(level, at);
                return at;
              }),
            ),
          ),
        // `commit` is the row's 1-based position, so the rows above a commit
        // are the slice past it.
        readAll: (fromCommit) => snapshot((all) => all.slice(fromCommit)),
        readListing: () => snapshot(listingRows),
        readAggregate: (aggregateId, fromSeq) =>
          snapshot((all) =>
            all.filter(
              (row) => row.aggregateId === aggregateId && row.seq > fromSeq,
            ),
          ),
      };
    }),
  );
}

export class SessionEvents extends Context.Service<
  SessionEvents,
  {
    /** An ordered batch, committed in one transaction (PRD 6, item 8). */
    readonly publish: (
      events: readonly SessionEventDraft[],
    ) => Effect.Effect<void>;
    /** The cold listing hydrate (C8): the latest row per aggregate and type
     *  for the listing fact types plus the outstanding approvals, in commit
     *  order; never a transcript row; completes. */
    readonly listing: () => Stream.Stream<SessionEvent>;
    /** Every event with commit above `fromCommit`, in commit order across
     *  aggregates, then the tail. Transcript rows of unsubscribed aggregates
     *  included: the live tail and the frozen NDJSON projection read it. */
    readonly all: (fromCommit: SessionCursor) => Stream.Stream<SessionEvent>;
    /** One aggregate's rows from `fromSeq`, in seq order; completes. A
     *  history read, never a tail. */
    readonly aggregate: (
      aggregateId: AggregateId,
      fromSeq: number,
    ) => Stream.Stream<SessionEvent>;
    /** Where this layer's tail starts, fixed at layer build. A value, not a
     *  query: the fold never reads a durable ordinal. */
    readonly anchor: SessionCursor;
  }
>()('@texra/session/SessionEvents') {
  static readonly layer = Layer.effect(
    SessionEvents,
    Effect.gen(function* () {
      const log = yield* SessionEventLog;
      const identity = yield* ProcessIdentity;
      // The writer of every live row is this process (C5); the log's permit
      // serializes the append with the level move.
      const publish = Effect.fn('SessionEvents.publish')(function* (
        events: readonly SessionEventDraft[],
      ) {
        yield* log.appendAll(events, {
          ownerId: identity.ownerId,
          at: Date.now(),
        });
      });
      // The tail anchor: read once, here, before any cold read this layer
      // serves.
      const anchor = yield* SubscriptionRef.get(log.level);
      // THE tail (C7), and the only drain: the log read forward from the
      // caller's position, once per level above what this drain delivered.
      // A level says "there is more", not "there is one more", so a burst of
      // commits during a read collapses into one further read.
      const all = (fromCommit: SessionCursor): Stream.Stream<SessionEvent> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const at = yield* Ref.make(fromCommit);
            const forward = Stream.unwrap(
              Ref.get(at).pipe(
                Effect.map((cursor) =>
                  log
                    .readAll(cursor)
                    .pipe(Stream.tap((event) => Ref.set(at, event.commit))),
                ),
              ),
            );
            return SubscriptionRef.changes(log.level).pipe(
              Stream.filterEffect((level) =>
                Ref.get(at).pipe(Effect.map((delivered) => level > delivered)),
              ),
              Stream.flatMap(() => forward, { concurrency: 1 }),
            );
          }),
        );
      return {
        publish,
        listing: () => log.readListing(),
        all,
        aggregate: (aggregateId, fromSeq) =>
          log.readAggregate(aggregateId, fromSeq),
        anchor,
      };
    }),
  );

  /** The pre-cutover graph: the publisher over the in-memory log. */
  static readonly memoryLayer = SessionEvents.layer.pipe(
    Layer.provideMerge(SessionEventLog.memoryLayer),
  );
}

export type SessionEventsShape = Context.Service.Shape<typeof SessionEvents>;

/**
 * The durable arm of one run-trace event on its stream's aggregate, or null
 * for a trace event the plane does not carry (log lines, stage ends, tool
 * patches, workflow call progress, streaming deltas, the finalized response,
 * domain rows, and the registry's child roster, which is live-only and
 * reaches its readers through `ExecutionRegistry.onChildActivity`): the
 * transcript recorder turns those into transcript rows,
 * which reach the plane as `transcript.entry` from the transcript store's
 * change feed. The arms mirror the trace field for field (`sessionEvent.ts`),
 * so this names fields and never re-encodes.
 */
export function runEventDraft(
  streamId: StreamTabId,
  event: AgentEvent,
): SessionEventDraft | null {
  switch (event.type) {
    case 'run.start': {
      const { type, streamId: _streamId, stageId: _stageId, ...body } = event;
      return { ...body, type, aggregateId: streamId };
    }
    case 'run.activate':
      return {
        type: event.type,
        aggregateId: streamId,
        category: event.category,
        isRemote: event.isRemote,
        background: event.background,
      };
    case 'run.config':
      return {
        type: event.type,
        aggregateId: streamId,
        executionId: event.executionId,
        config: event.config,
      };
    case 'result':
      return {
        type: event.type,
        aggregateId: streamId,
        outcome: event.outcome,
        executionId: event.executionId,
        category: event.category,
        isSubagent: event.isSubagent,
        error: event.error,
      };
    case 'stage.start':
      return {
        type: event.type,
        aggregateId: streamId,
        id: event.id,
        label: event.label,
        parentId: event.parentId,
        kind: event.kind,
        index: event.index,
        total: event.total,
      };
    case 'conversation.progress':
      return {
        type: event.type,
        aggregateId: streamId,
        progress: event.progress,
      };
    case 'usage':
      return {
        type: event.type,
        aggregateId: streamId,
        storageKey: event.payload.storageKey,
        usage: event.payload.usage,
      };
    case 'context.state':
      return {
        type: event.type,
        aggregateId: streamId,
        inputTokens: event.inputTokens,
        contextWindow: event.contextWindow,
      };
    case 'updateTodos':
      return { type: event.type, aggregateId: streamId, todos: event.todos };
    case 'updatePlan':
      return { type: event.type, aggregateId: streamId, plan: event.plan };
    case 'addOutputFiles':
    case 'updateMissingOutputs':
    case 'updateCompileFailures':
      return {
        type: event.type,
        aggregateId: streamId,
        filesByRound: event.filesByRound,
      } as SessionEventDraft;
    case 'goalPaused':
      return { type: event.type, aggregateId: streamId };
    case 'approval.requested':
      return {
        type: event.type,
        aggregateId: streamId,
        requestId: event.requestId,
        payload: event.payload,
      };
    case 'approval.resolved':
      return {
        type: event.type,
        aggregateId: streamId,
        requestId: event.requestId,
      };
    case 'approval.policy':
      return {
        type: event.type,
        aggregateId: streamId,
        snapshot: event.snapshot,
      };
    case 'child.activity':
    case 'log':
    case 'stage.end':
    case 'tool.start':
    case 'tool.end':
    case 'workflow.plan':
    case 'workflow.call':
    case 'skills.snapshot':
    case 'stream.start':
    case 'stream.chunk':
    case 'stream.end':
    case 'response.finalized':
    case 'domain':
      return null;
  }
}

/** The `status` arm of one canonical status fact, on the stream it names. */
export function statusDraft(event: StatusEvent): SessionEventDraft {
  return {
    type: 'status',
    aggregateId: event.streamId,
    phase: event.phase,
    previousPhase: event.previousPhase,
    cause: event.cause,
    substate: event.substate,
    runStartedAt: event.runStartedAt,
  };
}
