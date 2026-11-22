/**
 * The session graph's durable boundary: replay framing and the live-owner
 * waiting rule.
 *
 * Framing: the log a graph is built over is history under the plane's
 * anchor. The fold publishes nothing before the replay marker, so the first
 * state a mounting reader sees already holds the listing, the aggregate
 * history, and the local snapshot; the tail then publishes every commit in
 * order. The waiting rule: a pending request on a run a launch here holds
 * folds to `waiting`; the same log with no launch folds to `interrupted`.
 */
// Node imports
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Third-party imports
import { it } from '@effect/vitest';
import { build } from 'esbuild';
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  type FileSystem,
  Layer,
  PlatformError,
  PubSub,
  Result,
  Scheduler,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';

import { afterAll, assert, beforeAll, describe, expect, vi } from 'vitest';

import { Sessions } from '@texra-ai/worldline';
import { nodePlatform } from '@texra-ai/worldline/node';
import { definePlugin } from '@texra-ai/worldline/plugins';

import {
  type RunId,
  RunIdSchema,
  type SessionRow,
  type SessionRowDraft,
  type SessionView,
} from '@texra-ai/worldline/schemas';
import { LocalRuntimeStateSchema } from '@shared/schemas';
import { sessionEventsLayer } from '@agent/runtime/sessionEventsLayer';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { SessionWorkspace } from '@shared/session/sessionWorkspace';
import { sessionInputsLayer } from '@controllers/session/sessionInputsLayer';
import { SessionViewService } from '@shared/session/sessionViewService';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from '@shared/session/sessionSources';
import { deletionCollector } from '@controllers/session/deletionCleanup';
import {
  databaseLayer,
  STORE_HELD_MESSAGE,
} from '@controllers/session/databaseLayer';
import { runStateAppend } from '@shared/session/runHistory';
import { SessionRowSchema } from '@shared/schemas';
import { Database } from '@shared/session/database';
import { SessionEvents, type Append } from '@shared/session/sessionEvents';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import {
  createFakeWorkspaceRoots,
  HARNESS_APP,
} from '@test/support/FakePlatform';
import { runStart } from '@test/support/sessionRows';
import { readStoreSnapshot } from '@test/support/storeFaults';
import { storePluginsLayer } from '@test/support/texraApp';
import { REPO_ROOT } from '@test/support/repoRoot';

/** A second OS process's writer: this build's `Database` over the store at
 *  `storage`, creating `run`. */
const STORE_WRITER = `
import { Effect, Layer } from 'effect';
import { databaseLayer } from '@controllers/session/databaseLayer';
import { SessionWorkspace } from '@shared/session/sessionWorkspace';
import { AppNamespace } from '@utils/system/appNamespace';
import { nodePlatformServices } from '@platform/defaults/nodeServices';
import { Database } from '@shared/session/database';
import { ToolRegistry, toolTable } from '@tools/toolTable';

const [storage, run] = process.argv.slice(2);
const append = Effect.flatMap(Database, (db) =>
  db.appendAll([{ type: 'run.start', aggregateId: run,
    identity: { kind: 'agent', agent: 'chat' }, takesFollowUps: false,
    worktree: null, parent: null, provenance: null,
    grants: { own: {}, goal: [] }, maxCostUsd: null }]));
await Effect.runPromise(append.pipe(Effect.provide(databaseLayer('persistent').pipe(
  Layer.provide(Layer.succeed(SessionWorkspace)({ storage })),
  Layer.provide(Layer.succeed(ToolRegistry)(toolTable([]))),
  Layer.provide(Layer.succeed(AppNamespace)('texra')),
  Layer.provide(nodePlatformServices)))));
`;

/** {@link STORE_WRITER}, bundled into `dir` for `node` to run. */
async function bundleStoreWriter(dir: string): Promise<string> {
  const outfile = join(dir, 'store-writer.mjs');
  await build({
    stdin: {
      contents: STORE_WRITER,
      resolveDir: join(REPO_ROOT, 'src'),
      sourcefile: 'store-writer.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    // A bundled CommonJS dependency's `require` of a Node built-in.
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    logLevel: 'silent',
    tsconfig: join(REPO_ROOT, 'tsconfig.json'),
    nodePaths: [join(REPO_ROOT, 'node_modules')],
  });
  return outfile;
}

/** The run every case here is about; one id, the key of its one aggregate. */
const RUN = Schema.decodeUnknownSync(RunIdSchema)('ab12cd');
const OLDER = Schema.decodeUnknownSync(RunIdSchema)('ab12ce');
const NEWER = Schema.decodeUnknownSync(RunIdSchema)('ef56ab');
const CHILD = Schema.decodeUnknownSync(RunIdSchema)('ab12cf');

/** Wait on the fold's level until it holds a view `ready` accepts: the ref
 *  replays its current value on subscribe, so a view already there ends the
 *  wait at once and a later one ends it when the fold publishes it. */
const settle = (
  view: SubscriptionRef.SubscriptionRef<SessionView>,
  ready: (view: SessionView) => boolean,
) =>
  SubscriptionRef.changes(view).pipe(Stream.takeUntil(ready), Stream.runDrain);

/** Every row type: `readAggregate` reads only the types it is given. */
const ROW_TYPES = SessionRowSchema.members.map(
  (schema) => schema.fields.type.literal,
);

/** Every row of the aggregates `ids`, in commit order. */
const rowsOf = (
  db: Database['Service'],
  ...ids: readonly SessionRow['aggregateId'][]
) =>
  Effect.forEach(ids, (id) => db.readAggregate(id, 0, ROW_TYPES)).pipe(
    Effect.map((rows) => rows.flat().toSorted((x, y) => x.commit - y.commit)),
  );

/** A read refused on a stored row that does not decode: the typed failure a
 *  caller catches, its message naming the row's kind and commit (a pattern
 *  where the commit is not known). */
const rowCorrupt = (type: string, commit: number | string) => ({
  _tag: 'DatabaseReadFailed',
  message: expect.stringMatching(
    new RegExp(
      `'s ${type.replaceAll('.', String.raw`\.`)} row at commit ${commit} does not decode`,
    ),
  ),
});

const runStartRow = runStart(RUN);

/** The loop blocked on the request below: the phase the fold reads. */
const waiting: SessionRowDraft = {
  type: 'run.position',
  aggregateId: RUN,
  payload: { at: 'waiting', turn: 0 },
};

const requested: SessionRowDraft = {
  type: 'request.opened',
  aggregateId: RUN,
  requestId: 'req-1',
  payload: {
    kind: 'bash',
    data: {
      requestId: 'req-1',
      command: 'lake build',
      runId: RUN,
    },
  },
  answeredBy: 'bash',
};

/** The graph under test, as `sessionLayer` composes it without the runtime
 *  bits: the log seeded with `history` before the plane reads its anchor
 *  (the pre-cutover importer's position), the plane, the fold, and the
 *  three local sources. */
const graph = (
  history: readonly SessionRowDraft[],
  store: Layer.Layer<
    Database,
    never,
    SessionWorkspace | FileSystem.FileSystem
  > = databaseLayer('ephemeral').pipe(
    Layer.orDie,
    Layer.provide(storePluginsLayer),
    Layer.provide(nodePlatformLayer),
  ),
) => {
  const roots = createFakeWorkspaceRoots({ storagePath: '/workspace/framing' });
  const seeded = Layer.effectDiscard(
    Effect.gen(function* () {
      const log = yield* Database;
      yield* log.appendAll(history).pipe(Effect.orDie);
    }),
  );
  return SessionViewService.layer.pipe(
    Layer.provideMerge(sessionInputsLayer),
    Layer.provideMerge(
      sessionEventsLayer.pipe(
        Layer.provideMerge(seeded.pipe(Layer.provideMerge(store))),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        LocalRuntimeSource.layer,
        TextChunkSource.layer,
        TranscriptSubscriptions.layer,
      ),
    ),
    Layer.provide(Layer.succeed(SessionWorkspace)(roots)),
    Layer.provide(nodePlatformLayer),
  );
};

/** What a renderer would draw of each state: the run's status and the
 *  outstanding requests, at the state's cursor. */
function drawn(view: SessionView) {
  return {
    cursor: view.cursor,
    status: (() => {
      const run = view.runs.get(RUN);
      return run === undefined ? null : (run.outcome ?? run.position);
    })(),
    requests: view.requests.map((request) => request.requestId),
  };
}

/** The drawn states with the run present, consecutive repeats
 *  collapsed: a local-snapshot replay publishes a state nothing drawn
 *  differs in. */
function drawnSequence(states: Iterable<ReturnType<typeof drawn>>) {
  const seen: ReturnType<typeof drawn>[] = [];
  for (const next of states) {
    if (next.status === null) continue;
    const last = seen.at(-1);
    if (last && JSON.stringify(last) === JSON.stringify(next)) continue;
    seen.push(next);
  }
  return seen;
}

// The native CI coordinator may use a different CPU architecture from its worker.
beforeAll(() => {
  if (process.env.NATIVE_TARGET) {
    expect(`${process.platform}-${process.arch}`).toBe(
      process.env.NATIVE_TARGET.split('-').slice(0, 2).join('-'),
    );
  }
  if (process.env.TEXRA_TEST_NODE) {
    expect(realpathSync(process.execPath)).toBe(
      realpathSync(process.env.TEXRA_TEST_NODE),
    );
  }
});

describe('session events and view', () => {
  it.effect('publishes complete replay and finite live batches in order', () =>
    Effect.gen(function* () {
      const events = yield* SessionEvents;
      const view = yield* SessionViewService;
      // Every state the fold publishes, from before its marker until the
      // tail has folded both live publishes, drawn as it is published: a
      // view's run index is shared with the views after it. `changes`
      // replays the state it holds on subscribe: the empty view before the
      // marker, or the marker's state when the fold got there first.
      const states = yield* Effect.forkScoped(
        SubscriptionRef.changes(view.ref).pipe(
          Stream.map(drawn),
          Stream.takeUntil((next) => next.cursor >= 5),
          Stream.runCollect,
        ),
      );
      // The marker is out before the tail rows below are published, so
      // they reach the fold as the tail and not as part of its cold read.
      yield* settle(view.ref, (v) => v.runs.has(RUN));
      yield* events.transact((append) =>
        runStateAppend(append)([
          {
            type: 'request.decided',
            aggregateId: RUN,
            requestId: 'req-1',
            decision: { action: 'approve' },
          },
        ]),
      );
      yield* events.transact((append) =>
        runStateAppend(append)([
          {
            type: 'run.position',
            aggregateId: RUN,
            payload: { at: 'turn.begin', turn: 1 },
          },
        ]),
      );
      // The first state with the run in it has all of the history: no
      // state with the run started but not yet waiting, or waiting with
      // no approval, is ever published. The anchor is the seeded log's
      // level, so the history is under it and the tail repeats none of it.
      expect(drawnSequence(yield* Fiber.join(states))).toEqual([
        { cursor: 0, status: 'waiting', requests: ['req-1'] },
        { cursor: 5, status: 'running', requests: [] },
      ]);
    }).pipe(Effect.provide(graph([runStartRow, waiting, requested]))),
  );

  // A cold read holds the newest row of each listing key, so the wait a
  // fork cuts at has a key of its own: one newer position must not hide it.
  it.effect('keeps the fork point of a run read cold in a later turn', () =>
    Effect.gen(function* () {
      const view = yield* SessionViewService;
      yield* settle(view.ref, (v) => v.runs.has(RUN));
      const run = (yield* SubscriptionRef.get(view.ref)).runs.get(RUN);
      expect(run).toMatchObject({ position: 'running', forkPoint: 2 });
    }).pipe(
      Effect.provide(
        graph([
          runStartRow,
          waiting,
          {
            type: 'run.position',
            aggregateId: RUN,
            payload: { at: 'turn.begin', turn: 1 },
          },
        ]),
      ),
    ),
  );

  // No table stores a priced row's `usage` row: a display read takes it off
  // the priced row's stored JSON, so that read must agree with the codec.
  it.effect('reads a priced row back with its usage row, cold', () =>
    Effect.gen(function* () {
      const db = yield* Database;
      const rows = yield* db.readDisplay(0).pipe(
        Stream.runCollect,
        Effect.map((pages) => [...pages].flat()),
      );
      expect(rows.map((row) => [row.type, row.commit])).toEqual([
        ['run.start', 1],
        ['run.description', 2],
        ['usage', 2],
      ]);
      expect(rows.at(-1)).toMatchObject({
        usage: { inputTokens: 3, outputTokens: 4, cost: 0.5 },
      });
      expect(rows.at(-1)).not.toHaveProperty('usage.provider');
      const view = yield* SessionViewService;
      yield* settle(view.ref, (v) => v.runs.has(RUN));
      expect(
        (yield* SubscriptionRef.get(view.ref)).runs.get(RUN)?.usage.cost,
      ).toBe(0.5);
    }).pipe(
      Effect.provide(
        graph([
          runStartRow,
          {
            type: 'run.description',
            aggregateId: RUN,
            description: 'A title',
            by: 'model',
            usage: {
              inputTokens: 3,
              outputTokens: 4,
              cost: 0.5,
              responseTimeMs: 12,
              provider: 'openai-responses',
            },
          },
        ]),
      ),
    ),
  );

  it.effect('commits a detached job before the call returns', () =>
    Effect.gen(function* () {
      const events = yield* SessionEvents;
      const before = events.head();
      events.detach((append) =>
        runStateAppend(append)([
          {
            type: 'run.position',
            aggregateId: RUN,
            payload: { at: 'turn.begin', turn: 1 },
          },
        ]),
      );
      // The synchronous door's order is the call: nothing is left queued.
      expect(events.head()).toBeGreaterThan(before);
    }).pipe(Effect.provide(graph([runStartRow]))),
  );

  // Failure mode: a reader slower than the publisher made the publisher
  // keep every batch for it, without end; a bound must not cost it a row.
  it.effect(
    'reads from the store what a reader too far behind was not handed',
    () =>
      Effect.gen(function* () {
        const events = yield* SessionEvents;
        const view = yield* SessionViewService;
        // The view is following before the jobs, so it falls behind too.
        yield* settle(view.ref, (v) => v.runs.has(RUN));
        const position = (turn: number) => (append: Append) =>
          runStateAppend(append)([
            {
              type: 'run.position',
              aggregateId: RUN,
              payload: { at: 'turn.begin', turn },
            },
          ]);
        // The tail has read one live row, so it is subscribed, before the
        // jobs it falls behind on: every one commits before it runs again.
        const jobs = 1500;
        const start = events.head() + 1;
        const following = yield* Deferred.make<void>();
        const tail = yield* Effect.forkScoped(
          events.all(start - 1).pipe(
            Stream.tap(() => Deferred.succeed(following, undefined)),
            Stream.map((row) => row.commit),
            Stream.takeUntil((commit) => commit >= start + jobs),
            Stream.runCollect,
          ),
        );
        yield* events.transact(position(0));
        yield* Deferred.await(following);
        const idle = yield* events.subscribe;
        for (let turn = 1; turn <= jobs; turn++) events.detach(position(turn));
        expect(events.head()).toBe(start + jobs);
        const kept = (yield* PubSub.takeAll(idle)).flatMap((take) =>
          Exit.isExit(take) ? [] : take,
        );
        // The publisher kept a bounded number of batches, and the first one
        // left says how far back the reader's gap starts.
        expect(kept.length).toBeLessThan(jobs);
        expect(kept.at(0)?.from).toBe(start + jobs - kept.length);
        // Every row, once, in order.
        expect(yield* Fiber.join(tail)).toEqual(
          Array.from({ length: jobs + 1 }, (_, index) => start + index),
        );
        yield* settle(view.ref, (v) => v.cursor >= start + jobs);
      }).pipe(Effect.provide(graph([runStartRow]))),
  );

  it.effect('runs no job that reached the publisher after it closed', () =>
    Effect.gen(function* () {
      // The step budget decides where the scheduler first takes the
      // publishing fiber off: over these budgets, one suspends it between the
      // publisher's closed check and its transaction, where the close lands.
      for (let budget = 2; budget < 80; budget++) {
        const ranAfterClose = yield* Effect.gen(function* () {
          const events = yield* SessionEvents;
          let closed = false;
          let ranClosed = false;
          const publishing = yield* Effect.forkChild(
            events
              .transact(() =>
                Effect.sync(() => {
                  ranClosed = closed;
                }),
              )
              .pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget)),
            { startImmediately: true },
          );
          yield* events.close;
          closed = true;
          yield* Fiber.await(publishing);
          return ranClosed;
        }).pipe(Effect.provide(graph([runStartRow])));
        expect(ranAfterClose, `budget ${budget}`).toBe(false);
      }
    }),
  );
});

/**
 * The session owner: `closeSession` is how a session the `Sessions` map
 * holds ends.
 */
describe('Sessions owner', () => {
  it.live('drains the plugins at shutdown, not when one session closes', () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), 'texra-plugin-drain-'));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
      );
      const platform = nodePlatform({
        storageDir: join(directory, 'storage'),
        workspaceDir: directory,
      });
      const up = yield* Deferred.make<void>();
      let drains = 0;
      const counted = definePlugin({
        id: 'counted',
        processLayer: {
          layer: Layer.effectDiscard(Deferred.succeed(up, undefined)),
          drain: Effect.sync(() => {
            drains += 1;
          }),
        },
      });
      yield* Effect.gen(function* () {
        const sessions = yield* Sessions;
        yield* sessions.open(platform.roots, {
          persistent: true,
          answeredFromView: true,
        });
        yield* Deferred.await(up);
        yield* sessions.close(platform.roots);
        expect(drains).toBe(0);
        yield* sessions.closeAll;
        expect(drains).toBe(1);
      }).pipe(
        Effect.provide(
          Sessions.layer({
            platform,
            plugins: [counted],
            client: HARNESS_APP.client,
          }),
        ),
      );
    }),
  );
});

/**
 * The store itself: the event tables and the one write path that assigns
 * seq and commit. These assertions are the acceptance for the schema and
 * the publisher.
 */
describe('the session event table and its one publisher', () => {
  const roots: string[] = [];
  const workspace = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'texra-substrate-'));
    roots.push(root);
    return root;
  };
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const substrate = (storage: string) =>
    databaseLayer('persistent').pipe(
      Layer.provide(Layer.succeed(SessionWorkspace)({ storage })),
      Layer.provide(storePluginsLayer),
      Layer.provide(nodePlatformLayer),
      Layer.fresh,
    );

  const olderStart = runStart(OLDER);

  /** A connection of the kind another host process would open, on the file
   *  name a session root gives its database. */
  const reader = (storage: string): DatabaseSync => {
    const db = new DatabaseSync(join(storage, 'texra.db'));
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  };

  /** A store holding one run row, then re-stamped as another build's. */
  const storeOfFormat = (storage: string, format: number) =>
    Database.pipe(
      Effect.flatMap((database) => database.appendAll([runStartRow])),
      Effect.provide(substrate(storage)),
      Effect.andThen(
        Effect.sync(() => {
          const connection = reader(storage);
          try {
            connection.exec(`PRAGMA user_version = ${format}`);
          } finally {
            connection.close();
          }
        }),
      ),
    );

  it.effect('moves a truncated store aside and opens a fresh one', () =>
    // A store cut short (a copy that stopped part way) is kept beside the
    // fresh store, unchanged: cut inside its header SQLite reports it not a
    // database, and cut inside its first page, damaged at the first read.
    Effect.forEach([20, 100], (length) => {
      const storage = workspace();
      return Effect.gen(function* () {
        yield* storeOfFormat(storage, 101);
        const file = join(storage, 'texra.db');
        const truncated = readFileSync(file).subarray(0, length);
        rmSync(`${file}-wal`, { force: true });
        rmSync(`${file}-shm`, { force: true });
        writeFileSync(file, truncated);
        const opened = yield* Effect.gen(function* () {
          const database = yield* Database;
          return {
            movedAside: database.movedAside,
            commit: yield* database.currentCommit,
          };
        }).pipe(Effect.provide(substrate(storage)));
        expect(opened, `cut at ${length} bytes`).toEqual({
          movedAside: {
            path: file,
            aside: expect.stringMatching(/texra\.db\.corrupt-\d+$/),
          },
          commit: 0,
        });
        if (opened.movedAside == null) throw new Error('nothing moved aside');
        expect(readFileSync(opened.movedAside.aside)).toEqual(truncated);
        // Each open above released its store, so nothing holds the files:
        // Windows refuses to remove a file that a connection still holds.
        rmSync(storage, { recursive: true });
      });
    }),
  );

  it.effect(
    'fails a run history read of a row that does not decode, and the session still opens and lists it damaged',
    () => {
      const storage = workspace();
      const corrupt = (commit: number) =>
        Effect.sync(() => {
          const raw = reader(storage);
          try {
            raw.exec(
              `UPDATE event SET data = '{}' WHERE "commit" = ${commit};`,
            );
          } finally {
            raw.close();
          }
        });
      return Effect.gen(function* () {
        // Any undecodable row of a run damages it, not only its start. The
        // store is held while open, so the row is damaged between opens.
        const closed: SessionRowDraft = {
          type: 'followup.closed',
          aggregateId: runStartRow.aggregateId,
        };
        yield* Effect.flatMap(Database, (db) =>
          db.appendAll([runStartRow, olderStart, waiting, closed]),
        ).pipe(Effect.provide(substrate(storage)));
        // A record's fact that no one row states is read from the row that
        // set it: that row broken since fails the record's read.
        yield* Effect.sync(() => {
          const raw = reader(storage);
          try {
            raw.exec(`UPDATE event SET data = '{' WHERE "commit" = 4;`);
          } finally {
            raw.close();
          }
        });
        expect(
          yield* Effect.flip(
            Effect.flatMap(Database, (db) =>
              db.readRunRecord(runStartRow.aggregateId),
            ).pipe(Effect.provide(substrate(storage))),
          ),
        ).toMatchObject(rowCorrupt('followup.closed', 4));
        yield* corrupt(3);
        yield* Effect.gen(function* () {
          const db = yield* Database;
          expect(
            yield* Effect.flip(
              db.readAggregate(runStartRow.aggregateId, 0, ROW_TYPES),
            ),
          ).toMatchObject(rowCorrupt('run.position', 3));
        }).pipe(Effect.provide(substrate(storage)));
        // A listing built at open over that row (a store that held none
        // yet) lists it as the run's unread row, so the record's read fails
        // on it, never answers without it.
        yield* Effect.sync(() => {
          const raw = reader(storage);
          try {
            raw.exec(`DELETE FROM listing_entry;
              DELETE FROM projection_state WHERE name = 'listing';`);
          } finally {
            raw.close();
          }
        });
        expect(
          yield* Effect.flip(
            Effect.flatMap(Database, (db) =>
              db.readRunRecord(runStartRow.aggregateId),
            ).pipe(Effect.provide(substrate(storage))),
          ),
        ).toMatchObject(rowCorrupt('run.position', 3));
        // A fresh session over the store opens: the healthy run lists, and
        // the damaged one lists too, shown damaged and read-only, with
        // delete its one way out of the list.
        yield* Effect.gen(function* () {
          const view = yield* SessionViewService;
          yield* settle(
            view.ref,
            (v) =>
              v.runs.has(OLDER) &&
              v.runs.get(RUN)?.statusNotice?.kind === 'damaged',
          );
          expect(
            (yield* SubscriptionRef.get(view.ref)).runs.get(RUN),
          ).toMatchObject({
            statusNotice: { kind: 'damaged' },
            actions: ['delete', 'openRunStorage', 'export', 'copy'],
          });
        }).pipe(
          Effect.provide(graph([], substrate(storage).pipe(Layer.orDie))),
          Effect.scoped,
        );
        // A record decision reads strictly: a damaged start fails it, never
        // a placeholder that reads as an unopened run.
        yield* corrupt(1);
        expect(
          yield* Effect.flip(
            Effect.flatMap(Database, (db) =>
              db.readRunRecord(runStartRow.aggregateId),
            ).pipe(Effect.provide(substrate(storage))),
          ),
        ).toMatchObject(rowCorrupt('run.start', 1));
      });
    },
  );

  it.effect('refuses a store of a newer schema and changes nothing', () => {
    const storage = workspace();
    const format = 9999;
    return Effect.gen(function* () {
      yield* storeOfFormat(storage, format);
      const failure = yield* Effect.flip(
        Database.pipe(Effect.provide(substrate(storage))),
      );
      expect(failure._tag).toBe('DatabaseOpenFailed');
      expect(failure.message).toContain('a newer build opens it');
      const stored = reader(storage);
      try {
        expect(stored.prepare('PRAGMA user_version').get()).toEqual({
          user_version: format,
        });
        expect(
          stored.prepare('SELECT count(*) AS rows FROM event').get(),
        ).toEqual({ rows: 1 });
      } finally {
        stored.close();
      }
    });
  });

  it.effect(
    'assigns a dense seq per aggregate and one commit order across them',
    () => {
      const storage = workspace();
      return Effect.gen(function* () {
        const db = yield* Database;
        const now = yield* Clock.currentTimeMillis;
        const first = yield* db.appendAll([runStartRow, olderStart, waiting]);
        const second = yield* db.appendAll([requested]);

        expect(
          [...first, ...second].map((e) => [e.aggregateId, e.seq, e.commit]),
        ).toEqual([
          [RUN, 1, 1],
          [OLDER, 1, 2],
          [RUN, 2, 3],
          [RUN, 3, 4],
        ]);
        // `at` is the layer's own clock: no caller passes it.
        expect(first.every((e) => e.at === now)).toBe(true);
        expect(yield* db.currentCommit).toBe(4);
        // A run begins with exactly one `run.start` (decision 9): a second
        // creation of a live run is the caller's defect, and the sequence it
        // allocated rolls back with it.
        const again = yield* Effect.exit(db.appendAll([runStartRow]));
        expect(Exit.isFailure(again) && Cause.hasDies(again.cause)).toBe(true);
        expect((yield* db.appendAll([waiting]))[0]?.seq).toBe(4);
        expect(yield* db.currentCommit).toBe(5);
      }).pipe(Effect.provide(substrate(storage)));
    },
  );

  it.effect('fails the read of a value that no longer decodes, typed', () => {
    const storage = workspace();
    return Effect.gen(function* () {
      const db = yield* Database;
      const name = 'regression-family';
      yield* db.values.modify({ name, schema: Schema.String }, ['k'], () =>
        Result.succeed(['written', { k: 'a string' }] as const),
      );
      // The same family read with a schema its stored value fails.
      const failed = yield* Effect.flip(
        db.values.get({ name, schema: Schema.Finite }, 'k'),
      );
      expect(failed._tag).toBe('DatabaseReadFailed');
    }).pipe(Effect.provide(substrate(storage)));
  });

  it.effect('reopens at the committed ordinal and never reuses one', () => {
    const storage = workspace();
    const append = Effect.gen(function* () {
      const db = yield* Database;
      return yield* db.appendAll([runStartRow, waiting]);
    }).pipe(Effect.provide(substrate(storage)));
    return Effect.gen(function* () {
      yield* append;
      // A second host process deletes the whole aggregate: the foreign-key
      // cascade takes its events with it, and the AUTOINCREMENT high-water mark
      // stays where it was, so no cursor already handed out is invalidated.
      yield* Effect.sync(() => {
        const raw = reader(storage);
        try {
          raw.exec('PRAGMA foreign_keys = ON');
          raw
            .prepare(
              "DELETE FROM event_sequence WHERE kind = 'run' AND logical_id = ?",
            )
            .run(RUN);
          expect(raw.prepare('SELECT COUNT(*) AS n FROM event').get()?.n).toBe(
            0,
          );
        } finally {
          raw.close();
        }
      });

      const reopened = yield* Effect.gen(function* () {
        const db = yield* Database;
        return {
          commit: yield* db.currentCommit,
          next: yield* db.appendAll([runStartRow]),
        };
      }).pipe(Effect.provide(substrate(storage)));

      expect(reopened.commit).toBe(2);
      expect(reopened.next.map((e) => e.commit)).toEqual([3]);
    });
  });

  /**
   * Outlined strings: a long string is stored once in `event_blob` and the
   * row holds a reference. Failure modes: a string of 4 KB or
   * more reads back changed (a lone surrogate among them), or its object's
   * key order does; a payload's own `$b` or `$$b` key reads as a reference or
   * loses a `$`; the same string is stored once per row, not once per store;
   * a damaged blob reads as text instead of blocking its aggregate; deleting
   * a run collects a blob another run still references, or keeps one nobody
   * does.
   */
  it.effect(
    'stores a large string once, compressed, and reads it exact',
    () => {
      const storage = workspace();
      const shared = `${'\\frac{a}{b} — ünïcode\n'.repeat(300)}end`;
      const solo = `\uD800${'y'.repeat(4096)}`;
      const card = (run: RunId, args: object): SessionRowDraft => ({
        type: 'tool.start',
        aggregateId: run,
        logId: 'call-1',
        toolName: 'script',
        input: { script: shared, args: { ...args, $b: 'mine', $$b: [shared] } },
      });
      const drafts = [
        runStartRow,
        olderStart,
        card(RUN, { solo }),
        card(OLDER, {}),
      ];
      const count = (table: string) =>
        Effect.sync(() =>
          readStoreSnapshot(
            storage,
            (raw) => raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
          ),
        );
      const remove = (run: RunId) =>
        Effect.gen(function* () {
          const db = yield* Database;
          yield* db.appendAll([
            {
              type: 'run.removed',
              aggregateId: run,
            },
          ]);
          yield* (yield* deletionCollector(db, storage)).pending;
        });
      const opened = Layer.merge(substrate(storage), nodePlatformLayer);
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const db = yield* Database;
          yield* db.appendAll(drafts);
          const cards = (yield* rowsOf(
            db,
            runStartRow.aggregateId,
            olderStart.aggregateId,
          )).filter((event) => event.type === 'tool.start');
          expect(cards.map(({ input }) => JSON.stringify(input))).toEqual(
            drafts
              .slice(2)
              .map((draft) => JSON.stringify('input' in draft && draft.input)),
          );
          const stored = readStoreSnapshot(storage, (raw) => ({
            data: raw
              .prepare("SELECT data FROM event WHERE type = 'tool.start'")
              .all()
              .map((row) => String(row.data)),
            sizes: raw
              .prepare('SELECT length(value) AS n FROM blob ORDER BY n DESC')
              .all()
              .map((row) => Number(row.n)),
          }));
          expect(stored.data.every((text) => !text.includes(shared))).toBe(
            true,
          );
          expect(stored.data[0]).toContain('"$$b":"mine","$$$b":[{"$b":"');
          expect(stored.sizes).toHaveLength(2);
          expect(stored.sizes[0]).toBeLessThan(shared.length / 10);
          yield* remove(RUN);
          expect(yield* count('blob')).toBe(1);
          expect(yield* count('event_blob')).toBe(1);
        }).pipe(Effect.provide(opened));
        // The store is held while open: the blob is damaged between opens.
        yield* Effect.sync(() => {
          const raw = reader(storage);
          try {
            raw.exec("UPDATE blob SET value = X'28b52ffd0000'");
          } finally {
            raw.close();
          }
        });
        yield* Effect.gen(function* () {
          const fresh = yield* Database;
          expect(
            yield* Effect.flip(fresh.readAggregate(OLDER, 0, ROW_TYPES)),
          ).toMatchObject(rowCorrupt('tool.start', String.raw`\d+`));
          yield* remove(OLDER);
          expect(yield* count('blob')).toBe(0);
        }).pipe(Effect.provide(opened));
      });
    },
  );

  it.effect('closes a run tree with its dependents and collects it', () => {
    const storage = workspace();
    return Effect.gen(function* () {
      const first = yield* Database;
      const root = runStartRow.aggregateId;
      // A child run hangs under the run that launched it.
      const child = runStart(CHILD, { parent: { id: RUN, call: null } });
      // Every aggregate this case writes, the unrelated run's among them.
      const stored = rowsOf(first, root, olderStart.aggregateId, CHILD, NEWER);
      const initial = yield* first.appendAll([runStartRow, olderStart, child]);
      const initialCommit = initial[0]?.commit;
      assert(initialCommit !== undefined, 'nothing appended');
      expect((yield* first.aggregateState([CHILD]))[0]?.parentId).toBe(root);
      expect(yield* stored).toEqual(initial);
      const committed = [
        ...(yield* first.appendAll([waiting])),
        ...(yield* first.runRemoval(root, initialCommit)),
      ];
      expect(committed.at(-1)).toMatchObject({
        type: 'run.removed',
        runIds: [RUN, CHILD],
      });
      expect((yield* first.readAggregate(root, 0, ROW_TYPES)).at(-1)).toEqual(
        committed.at(-1),
      );
      expect(committed.map((row) => [row.seq, row.commit])).toEqual([
        [2, 4],
        [3, 5],
      ]);
      expect(
        (yield* first.aggregateState([root, CHILD])).every((row) => row.closed),
      ).toBe(true);
      // A late row of the closed child refuses its writer.
      expect(
        (yield* Effect.flip(
          first.appendAll([{ type: 'run.activate', aggregateId: CHILD }]),
        ))._tag,
      ).toBe('DatabaseAggregateClosed');
      expect(yield* first.currentCommit).toBe(5);
      const tombstone = committed.at(-1);
      assert(tombstone?.type === 'run.removed', 'no tombstone');
      // What removing a run directory raises when the directory refuses it.
      const cleanupError = PlatformError.systemError({
        _tag: 'PermissionDenied',
        module: 'FileSystem',
        method: 'remove',
        description: 'The generated directory is not writable.',
      });
      // A failed cleanup keeps the tombstone for the next pass.
      expect(
        yield* Effect.flip(
          first.deletions.collect(tombstone, () => Effect.fail(cleanupError)),
        ),
      ).toBe(cleanupError);
      expect((yield* first.readAggregate(root, 0, ROW_TYPES)).at(-1)).toEqual(
        tombstone,
      );
      const unrelated = runStart(NEWER);
      yield* first.deletions.collect(tombstone, (ids) =>
        Effect.gen(function* () {
          expect(ids).toEqual([RUN, CHILD]);
          // Cleanup runs outside the database write permit: unrelated
          // runs remain writable while generated files are removed.
          yield* first.appendAll([unrelated]);
        }),
      );
      expect(yield* first.aggregateState([root, CHILD])).toEqual([]);
      // Collecting it again, as the open's pass would, is a no-op.
      const again = vi.fn(() => Effect.void);
      yield* first.deletions.collect(tombstone, again);
      expect(again).not.toHaveBeenCalled();
      expect((yield* stored).map((event) => event.aggregateId)).toEqual([
        olderStart.aggregateId,
        unrelated.aggregateId,
      ]);
      // A removal admitted against the run's earlier lifetime is refused as
      // such, never as a failed write.
      const replacement = yield* first.appendAll([runStartRow]);
      expect(
        (yield* Effect.flip(first.runRemoval(root, initialCommit)))._tag,
      ).toBe('RunChanged');
      expect(yield* first.readAggregate(root, 0, ROW_TYPES)).toEqual(
        replacement,
      );
      expect((yield* first.aggregateState([root]))[0]?.closed).toBe(false);
      // The production worker removes the recorded generated directory,
      // never a sibling or a linked file outside that directory.
      const runs = join(storage, WORKSPACE_STORAGE_LAYOUT.runs);
      const outside = join(storage, 'outside-runs');
      yield* Effect.sync(() => {
        mkdirSync(outside);
        writeFileSync(join(outside, 'keep.tex'), 'outside');
        symlinkSync(outside, runs, 'dir');
      });
      yield* first.appendAll([
        { type: 'run.removed', aggregateId: unrelated.aggregateId },
      ]);
      yield* (yield* deletionCollector(first, storage)).pending;
      expect(existsSync(join(outside, 'keep.tex'))).toBe(true);
      expect(
        yield* first.aggregateState([unrelated.aggregateId]),
      ).toMatchObject([{ closed: true }]);
      yield* Effect.sync(() => rmSync(runs));
      const generated = join(storage, WORKSPACE_STORAGE_LAYOUT.runs, 'ef56ab');
      const sibling = join(storage, WORKSPACE_STORAGE_LAYOUT.runs, 'fe78bc');
      const accepted = join(storage, 'accepted.tex');
      yield* Effect.sync(() => {
        mkdirSync(generated, { recursive: true });
        mkdirSync(sibling);
        writeFileSync(join(generated, 'output.tex'), 'generated');
        writeFileSync(accepted, 'accepted workspace output');
        symlinkSync(accepted, join(generated, 'reference.tex'));
      });
      yield* (yield* deletionCollector(first, storage)).pending;
      expect(existsSync(generated)).toBe(false);
      expect(existsSync(sibling)).toBe(true);
      expect(existsSync(accepted)).toBe(true);
      expect(yield* first.aggregateState([unrelated.aggregateId])).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(substrate(storage), nodePlatformLayer)));
  });

  it.effect(
    "a run's removal closes its child runs and names their files",
    () => {
      const storage = workspace();
      const runId = Schema.decodeUnknownSync(RunIdSchema);
      const [parent, child, grandchild, deletedFirst] = [
        'a1a1a1',
        'b2b2b2',
        'c3c3c3',
        'd4d4d4',
      ].map((id) => runId(id));
      const under = (id: RunId, over: RunId) =>
        runStart(id, { parent: { id: over, call: null } });
      return Effect.gen(function* () {
        const store = yield* Database;
        const [started] = yield* store.appendAll([
          runStart(parent),
          under(child, parent),
          under(grandchild, child),
          under(deletedFirst, parent),
        ]);
        assert(started !== undefined, 'nothing appended');
        // A child deleted on its own first, its collection still pending.
        const [childStart] = yield* store.aggregateState([deletedFirst]);
        assert(childStart?.startCommit != null, 'no child start');
        const [childRemoved] = yield* store.runRemoval(
          deletedFirst,
          childStart.startCommit,
        );
        const [removed] = yield* store.runRemoval(parent, started.commit);
        // Each marker names the files it alone cleans up.
        expect([childRemoved, removed]).toMatchObject([
          { type: 'run.removed', runIds: [deletedFirst] },
          { type: 'run.removed', runIds: [parent, child, grandchild] },
        ]);
        expect(
          (yield* store.aggregateState([child, grandchild])).map(
            (state) => state.closed,
          ),
        ).toEqual([true, true]);
        assert(
          childRemoved?.type === 'run.removed' &&
            removed?.type === 'run.removed',
          'no deletion markers',
        );
        // The parent's collection first leaves the earlier marker's run to
        // that marker, which still collects it.
        const cleaned: (readonly RunId[])[] = [];
        const record = (ids: readonly RunId[]) =>
          Effect.sync(() => void cleaned.push(ids));
        yield* store.deletions.collect(removed, record);
        yield* store.deletions.collect(childRemoved, record);
        expect(cleaned).toEqual([[parent, child, grandchild], [deletedFirst]]);
        expect(
          yield* store.aggregateState([parent, child, deletedFirst]),
        ).toEqual([]);
      }).pipe(Effect.provide(substrate(storage)));
    },
  );

  /**
   * Two OS processes on one file: a session holds its store exclusively,
   * so a second process opening it is refused at open with the message a
   * host shows, and writes nothing. Failure modes: the second process opens
   * and appends (two writers on one log); it waits in SQLite's busy handler
   * instead of failing; the holder's own appends are disturbed; and a
   * store nothing holds is refused.
   */
  it.live(
    'refuses a store another OS process holds',
    () => {
      const storage = workspace();
      const own = RUN;
      const theirs = OLDER;
      const writer = (): Effect.Effect<{
        code: number | null;
        stderr: string;
      }> =>
        Effect.promise(async () => {
          const bundled = await bundleStoreWriter(storage);
          const child = spawn(process.execPath, [bundled, storage, OLDER], {
            stdio: ['ignore', 'inherit', 'pipe'],
          });
          let stderr = '';
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          const code = await new Promise<number | null>((done) =>
            child.on('exit', (exit) => done(exit)),
          );
          return { code, stderr };
        });
      return Effect.gen(function* () {
        const refused = yield* Effect.gen(function* () {
          const db = yield* Database;
          yield* db.appendAll([runStartRow]);
          const refused = yield* writer();
          expect(yield* db.appendAll([waiting])).toMatchObject([{ commit: 2 }]);
          expect(yield* db.aggregateState([theirs])).toEqual([]);
          expect((yield* rowsOf(db, own)).map((row) => row.commit)).toEqual([
            1, 2,
          ]);
          return refused;
        }).pipe(Effect.provide(substrate(storage)));
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain(STORE_HELD_MESSAGE);
        // Closed here, the store is the next process's.
        const free = yield* writer();
        expect(free, free.stderr).toMatchObject({ code: 0 });
        expect(
          yield* Effect.flatMap(Database, (db) =>
            db.aggregateState([theirs]),
          ).pipe(Effect.provide(substrate(storage))),
        ).toMatchObject([{ closed: false }]);
      });
    },
    30_000,
  );
});
