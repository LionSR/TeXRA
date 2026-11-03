/**
 * The query store's process, both sides: the in-memory SQLite database it
 * runs, answering one JSON line per request line on stdio, and the session
 * side's door to it ({@link openStore}, {@link request}). It runs as its own
 * process so a runaway statement ends with a kill: `node:sqlite` has no
 * interrupt or progress handler, and a thread cannot be stopped inside
 * SQLite's native loop.
 *
 * It never opens the session database. `query_only` is on except while an
 * append runs, so the model's statement cannot write even through a
 * `WITH … INSERT`; the session side admits only one `SELECT`/`WITH`/`EXPLAIN`
 * statement, which also keeps `PRAGMA` out. Stdin closing (its host exited,
 * by any means) ends the process.
 */
import { type Cause, Effect, Exit, Queue, Schema, Scope, Stream } from 'effect';
import * as ChildProcess from 'effect/process/ChildProcess';

import type { CommitOrdinal, RunId } from '@shared/schemas';
import {
  HistoryQueryFailed,
  HistoryQueryRefused,
} from '@shared/session/runHistory';
import type { RunView, SessionView } from '@shared/session/sessionView';

import { HISTORY_SCHEMA_SQL, HISTORY_WRITE_SQL } from './views';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { PlatformError } from 'effect/PlatformError';

/** SQLite's own memory ceiling in the store, rows and sorts together. */
const STORE_HEAP_LIMIT_BYTES = 1024 * 1024 * 1024;

/** The process's source: plain CommonJS in a string, run under `node -e`,
 *  so no host bundles or resolves a file for it. */
const HISTORY_QUERY_CHILD_SOURCE = String.raw`
'use strict';
const { DatabaseSync } = require('node:sqlite');
const readline = require('node:readline');
const db = new DatabaseSync(':memory:');
let writes;
const cell = (value) =>
  typeof value === 'bigint'
    ? Number(value)
    : value instanceof Uint8Array
      ? '<blob ' + value.byteLength + ' bytes>'
      : value;
const writable = (body) => {
  db.exec('PRAGMA query_only = OFF');
  try {
    body();
  } finally {
    db.exec('PRAGMA query_only = ON');
  }
};
const handle = (message) => {
  switch (message.kind) {
    case 'init':
      db.exec('PRAGMA hard_heap_limit = ' + message.heapLimit);
      db.exec(message.schema);
      writes = Object.fromEntries(
        Object.entries(message.writes).map(([name, sql]) => [name, db.prepare(sql)]),
      );
      db.exec('PRAGMA query_only = ON');
      return null;
    case 'append':
      writable(() => {
        db.exec('BEGIN');
        try {
          for (const [name, ...values] of message.ops) writes[name].run(...values);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
      return null;
    case 'query': {
      const statement = db.prepare(message.sql);
      statement.setReturnArrays(true);
      const columns = statement.columns().map((column) => column.name);
      const rows = [];
      // Count the UTF-8 JSON page, not its characters: SQL can synthesize a
      // large cell even though the source history's text values are bounded.
      let bytes = Buffer.byteLength(JSON.stringify({ columns, rows, more: false }));
      const tooLarge = new Error('Query result exceeds ' + message.maxBytes + ' bytes. Select fewer columns, use LIMIT or substr(), and retry. No values were truncated.');
      tooLarge.code = 'RESULT_TOO_LARGE';
      if (bytes > message.maxBytes) throw tooLarge;
      for (const row of statement.iterate(...message.params)) {
        if (rows.length === message.cap) return { columns, rows, more: true };
        const values = row.map(cell);
        bytes += Buffer.byteLength(JSON.stringify(values)) + (rows.length === 0 ? 0 : 1);
        if (bytes > message.maxBytes) throw tooLarge;
        rows.push(values);
      }
      return { columns, rows, more: false };
    }
    default:
      throw new Error('Unknown request kind: ' + message.kind);
  }
};
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let reply;
  try {
    reply = { ok: true, value: handle(JSON.parse(line)) };
  } catch (error) {
    reply = {
      _tag: 'HistoryQueryRefused',
      reason: error?.code === 'RESULT_TOO_LARGE' ? 'result-too-large' : 'rejected',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  process.stdout.write(JSON.stringify(reply) + '\n');
});
lines.on('close', () => process.exit(0));
`;

/** A reply line: the request's value, or the refusal the process reports. */
const ReplySchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  HistoryQueryRefused,
]);
const ReplyLineSchema = Schema.fromJsonString(ReplySchema);

/** One open store process and what the session side last fed it. */
export interface Store {
  readonly scope: Scope.Closeable;
  readonly requests: Queue.Queue<string>;
  readonly replies: Queue.Queue<string, Cause.Done | PlatformError>;
  /** The commit every fed call fact is at or below. */
  cursor: CommitOrdinal;
  /** The view's `runs` the store's `runs` table was last filled from. */
  runs?: SessionView['runs'];
  /** Each fed run's view and the `seq` of the last of its rows read. */
  readonly fed: Map<RunId, { readonly view: RunView; readonly seq: number }>;
  /** Each tool card's call id: what a child's `parent_call_id` reads. */
  readonly callIds: Map<string, string>;
}

/** Replaces an effect's failure with a `HistoryQueryFailed` carrying it. */
export const failedWith =
  (message: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, HistoryQueryFailed, R> =>
    Effect.mapError(
      effect,
      (cause) => new HistoryQueryFailed({ message, cause }),
    );

/** One request to the store and its reply. */
export const request = Effect.fn('HistoryQuery.request')(function* (
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

/** A refused reply to the store's own `step` as a `HistoryQueryFailed`. */
export const failedStep =
  (step: string) =>
  (reply: typeof ReplySchema.Type): Effect.Effect<void, HistoryQueryFailed> =>
    reply instanceof HistoryQueryRefused
      ? Effect.fail(
          new HistoryQueryFailed({
            message: `The history query store refused its ${step}: ${reply.message}`,
          }),
        )
      : Effect.void;

/** Start a store process in a scope forked from `parent`, its schema made. */
export const openStore = Effect.fn('HistoryQuery.open')(function* (
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
    const store: Store = {
      scope,
      requests,
      replies,
      cursor: 0,
      fed: new Map(),
      callIds: new Map(),
    };
    yield* request(store, {
      kind: 'init',
      schema: HISTORY_SCHEMA_SQL,
      writes: HISTORY_WRITE_SQL,
      heapLimit: STORE_HEAP_LIMIT_BYTES,
    }).pipe(Effect.flatMap(failedStep('schema')));
    return store;
  }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
});
