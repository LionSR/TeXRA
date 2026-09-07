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
// Node imports
import { hostname } from 'node:os';

// Third-party imports
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
import { FileReadLimitError } from '@common/storage/fileReadLimit';
import { createLog } from '@logger/logUtils';
import {
  runWithWorkspaceRoots,
  type WorkspaceRoots,
} from '@platform/workspaceRoots';
import {
  aggregateTarget,
  aggregateId as qualifyAggregateId,
  type AggregateId,
  type CommitOrdinal,
  type OwnerId,
  type SessionEvent,
  type SessionEventDraft,
  type StreamTabId,
} from '@shared/schemas';
import {
  ProcessIdentity,
  SessionEvents,
  type SessionCursor,
} from '@shared/session/sessionEvents';
import {
  SessionReaderError,
  type SessionReadBudget,
} from '@shared/session/sessionReadBudget';
import type { StreamLogStore } from '@transcript/StreamLogStore';
import {
  HISTORICAL_COMMITS_PER_STREAM,
  historicalListing,
  isHistoricalStream,
} from './historicalListing';

const logger = createLog('sessionEvents');

/** This process's complete owner identity (contract C5). */
export function processOwnerId(processStart: string | undefined): OwnerId {
  return JSON.stringify([
    hostname().toLowerCase(),
    process.pid,
    processStart ?? null,
  ]);
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
  readonly aggregateId: AggregateId;
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
 * The memory layer is the pre-cutover store, and two of its tiers are the
 * transcript store's: the listing tier derives every historical stream from
 * the store's resident summary tier when a reader subscribes
 * (`historicalListing.ts`; nothing is walked at graph open, nothing held),
 * and the transcript tier reads that store's rows for a subscribed stream
 * (`aggregate(id, fromSeq)`, the store's row `seqNo` is the aggregate seq),
 * while the tail holds a transcript row's place only, materialized from the
 * store when read. Nothing here reaches disk, and the cutover replaces this
 * layer with the SQLite write path under the same shape.
 */
export class SessionEventLog extends Context.Service<
  SessionEventLog,
  {
    readonly level: SubscriptionRef.SubscriptionRef<CommitOrdinal>;
    /** Assign each draft its aggregate seq and commit ordinal, append it
     *  under the log's permit, and move the level; returns the last ordinal.
     *  `at` is the publish clock (C1, informational). */
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
      budget?: SessionReadBudget,
    ) => Stream.Stream<SessionEvent>;
    /** Whether the aggregate exists and is not closed (C2, C9): a stream
     *  exists from its listing (the summary tier's, or the publish of its
     *  `run.start`) until its tombstone. Synchronous at publish: `appendAll` crosses no
     *  asynchronous boundary, so the fork `SessionHandle.publish` makes has
     *  minted its rows before that call returns, ahead of every fold. */
    readonly exists: (aggregateId: AggregateId) => Effect.Effect<boolean>;
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
        // The listing tier's membership (`historicalListing.ts`): the
        // streams that exist as this log is built. One key-set copy, no
        // facts read; the facts are read when a reader first subscribes and
        // held from then on. Their commits are reserved below the log's
        // first row, so a log commit is the row's 1-based position above
        // `reserved`, and the level starts there.
        const historical: ReadonlySet<StreamTabId> = new Set(
          transcripts.keys(),
        );
        const reserved = historical.size * HISTORICAL_COMMITS_PER_STREAM;
        let listing: SessionEvent[] | undefined;
        const historicalRows = (): SessionEvent[] =>
          (listing ??= historicalListing(
            transcripts,
            historical,
            identity.ownerId,
          ));
        const level = yield* SubscriptionRef.make<CommitOrdinal>(reserved);
        const gate = yield* Semaphore.make(1);
        const rows: LogRow[] = [];
        // The sequence table (C1, C2): one seq counter per aggregate for
        // every row it holds, and the aggregates a tombstone closed. The
        // transcript rows already in the store when an aggregate's first
        // row lands are not on this log, so its counter is seeded once from
        // the store's head and never read beside it: every store append
        // reaches the log as a row, so the counter stays at or above the
        // head, a tail row's seq is above the store `seqNo` a history read
        // stamps on the same entry, both order under one `view.folded`
        // threshold, and an entry that reaches a reader by both is applied
        // once more by id, never as a second row.
        const seqs = new Map<AggregateId, number>();
        const closed = new Set<AggregateId>();
        const nextSeq = (aggregateId: AggregateId): number => {
          const seq =
            (seqs.get(aggregateId) ??
              (aggregateTarget(aggregateId).kind === 'stream'
                ? transcripts.get(aggregateTarget(aggregateId).id)?.head
                : 0) ??
              0) + 1;
          seqs.set(aggregateId, seq);
          return seq;
        };
        const materialize = (row: LogRow): SessionEvent | null => {
          if (row.type !== 'transcript.ref') return row;
          const entry = transcripts
            .get(aggregateTarget(row.aggregateId).id)
            ?.getById(row.entryId);
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
          if (transcripts.has(aggregateTarget(row.aggregateId).id)) {
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
                    const commit = reserved + rows.length + 1;
                    const seq = nextSeq(draft.aggregateId);
                    if (draft.type === 'transcript.entry') {
                      rows.push({
                        type: 'transcript.ref',
                        aggregateId: draft.aggregateId,
                        entryId: draft.entry.id,
                        seq,
                        commit,
                        at,
                      });
                      continue;
                    }
                    if (draft.type === 'stream.removed') {
                      closed.add(draft.aggregateId);
                    }
                    rows.push({
                      ...draft,
                      seq,
                      commit,
                      ownerId: identity.ownerId,
                      at,
                    } as SessionEvent);
                  }
                  const last = reserved + rows.length;
                  yield* SubscriptionRef.set(level, last);
                  return last;
                }),
              ),
            ),
          // `commit` is the row's 1-based position above `reserved`, so
          // the rows above a commit are the slice past it; a cursor inside
          // the listing tier's space reads every log row.
          readAll: (fromCommit) =>
            Stream.suspend(() => {
              const end = rows.length;
              return Stream.fromIterable(
                (function* () {
                  for (
                    let index = Math.max(0, fromCommit - reserved);
                    index < end;
                    index += 1
                  ) {
                    const row = rows[index];
                    if (row === undefined) continue;
                    const event = materialize(row);
                    if (event !== null) yield event;
                  }
                })(),
                { chunkSize: 1 },
              );
            }),
          // The listing tier is the summary tier's plus the log's own
          // listing rows: every historical stream derived from the store
          // on the first read, in the reserved commit space, then the facts
          // this process appended, which outrank them per key under the
          // fold's commit order. No history is walked at graph open.
          readListing: () =>
            Stream.suspend(() =>
              Stream.fromIterable([...historicalRows(), ...listingRows(rows)]),
            ),
          // The transcript tier is the store's: its rows for the stream
          // above `fromSeq`, read once without adding residency, stamped
          // with the store's own `seqNo` (below the log's seq for the same
          // entry, see `nextSeq`) and the level they were read at. The
          // stream's listing facts reach a reader through `listing()` and
          // the tail.
          readAggregate: (aggregateId, fromSeq, budget) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const target = aggregateTarget(aggregateId);
                if (target.kind !== 'stream') {
                  const end = rows.length;
                  return Stream.fromIterable(
                    (function* () {
                      for (let index = 0; index < end; index += 1) {
                        const row = rows[index];
                        if (
                          row === undefined ||
                          row.aggregateId !== aggregateId ||
                          row.seq <= fromSeq
                        )
                          continue;
                        const event = materialize(row);
                        if (event !== null) yield event;
                      }
                    })(),
                    { chunkSize: 1 },
                  );
                }
                const commit = yield* SubscriptionRef.get(level);
                const entries = yield* Effect.tryPromise({
                  try: async () =>
                    runWithWorkspaceRoots(roots, () =>
                      transcripts.readEntries(target.id, budget),
                    ),
                  catch: (error) =>
                    error instanceof FileReadLimitError
                      ? new SessionReaderError(
                          'This conversation exceeds the history display limit. Its saved content is unchanged.',
                        )
                      : error,
                }).pipe(Effect.orDie);
                return Stream.fromIterable(entries, { chunkSize: 1 }).pipe(
                  Stream.filter((entry) => entry.seqNo > fromSeq),
                  Stream.map((entry): SessionEvent => ({
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
          // A stream exists from its listing (a historical stream the
          // summary tier lists, or a `run.start` this process appended)
          // until its tombstone.
          exists: (aggregateId) =>
            Effect.sync(
              () =>
                !closed.has(aggregateId) &&
                (seqs.has(aggregateId) ||
                  (aggregateTarget(aggregateId).kind === 'stream' &&
                    isHistoricalStream(
                      transcripts,
                      historical,
                      aggregateTarget(aggregateId).id,
                    ))),
            ),
        };
      }),
    );
  }
}

/** * THE tail drain (C7): `read` forward from the caller's position, once per
 * value of `level` above what this drain delivered, never past the value
 * that woke it. A level says "there is more", not "there is one more", so a
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
export function tailFrom(
  read: (fromCommit: SessionCursor) => Stream.Stream<SessionEvent>,
  level: {
    readonly get: Effect.Effect<CommitOrdinal>;
    readonly changes: Stream.Stream<CommitOrdinal>;
  },
  fromCommit: SessionCursor,
  drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
): Stream.Stream<SessionEvent> {
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
        Stream.filterEffect((value) =>
          Ref.get(at).pipe(Effect.map((delivered) => value > delivered)),
        ),
        Stream.flatMap(() => forward, { concurrency: 1 }),
      );
    }),
  );
}

/**
 * The plane over the in-memory log: the publisher and the three reads over
 * a `SessionEventLog`. Each reader supplies its own starting position.
 */
export const sessionEventsLayer = Layer.effect(
  SessionEvents,
  Effect.gen(function* () {
    const log = yield* SessionEventLog;
    const publish = Effect.fn('SessionEvents.publish')(function* (
      events: readonly SessionEventDraft[],
    ) {
      yield* log.appendAll(events);
    });
    // THE tail (C7): the drain woken by the log's level.
    const all = (
      fromCommit: SessionCursor,
      drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
    ): Stream.Stream<SessionEvent> =>
      tailFrom(
        log.readAll,
        {
          get: SubscriptionRef.get(log.level),
          changes: SubscriptionRef.changes(log.level),
        },
        fromCommit,
        drained,
      );
    return {
      publish,
      listing: () => log.readListing(),
      all,
      aggregate: (aggregateId, fromSeq) =>
        log.readAggregate(aggregateId, fromSeq),
    };
  }),
);

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
        aggregateId: qualifyAggregateId('stream', streamId),
        executionId: event.executionId,
        config: event.config,
      };
    case 'result':
      return {
        type: event.type,
        aggregateId: qualifyAggregateId('stream', streamId),
        outcome: event.outcome,
        executionId: event.executionId,
        category: event.category,
        isSubagent: event.isSubagent,
        // The kind only: the message is provider or launcher text no fold
        // reads, and the plane frames to renderer processes (C3).
        error: event.error ? { kind: event.error.kind } : null,
      };
    case 'stage.start':
      return {
        type: event.type,
        aggregateId: qualifyAggregateId('stream', streamId),
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
        aggregateId: qualifyAggregateId('stream', streamId),
        progress: event.progress,
      };
    case 'usage':
      return {
        type: event.type,
        aggregateId: qualifyAggregateId('stream', streamId),
        storageKey: event.payload.storageKey,
        usage: event.payload.usage,
      };
    case 'context.state':
      return {
        type: event.type,
        aggregateId: qualifyAggregateId('stream', streamId),
        inputTokens: event.inputTokens,
        contextWindow: event.contextWindow,
      };
    case 'updateTodos':
      return {
        type: event.type,
        aggregateId: qualifyAggregateId('stream', streamId),
        todos: event.todos,
      };
    case 'updatePlan':
      return {
        type: event.type,
        aggregateId: qualifyAggregateId('stream', streamId),
        plan: event.plan,
      };
    case 'addOutputFiles':
    case 'updateMissingOutputs':
    case 'updateCompileFailures':
      return {
        type: event.type,
        aggregateId: qualifyAggregateId('stream', streamId),
        filesByRound: event.filesByRound,
      } as SessionEventDraft;
    case 'goalPaused':
      return {
        type: event.type,
        aggregateId: qualifyAggregateId('stream', streamId),
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
    aggregateId: qualifyAggregateId('stream', event.streamId),
    phase: event.phase,
    previousPhase: event.previousPhase,
    cause: event.cause,
    substate: event.substate,
    runStartedAt: event.runStartedAt,
  };
}
