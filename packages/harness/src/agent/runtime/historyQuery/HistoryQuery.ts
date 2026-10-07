/**
 * A session's history query store: the model's SQL runs against a separate
 * in-memory database that holds only the session's display rows, copied in
 * from `SessionEvents.all` up to the commit the query was asked at. Nothing
 * a statement names can reach the session database, a run history row, a private
 * run record or an envelope column: those were never copied.
 *
 * The store is a child process (`childSource.ts`), started on the first
 * query and closed with the session's scope. Queries run one at a time; a
 * query past its deadline, or one whose caller is interrupted, kills the
 * process, and the next query rebuilds the store from the start.
 */
import {
  Cause,
  Data,
  Effect,
  Exit,
  Option,
  Queue,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import * as ChildProcess from 'effect/process/ChildProcess';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import { z } from 'zod';

import { parseJsonWith } from '@common/parsing/safeParseJson';
import { withLogChannel } from '@logger/effectLog';
import {
  aggregateTarget,
  type CommitOrdinal,
  type DisplaySessionEvent,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';

import { HISTORY_QUERY_CHILD_SOURCE } from './childSource';
import {
  HISTORY_INSERT_SQL,
  HISTORY_REMOVE_SQL,
  HISTORY_SCHEMA_SQL,
  HISTORY_ROW_LIMIT,
  HISTORY_TEXT_LIMIT,
} from './views';
import type { SessionHandle } from '../SessionHandle';
import type { PlatformError } from 'effect/PlatformError';

const CHANNEL = 'HistoryQuery';
const QUERY_DEADLINE = '5 seconds';
/** Rows one query returns; the page says when more exist. */
const HISTORY_QUERY_ROW_CAP = 200;
/** SQLite's own memory ceiling in the store, rows and sorts together. */
const STORE_HEAP_LIMIT_BYTES = 1024 * 1024 * 1024;
/** Rows per append request: each row is capped, so a request is bounded
 *  however long the history. */
const APPEND_ROWS = 500;

/** A statement the store will not run, or did not finish: the model's to
 *  correct, so its message is SQLite's own or names the limit it hit. */
export class HistoryQueryRefused extends Data.TaggedError(
  'HistoryQueryRefused',
)<{
  readonly reason: 'not-a-read' | 'rejected' | 'timeout';
  readonly message: string;
}> {}

/** The store itself failed: its process would not start, exited, or refused
 *  the rows it was fed. */
export class HistoryQueryFailed extends Data.TaggedError('HistoryQueryFailed')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const CellSchema = z.union([z.string(), z.number(), z.null()]);
export type HistoryCell = z.infer<typeof CellSchema>;
const PageSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(CellSchema)),
  more: z.boolean(),
});
export type HistoryPage = z.infer<typeof PageSchema>;
const ReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
type Reply = z.infer<typeof ReplySchema>;

/** The session a store reads: its display tail and its current commit. */
type HistorySession = Pick<SessionHandle, 'log'>;

type StoreOp =
  | readonly ['insert', string, string, string, string]
  | readonly ['remove', string];

interface Store {
  readonly scope: Scope.Closeable;
  readonly requests: Queue.Queue<string>;
  readonly replies: Queue.Queue<string, Cause.Done | PlatformError>;
  cursor: CommitOrdinal;
}

const ENVELOPE_KEYS = new Set([
  'type',
  'aggregateId',
  'seq',
  'commit',
  'origin',
  'at',
  'stageId',
]);

/** One `SELECT`, `WITH`, `EXPLAIN` or `VALUES` statement, read with its
 *  comments and quoted text blanked so neither can hide structure. */
function statementRefusal(sql: string): string | null {
  const shape = sql.replaceAll(
    /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'?|"(?:[^"]|"")*"?|`[^`]*`?|\[[^\]]*\]?/g,
    ' ',
  );
  if (!/^\s*(?:select|with|explain|values)\b/i.test(shape)) {
    return 'Only a read is allowed: one SELECT, WITH, EXPLAIN or VALUES statement.';
  }
  if (shape.trim().replace(/;\s*$/, '').includes(';')) {
    return 'Send one statement per query; this one has more than one.';
  }
  return null;
}

function storeOps(rows: readonly DisplaySessionEvent[]): StoreOp[] {
  const ops: StoreOp[] = [];
  for (const row of rows) {
    const target = aggregateTarget(row.aggregateId);
    if (target.kind !== 'run') continue;
    if (row.type === 'run.removed') {
      for (const id of new Set([target.id, ...row.runIds])) {
        ops.push(['remove', id]);
      }
      continue;
    }
    const payload = Object.fromEntries(
      Object.entries(row).filter(([key]) => !ENVELOPE_KEYS.has(key)),
    );
    const data = JSON.stringify(payload, (_key, value: unknown) =>
      typeof value === 'string' && value.length > HISTORY_TEXT_LIMIT
        ? `${value.slice(0, HISTORY_TEXT_LIMIT)}… [cut: ${value.length} characters in all]`
        : value,
    );
    ops.push([
      'insert',
      target.id,
      row.type,
      new Date(row.at).toISOString(),
      data.length > HISTORY_ROW_LIMIT
        ? JSON.stringify({ cut: data.length })
        : data,
    ]);
  }
  return ops;
}

const request = Effect.fn('HistoryQuery.request')(function* (
  store: Store,
  message: Record<string, unknown>,
) {
  yield* Queue.offer(store.requests, JSON.stringify(message));
  const line = yield* Queue.take(store.replies).pipe(
    Effect.mapError(
      (cause) =>
        new HistoryQueryFailed({
          message: 'The history query process exited.',
          cause,
        }),
    ),
  );
  const reply = parseJsonWith(line, ReplySchema);
  if (reply._tag === 'Failure') {
    return yield* new HistoryQueryFailed({
      message: 'The history query process sent an unreadable reply.',
      cause: reply.failure,
    });
  }
  return reply.success;
});

const failedStep =
  (step: string) =>
  (reply: Reply): Effect.Effect<void, HistoryQueryFailed> =>
    reply.ok
      ? Effect.void
      : Effect.fail(
          new HistoryQueryFailed({
            message: `The history query store refused its ${step}: ${reply.message}`,
          }),
        );

const openStore = Effect.fn('HistoryQuery.open')(function* (
  parent: Scope.Scope,
  spawner: ChildProcessSpawner['Service'],
) {
  const scope = yield* Scope.fork(parent);
  return yield* Effect.gen(function* () {
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(
          process.execPath,
          ['-e', HISTORY_QUERY_CHILD_SOURCE],
          {
            // An Electron host (the desktop app, the VS Code extension
            // host) runs its own binary as plain Node only when asked.
            env: { ELECTRON_RUN_AS_NODE: '1' },
            extendEnv: true,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'ignore',
            killSignal: 'SIGKILL',
          },
        ),
      )
      .pipe(
        Scope.provide(scope),
        Effect.mapError(
          (cause) =>
            new HistoryQueryFailed({
              message: 'The history query process could not start.',
              cause,
            }),
        ),
      );
    const requests = yield* Queue.unbounded<string>();
    const replies = yield* Queue.unbounded<
      string,
      Cause.Done | PlatformError
    >();
    // A failed write ends the reply queue with its cause, so the request
    // waiting on a reply fails as `HistoryQueryFailed` instead of hanging.
    yield* Stream.fromQueue(requests).pipe(
      Stream.map((line) => `${line}\n`),
      Stream.encodeText,
      Stream.run(handle.stdin),
      Effect.catch((error) => Queue.fail(replies, error)),
      Effect.forkIn(scope),
    );
    yield* Stream.runIntoQueue(
      handle.stdout.pipe(Stream.decodeText(), Stream.splitLines),
      replies,
    ).pipe(Effect.forkIn(scope));
    const store: Store = { scope, requests, replies, cursor: 0 };
    yield* request(store, {
      kind: 'init',
      schema: HISTORY_SCHEMA_SQL,
      insert: HISTORY_INSERT_SQL,
      remove: HISTORY_REMOVE_SQL,
      heapLimit: STORE_HEAP_LIMIT_BYTES,
    }).pipe(Effect.flatMap(failedStep('schema')));
    return store;
  }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
});

export class HistoryQuery {
  /** Built in the session's scope: the store's process closes with it. */
  static readonly make = (
    session: () => HistorySession,
  ): Effect.Effect<HistoryQuery, never, Scope.Scope | ChildProcessSpawner> =>
    Effect.gen(function* () {
      return new HistoryQuery(
        session,
        yield* Effect.scope,
        yield* ChildProcessSpawner,
      );
    });

  private readonly lane = Semaphore.makeUnsafe(1);
  private store: Store | undefined;

  private constructor(
    private readonly session: () => HistorySession,
    private readonly scope: Scope.Scope,
    private readonly spawner: ChildProcessSpawner['Service'],
  ) {}

  /** Run one read over the session's history as of this call. */
  query(
    sql: string,
    params: readonly HistoryCell[],
  ): Effect.Effect<
    HistoryPage,
    HistoryQueryRefused | HistoryQueryFailed | DatabaseReadFailed
  > {
    const refusal = statementRefusal(sql);
    if (refusal !== null) {
      return Effect.fail(
        new HistoryQueryRefused({ reason: 'not-a-read', message: refusal }),
      );
    }
    return this.lane.withPermit(
      this.run(sql, params).pipe(
        Effect.onInterrupt(() => this.discard('its caller was interrupted')),
        // A failed feed may have appended part of its rows: the next query
        // rebuilds the store rather than append them twice.
        Effect.tapError((error) =>
          error._tag === 'HistoryQueryRefused'
            ? Effect.void
            : this.discard(error.message),
        ),
      ),
    );
  }

  private run(sql: string, params: readonly HistoryCell[]) {
    return Effect.gen({ self: this }, function* () {
      const target = this.session().log.now();
      // A cleared database restarts its commits below what the store holds.
      if (this.store && target < this.store.cursor) {
        yield* this.discard('the session database was cleared');
      }
      const store = this.store ?? (yield* openStore(this.scope, this.spawner));
      this.store = store;
      if (target > store.cursor) {
        let cursor = target;
        yield* this.readThrough(store.cursor, target).pipe(
          Stream.grouped(APPEND_ROWS),
          Stream.runForEach((rows) => {
            // Not a spread: a group can carry more rows than a call takes
            // arguments.
            cursor = rows.reduce((at, row) => Math.max(at, row.commit), cursor);
            const ops = storeOps(rows);
            return ops.length === 0
              ? Effect.void
              : request(store, { kind: 'append', ops }).pipe(
                  Effect.flatMap(failedStep('rows')),
                );
          }),
        );
        store.cursor = cursor;
      }
      const reply = yield* request(store, {
        kind: 'query',
        sql,
        params,
        cap: HISTORY_QUERY_ROW_CAP,
      }).pipe(Effect.timeoutOption(QUERY_DEADLINE));
      if (Option.isNone(reply)) {
        yield* this.discard('a query ran past its deadline');
        return yield* new HistoryQueryRefused({
          reason: 'timeout',
          message: `The query did not finish within ${QUERY_DEADLINE} and was stopped. Narrow it (filter by run_id, add LIMIT) and retry.`,
        });
      }
      if (!reply.value.ok) {
        return yield* new HistoryQueryRefused({
          reason: 'rejected',
          message: reply.value.message,
        });
      }
      const page = PageSchema.safeParse(reply.value.value);
      if (!page.success) {
        return yield* new HistoryQueryFailed({
          message: 'The history query process sent an unreadable page.',
          cause: page.error,
        });
      }
      return page.data;
    });
  }

  /** The display rows committed after `from`, through at least `target`. */
  private readThrough(from: CommitOrdinal, target: CommitOrdinal) {
    return Stream.unwrap(
      Effect.gen({ self: this }, function* () {
        const drained = yield* SubscriptionRef.make(from);
        const reached = SubscriptionRef.changes(drained).pipe(
          Stream.filter((commit) => commit >= target),
          Stream.runHead,
        );
        return this.session()
          .log.tail(from, drained)
          .pipe(Stream.interruptWhen(reached));
      }),
    );
  }

  private discard(why: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      const store = this.store;
      if (store === undefined) return Effect.void;
      this.store = undefined;
      return Effect.logWarning(
        `History query store closed: ${why}; the next query rebuilds it.`,
      ).pipe(
        withLogChannel(CHANNEL),
        Effect.andThen(Scope.close(store.scope, Exit.void)),
      );
    });
  }
}
