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
 * are stamped by the log and nowhere else. The run trace's durable arms
 * translate by naming fields (`runEventDraft`); the trace events with no
 * durable arm (log lines, tool patches, streaming deltas) never enter the
 * plane. The runtime's ordering-sensitive bookkeeping (the status machine's
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
import { createLog } from '@logger/logUtils';
import {
  runWithWorkspaceRoots,
  type WorkspaceRoots,
} from '@platform/workspaceRoots';
import type {
  AggregateId,
  CommitOrdinal,
  OwnerId,
  SessionEvent,
  SessionEventDraft,
  StreamTabId,
} from '@shared/schemas';
import type { StreamLogStore } from '@transcript/StreamLogStore';

const logger = createLog('sessionEvents');

/** A publisher's position in the commit space: what `all` reads from. */
export type SessionCursor = CommitOrdinal;

/** The start-identity half of an owner id when the host could not read its
 *  own: a process whose start no probe can compare is unprovable, never
 *  dead (`proveOwnerLiveness`). */
const UNREADABLE_PROCESS_START = 'unreadable';

/** This process's owner id (contract C5), from the host's start identity. */
export function processOwnerId(processStart: string | undefined): OwnerId {
  return `${process.pid}:${processStart ?? UNREADABLE_PROCESS_START}`;
}

/** The start identity an owner id carries, null when its host could not
 *  read one (the liveness probe then reports the owner unprovable). */
export function ownerProcessStart(ownerId: OwnerId): string | null {
  const start = ownerId.slice(ownerId.indexOf(':') + 1);
  return start === UNREADABLE_PROCESS_START ? null : start;
}

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

/**
 * A transcript row's place in the log. The row body is the transcript
 * store's, read when the log is read, so the log keeps no copy of any
 * transcript and the store's bounded residency bounds both; a patch of a
 * row is a new place for the same entry id and materializes as the entry's
 * current value.
 */
interface TranscriptRef {
  readonly type: 'transcript.ref';
  readonly aggregateId: StreamTabId;
  readonly entryId: string;
  readonly seq: number;
  readonly commit: CommitOrdinal;
  readonly at: number;
}

type LogRow = SessionEvent | TranscriptRef;

/** Every non-transcript row is a listing fact (C8); the approval pair folds
 *  to one outstanding set keyed by request id. */
function listingRows(rows: readonly LogRow[]): SessionEvent[] {
  const latest = new Map<string, SessionEvent>();
  const outstanding = new Map<string, SessionEvent>();
  for (const row of rows) {
    switch (row.type) {
      case 'transcript.ref':
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
 * wakes nobody cannot exist. The writer of every row is this process (C5),
 * stamped here from `ProcessIdentity`; no caller passes it.
 *
 * The memory layer is the pre-cutover store, and its transcript tier is the
 * transcript store's: `aggregate(id, fromSeq)` reads that store's rows for
 * the stream (the store's row `seqNo` is the aggregate seq), and the tail
 * holds a transcript row's place only, materialized from the store when
 * read. Nothing here reaches disk, and the cutover replaces this layer with
 * the SQLite write path under the same shape.
 */
export class SessionEventLog extends Context.Service<
  SessionEventLog,
  {
    readonly level: SubscriptionRef.SubscriptionRef<CommitOrdinal>;
    /** Assign each draft its aggregate seq and commit ordinal, append it
     *  under the log's permit, and move the level; returns the last ordinal.
     *  `at` is the publish clock (C1, informational) unless the caller
     *  names the moment its rows describe, as the pre-cutover history
     *  import does. */
    readonly appendAll: (
      drafts: readonly SessionEventDraft[],
      at?: number,
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
  static memoryLayer(
    transcripts: StreamLogStore,
    roots: WorkspaceRoots,
  ): Layer.Layer<SessionEventLog, never, ProcessIdentity> {
    return Layer.effect(
      SessionEventLog,
      Effect.gen(function* () {
        const identity = yield* ProcessIdentity;
        const level = yield* SubscriptionRef.make<CommitOrdinal>(0);
        const gate = yield* Semaphore.make(1);
        const rows: LogRow[] = [];
        const seqs = new Map<AggregateId, number>();
        // The transcript tier's seq per stream: always above every row the
        // store holds for it, so a history read (the store's own `seqNo`)
        // and the tail (this counter) order under one `view.folded`
        // threshold, and a row that reaches a reader by both is applied
        // once more by entry id, never as a second row.
        const transcriptSeqs = new Map<StreamTabId, number>();
        const materialize = (row: LogRow): SessionEvent | null => {
          if (row.type !== 'transcript.ref') return row;
          const entry = transcripts.get(row.aggregateId)?.getById(row.entryId);
          if (entry) {
            return {
              type: 'transcript.entry',
              aggregateId: row.aggregateId,
              seq: row.seq,
              commit: row.commit,
              ownerId: identity.ownerId,
              at: row.at,
              entry,
            };
          }
          // A deleted stream's rows are behind its tombstone on the log; a
          // stream that left residency before a reader this far behind read
          // its rows has lost them to that reader.
          if (transcripts.has(row.aggregateId)) {
            logger.warn(
              `Transcript row ${row.entryId} of stream ${row.aggregateId} left residency before commit ${row.commit} was read; the reader does not receive it`,
            );
          }
          return null;
        };
        return {
          level,
          appendAll: (drafts, at = Date.now()) =>
            gate.withPermit(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  for (const draft of drafts) {
                    const commit = rows.length + 1;
                    if (draft.type === 'transcript.entry') {
                      const streamId = draft.aggregateId as StreamTabId;
                      const seq =
                        Math.max(
                          transcriptSeqs.get(streamId) ?? 0,
                          transcripts.get(streamId)?.head ?? 0,
                        ) + 1;
                      transcriptSeqs.set(streamId, seq);
                      rows.push({
                        type: 'transcript.ref',
                        aggregateId: streamId,
                        entryId: draft.entry.id,
                        seq,
                        commit,
                        at,
                      });
                      continue;
                    }
                    const seq = (seqs.get(draft.aggregateId) ?? 0) + 1;
                    seqs.set(draft.aggregateId, seq);
                    rows.push({
                      ...draft,
                      seq,
                      commit,
                      ownerId: identity.ownerId,
                      at,
                    } as SessionEvent);
                  }
                  const last = rows.length;
                  yield* SubscriptionRef.set(level, last);
                  return last;
                }),
              ),
            ),
          // `commit` is the row's 1-based position, so the rows above a
          // commit are the slice past it.
          readAll: (fromCommit) =>
            Stream.unwrap(
              Effect.sync(() =>
                Stream.fromIterable(
                  rows.slice(fromCommit).flatMap((row) => {
                    const event = materialize(row);
                    return event === null ? [] : [event];
                  }),
                ),
              ),
            ),
          readListing: () =>
            Stream.unwrap(
              Effect.sync(() => Stream.fromIterable(listingRows(rows))),
            ),
          // The transcript tier is the store's: its rows for the stream
          // above `fromSeq`, read once without adding residency, stamped
          // with the level they were read at. The stream's listing facts
          // reach a reader through `listing()` and the tail.
          readAggregate: (aggregateId, fromSeq) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const commit = yield* SubscriptionRef.get(level);
                const entries = yield* Effect.promise(async () =>
                  runWithWorkspaceRoots(roots, () =>
                    transcripts.readEntries(aggregateId as StreamTabId),
                  ),
                );
                return Stream.fromIterable(
                  entries
                    .filter((entry) => entry.seqNo > fromSeq)
                    .map((entry): SessionEvent => ({
                      type: 'transcript.entry',
                      aggregateId,
                      seq: entry.seqNo,
                      commit,
                      ownerId: identity.ownerId,
                      at: entry.timestamp,
                      entry,
                    })),
                );
              }),
            ),
        };
      }),
    );
  }
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
  /** The publisher and the three reads over a `SessionEventLog`; whatever
   *  the log holds when this builds is history under the anchor. */
  static readonly layer = Layer.effect(
    SessionEvents,
    Effect.gen(function* () {
      const log = yield* SessionEventLog;
      const publish = Effect.fn('SessionEvents.publish')(function* (
        events: readonly SessionEventDraft[],
      ) {
        yield* log.appendAll(events);
      });
      // The tail anchor: read once, here, before any cold read this layer
      // serves.
      const anchor = yield* SubscriptionRef.get(log.level);
      // THE tail (C7), and the only drain: the log read forward from the
      // caller's position, once per level above what this drain delivered.
      // A level says "there is more", not "there is one more", so a burst of
      // commits during a read collapses into one further read. A read
      // delivers up to the level it started at whether or not every row in
      // between materialized, so a row the read could not deliver is not
      // read again on every later wake.
      const all = (fromCommit: SessionCursor): Stream.Stream<SessionEvent> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const at = yield* Ref.make(fromCommit);
            const forward = Stream.unwrap(
              Effect.gen(function* () {
                const cursor = yield* Ref.get(at);
                const upTo = yield* SubscriptionRef.get(log.level);
                return Stream.concat(
                  log
                    .readAll(cursor)
                    .pipe(Stream.tap((event) => Ref.set(at, event.commit))),
                  Stream.fromEffect(
                    Ref.update(at, (delivered) => Math.max(delivered, upTo)),
                  ).pipe(Stream.drain),
                );
              }),
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
        listing: log.readListing,
        all,
        aggregate: log.readAggregate,
        anchor,
      };
    }),
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
 * so this names fields and never re-encodes. The lifecycle pair, `run.start`
 * and `run.activate`, is not a trace event: the launcher publishes it as
 * one batch on the session (PRD 6, item 8).
 */
export function runEventDraft(
  streamId: StreamTabId,
  event: AgentEvent,
): SessionEventDraft | null {
  switch (event.type) {
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
