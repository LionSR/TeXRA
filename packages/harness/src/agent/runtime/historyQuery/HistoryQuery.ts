/**
 * Model SQL reads a separate in-memory display-row store from
 * `SessionEvents.all`, through the requested commit. It never opens the
 * session database or copies core history, private records or envelope columns.
 *
 * The child process starts on first query and closes with the session scope.
 * Queries are serialized; timeout or caller interruption kills the child.
 * The next query then rebuilds the store from the start.
 */
import {
  Cause,
  Effect,
  Exit,
  Option,
  Queue,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import * as ChildProcess from 'effect/process/ChildProcess';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

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
/** Serialized page ceiling before a result leaves the query process. */
const HISTORY_QUERY_PAGE_LIMIT_BYTES = 4 * 1024 * 1024;
/** SQLite's own memory ceiling in the store, rows and sorts together. */
const STORE_HEAP_LIMIT_BYTES = 1024 * 1024 * 1024;
/** Capped rows per append keep requests bounded for any history length. */
const APPEND_ROWS = 500;

/** A correctable query refusal: SQLite's error or the exceeded limit. */
export class HistoryQueryRefused extends Schema.TaggedError<HistoryQueryRefused>()(
  'HistoryQueryRefused',
  {
    reason: Schema.Literals([
      'not-a-read',
      'rejected',
      'timeout',
      'result-too-large',
    ]),
    message: Schema.String,
  },
) {}

/** A store failure: process startup, exit, or rejected history rows. */
export class HistoryQueryFailed extends Schema.TaggedError<HistoryQueryFailed>()(
  'HistoryQueryFailed',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const CellSchema = Schema.Union([Schema.String, Schema.Number, Schema.Null]);
export type HistoryCell = typeof CellSchema.Type;
const PageSchema = Schema.Struct({
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(CellSchema)),
  more: Schema.Boolean,
});
export type HistoryPage = typeof PageSchema.Type;
const ReplySchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: Schema.Literals(['rejected', 'result-too-large']),
    message: Schema.String,
  }),
]);
type Reply = typeof ReplySchema.Type;
const ReplyLineSchema = Schema.fromJsonString(ReplySchema);

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

/** Replaces an effect's failure with a `HistoryQueryFailed` carrying it. */
const failedWith = (message: string) =>
  Effect.mapError(
    (cause: unknown) => new HistoryQueryFailed({ message, cause }),
  );

const request = Effect.fn('HistoryQuery.request')(function* (
  store: Store,
  message: Record<string, unknown>,
) {
  yield* Queue.offer(store.requests, JSON.stringify(message));
  const line = yield* Queue.take(store.replies).pipe(
    failedWith('The history query process exited.'),
  );
  return yield* Schema.decodeUnknownEffect(ReplyLineSchema)(line).pipe(
    failedWith('The history query process sent an unreadable reply.'),
  );
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

  private readonly session: () => HistorySession;
  private readonly scope: Scope.Scope;
  private readonly spawner: ChildProcessSpawner['Service'];
  private constructor(
    session: () => HistorySession,
    scope: Scope.Scope,
    spawner: ChildProcessSpawner['Service'],
  ) {
    this.session = session;
    this.scope = scope;
    this.spawner = spawner;
  }

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
        maxBytes: HISTORY_QUERY_PAGE_LIMIT_BYTES,
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
          reason: reply.value.reason,
          message: reply.value.message,
        });
      }
      return yield* Schema.decodeUnknownEffect(PageSchema)(
        reply.value.value,
      ).pipe(failedWith('The history query process sent an unreadable page.'));
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
