/**
 * The session graph's durable boundary (PRD one-fold-three-renderers, 7.1
 * and 7.2, acceptance for lane 2): replay framing and the live-owner
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
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Third-party imports
import { it } from '@effect/vitest';
import { build } from 'esbuild';
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';

import { afterAll, beforeAll, describe, expect, vi } from 'vitest';

import { Sessions } from '@texra-ai/harness';
import { nodePlatform, nodePlatformServices } from '@texra-ai/harness/node';

vi.mock('@effect/sql-sqlite-node/SqliteClient', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@effect/sql-sqlite-node/SqliteClient')
  >()),
}));

import {
  qualifyAggregateId,
  RUN_PHASE,
  type RunId,
  RunIdSchema,
  type SessionEvent,
  type SessionEventDraft,
  type SessionView,
} from '@texra-ai/harness/schemas';
import { LocalRuntimeStateSchema } from '@texra-ai/harness/transcript';
import { sessionEventsLayer } from '@agent/runtime/SessionEvents';
import { makeRunHistory } from '@agent/runtime/RunHistory';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { sessionInputsLayer } from '@controllers/session/sessionInputs';
import { SessionViewService } from '@controllers/session/SessionView';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from '@controllers/session/sessionSources';
import { makeSessionStore } from '@controllers/session/sessionStore';
import { deletionCollector } from '@controllers/session/deletionCleanup';
import {
  databaseLayer,
  STORE_HELD_MESSAGE,
} from '@controllers/session/Database';
import {
  runStateAppend,
  RunHistory,
  RunHistoryRefused,
  type RunCell,
} from '@shared/session/runHistory';
import { SessionEventSchema } from '@shared/schemas';
import { Database } from '@shared/session/database';
import type { RunHistoryDraft } from '@shared/session/runState';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import {
  nodeSpawnerLayer,
  scriptedSpawnerLayer,
} from '@test/support/childProcessTestLayer';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { readStoreSnapshot } from '@test/support/storeFaults';
import { storePluginsLayer } from '@test/support/texraApp';
import { inquiryThreadRow } from '@test/support/inquiryThreadRow';
import { REPO_ROOT } from '@test/support/repoScan';
import type { InquiryThreadSummary } from '@texra/shared/plugins/externalInquiry';
import type { LeanLanguageServices } from '@texra/tools/lean/leanLanguageServices';
import { ToolRegistry, toolTable } from '@tools/toolTable';
import type { ProcessProbe } from '@texra-ai/harness/node';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  platform: vi.fn(() => process.platform),
}));
vi.mock('@texra/tools/lean/direct/leanServerPool', async () => {
  const { Layer } = await import('effect');
  const { LeanLanguageServices } =
    await import('@texra/tools/lean/leanLanguageServices');
  return {
    directLeanLanguageServices: () =>
      Layer.succeed(LeanLanguageServices)(
        // cast: no case in this suite reaches the Lean language services.
        {} as LeanLanguageServices['Service'],
      ),
  };
});

/** A second OS process's writer: this build's `Database` over the store at
 *  `storage`, as `owner`, creating `run`. */
const STORE_WRITER = `
import { Effect, Layer } from 'effect';
import { databaseLayer } from '@controllers/session/Database';
import { ToolRegistry, toolTable } from '@tools/toolTable';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { nodePlatformServices } from '@platform/defaults/nodePlatform';
import { qualifyAggregateId } from '@shared/schemas';
import { Database } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';

const [storage, owner, run] = process.argv.slice(2);
const append = Effect.flatMap(Database, (db) =>
  db.appendAll([{ type: 'run.start', aggregateId: qualifyAggregateId('run', run),
    identity: { kind: 'agent', agent: 'chat' }, userFollowUpSupport: 'unsupported',
    parent: null, provenance: null }]));
await Effect.runPromise(append.pipe(Effect.provide(databaseLayer('persistent').pipe(
  Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
  Layer.provide(ProcessIdentity.layer(owner)),
  Layer.provide(Layer.succeed(ToolRegistry)(toolTable([]))),
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

/** Two processes' owner ids: live pids (this one and its parent) whose start
 *  identity was never read, so no proof ties either record to a process and
 *  each reads `unprovable` to the other. */
const SELF = JSON.stringify(['test-host', process.pid, null]);
const OTHER = JSON.stringify(['test-host', process.ppid, null]);
/** The run every case here is about; one id, the key of its one aggregate. */
const RUN = Schema.decodeUnknownSync(RunIdSchema)('ab12cd');
const OLDER = Schema.decodeUnknownSync(RunIdSchema)('ab12ce');
const NEWER = Schema.decodeUnknownSync(RunIdSchema)('ef56ab');

/** Wait on the fold's level until it holds a view `ready` accepts: the ref
 *  replays its current value on subscribe, so a view already there ends the
 *  wait at once and a later one ends it when the fold publishes it. */
const settle = (
  view: SubscriptionRef.SubscriptionRef<SessionView>,
  ready: (view: SessionView) => boolean,
) =>
  SubscriptionRef.changes(view).pipe(Stream.takeUntil(ready), Stream.runDrain);

/** Every row type: `readAggregate` reads only the types it is given. */
const ROW_TYPES = SessionEventSchema.members.map(
  (schema) => schema.fields.type.literal,
);

/** Every row of the aggregates `ids`, in commit order. */
const rowsOf = (
  db: Database['Service'],
  ...ids: readonly SessionEvent['aggregateId'][]
) =>
  Effect.forEach(ids, (id) => db.readAggregate(id, 0, ROW_TYPES)).pipe(
    Effect.map((rows) => rows.flat().toSorted((x, y) => x.commit - y.commit)),
  );

const runStart: SessionEventDraft = {
  type: 'run.start',
  aggregateId: qualifyAggregateId('run', RUN),
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'unsupported',
  parent: null,
  provenance: null,
};

/** The loop parked on the request below: the phase the fold reads. */
const waiting: SessionEventDraft = {
  type: 'run.position',
  aggregateId: qualifyAggregateId('run', RUN),
  payload: { family: 'toolUse', at: 'waiting' },
};

const requested: SessionEventDraft = {
  type: 'request.opened',
  aggregateId: qualifyAggregateId('run', RUN),
  requestId: 'req-1',
  payload: {
    kind: 'bash',
    data: {
      requestId: 'req-1',
      command: 'lake build',
      allowBypass: true,
      runId: RUN,
    },
  },
};

/** The graph under test, as `sessionLayer` composes it without the runtime
 *  bits: the log seeded with `history` before the plane reads its anchor
 *  (the pre-cutover importer's position), the plane, the fold, and the
 *  three local sources. */
const graph = (
  history: readonly SessionEventDraft[],
  store: Layer.Layer<
    Database,
    never,
    ProcessIdentity | WorkspaceRoots | ProcessProbe
  > = databaseLayer('ephemeral').pipe(
    Layer.orDie,
    Layer.provide(storePluginsLayer),
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
    Layer.provide(Layer.succeed(WorkspaceRoots)(roots)),
    Layer.provide(ProcessIdentity.layer(SELF)),
    Layer.provide(nodePlatformLayer),
  );
};

/** The run history as the session builds it: over its store's log, whose
 *  tail is delivered, so a batch returns once the view folded it. */
const runHistoryOverStore = Layer.effect(
  RunHistory,
  Effect.gen(function* () {
    const store = yield* makeSessionStore('/workspace/framing');
    yield* store.deliver(() => {});
    return makeRunHistory(store.log);
  }),
).pipe(Layer.provide(ProcessIdentity.layer(SELF)));

/** What a renderer would draw of each state: the run's status and the
 *  outstanding requests, at the state's cursor. */
function drawn(view: SessionView) {
  return {
    cursor: view.cursor,
    status: view.runs.get(RUN)?.status ?? null,
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
            aggregateId: qualifyAggregateId('run', RUN),
            requestId: 'req-1',
            decision: { action: 'approve' },
          },
        ]),
      );
      yield* events.transact((append) =>
        runStateAppend(append)([
          {
            type: 'run.position',
            aggregateId: qualifyAggregateId('run', RUN),
            payload: { family: 'toolUse', at: 'turn.begin', turn: 1 },
          },
        ]),
      );
      // The first state with the run in it has all of the history: no
      // state with the run started but not yet waiting, or waiting with
      // no approval, is ever published. The anchor is the seeded log's
      // level, so the history is under it and the tail repeats none of it.
      expect(drawnSequence(yield* Fiber.join(states))).toEqual([
        { cursor: 0, status: RUN_PHASE.WAITING, requests: ['req-1'] },
        { cursor: 5, status: RUN_PHASE.RUNNING, requests: [] },
      ]);
    }).pipe(Effect.provide(graph([runStart, waiting, requested]))),
  );
});

/**
 * The session owner: `closeSession` is how a session the `Sessions` map
 * holds ends.
 */
describe('Sessions owner', () => {
  // A missing plugin must not clear a durable request whose answer it delivers.
  it.live('keeps a plugin request pending when its plugin is absent', () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), 'texra-missing-plugin-'));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
      );
      const platform = nodePlatform({
        agentsDir: join(directory, 'agents'),
        storageDir: join(directory, 'storage'),
        workspaceDir: directory,
      });
      mkdirSync(join(directory, 'agents'));
      yield* Effect.gen(function* () {
        const db = yield* Database;
        yield* db.appendAll([
          runStart,
          waiting,
          {
            type: 'request.opened',
            aggregateId: qualifyAggregateId('run', RUN),
            requestId: 'plugin-answer',
            payload: {
              kind: 'plugin',
              plugin: 'example',
              blocksCaller: false,
              answers: ['answer'],
              data: { requestId: 'plugin-answer', runId: RUN },
            },
          },
        ]);
      }).pipe(
        Effect.provide(
          databaseLayer('persistent').pipe(
            Layer.provide(Layer.succeed(WorkspaceRoots)(platform.roots)),
            Layer.provide(ProcessIdentity.layer(SELF)),
            Layer.provide(Layer.succeed(ToolRegistry)(toolTable([]))),
            Layer.provide(nodePlatformServices),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const session = yield* (yield* Sessions).open(platform.roots, {
          persistent: true,
          host: {},
        });
        expect((yield* session.view.read([RUN])).requests).toHaveLength(1);
        yield* Stream.runHead(
          Stream.filter(session.view.changes, (view) =>
            view.requests.some(
              ({ requestId }) => requestId === 'plugin-answer',
            ),
          ),
        );
        const error = yield* Effect.flip(
          session.request({
            kind: 'request.decide',
            runId: RUN,
            requestId: 'plugin-answer',
            decision: { action: 'answer', answer: 'Preserve this answer.' },
          }),
        );
        expect(error).toMatchObject({
          _tag: 'Unavailable',
          reason: expect.stringContaining('example'),
        });
        expect((yield* session.view.read([RUN])).requests).toHaveLength(1);
      }).pipe(Effect.provide(Sessions.layer({ platform, plugins: [] })));
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

  const substrate = (
    storage: string,
    owner = SELF,
    spawner: Layer.Layer<ChildProcessSpawner> = nodeSpawnerLayer,
  ) =>
    databaseLayer('persistent').pipe(
      Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
      Layer.provide(storePluginsLayer),
      Layer.provide(ProcessIdentity.layer(owner)),
      Layer.provide(spawner),
      Layer.provide(nodePlatformLayer),
      Layer.fresh,
    );

  const olderStart: SessionEventDraft = {
    ...runStart,
    aggregateId: qualifyAggregateId('run', OLDER),
  };

  /** A connection of the kind another host process would open, on the file
   *  name a session root gives its database. */
  const reader = (storage: string): DatabaseSync => {
    const db = new DatabaseSync(join(storage, 'texra.db'));
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  };

  it.effect('rejects a remote mount before creating the database', () => {
    const storage = workspace();
    const resolved = realpathSync.native(storage);
    const system = vi.mocked(os.platform).mockReturnValue('darwin');
    const mount = scriptedSpawnerLayer(() => ({
      stdout: `server:/paper on ${resolved} (nfs, nodev)\n`,
    }));
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Database.pipe(Effect.provide(substrate(storage, SELF, mount.layer))),
      );
      expect(failure._tag).toBe('DatabaseOpenFailed');
      expect(String(failure.cause)).toContain('verified local filesystem');
      expect(existsSync(join(storage, 'texra.db'))).toBe(false);
    }).pipe(Effect.ensuring(Effect.sync(() => system.mockRestore())));
  });

  /** A store holding one run row, then re-stamped as another build's. */
  const storeOfFormat = (storage: string, format: number) =>
    Database.pipe(
      Effect.flatMap((database) => database.appendAll([runStart])),
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

  /** A store as a pre-1.0 build left it: its `event` and `event_sequence`
   *  keyed by `aggregate_id`, one event, one setting and one line of input
   *  history, stamped `format`. */
  const legacyStore = (storage: string, format: number) =>
    Effect.sync(() => {
      const connection = reader(storage);
      try {
        connection.exec(`
          CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER);
          CREATE TABLE event ("commit" INTEGER PRIMARY KEY, aggregate_id TEXT, data TEXT);
          CREATE TABLE current_value (family TEXT, key TEXT, value TEXT);
          CREATE TABLE input_history (id INTEGER PRIMARY KEY, at INTEGER, value TEXT);
          INSERT INTO event_sequence VALUES ('["run","ab12cd"]', 1);
          INSERT INTO event VALUES (1, '["run","ab12cd"]', '{}');
          INSERT INTO current_value VALUES ('setting', 'k', '1');
          INSERT INTO input_history VALUES (1, 1, 'an earlier prompt');
          PRAGMA user_version = ${format};
        `);
      } finally {
        connection.close();
      }
    });

  it.effect('retires a store written before 1.0 whole and starts clean', () => {
    const storage = workspace();
    const format = 44;
    return Effect.gen(function* () {
      yield* legacyStore(storage, format);
      const reopenedStore = yield* Database.pipe(
        Effect.flatMap((database) =>
          Effect.map(database.readListing(), (listing) => ({
            listing,
            movedAside: database.movedAside,
          })),
        ),
        Effect.provide(substrate(storage)),
      );
      const asidePath = join(realpathSync.native(storage), 'texra.db.pre1');
      expect(reopenedStore).toEqual({
        listing: [],
        movedAside: {
          path: join(storage, 'texra.db'),
          aside: asidePath,
          reason: 'pre-1.0',
        },
      });
      const aside = new DatabaseSync(asidePath);
      try {
        expect(aside.prepare('PRAGMA user_version').get()).toEqual({
          user_version: format,
        });
        expect(
          aside.prepare('SELECT count(*) AS rows FROM event').get(),
        ).toEqual({ rows: 1 });
      } finally {
        aside.close();
      }
      // Nothing is kept, current values and input history included, and
      // the file carries the 1.0 header.
      const reopened = reader(storage);
      try {
        expect(reopened.prepare('PRAGMA user_version').get()).toEqual({
          user_version: 101,
        });
        expect(reopened.prepare('PRAGMA auto_vacuum').get()).toEqual({
          auto_vacuum: 2,
        });
        for (const table of ['current_value', 'input_history'])
          expect(
            reopened.prepare(`SELECT count(*) AS rows FROM ${table}`).get(),
          ).toEqual({ rows: 0 });
      } finally {
        reopened.close();
      }
    });
  });

  // Another tool's database at the store's path: unstamped, or stamped with
  // its own id even at the 1.0 schema's number.
  for (const stamp of [
    '',
    'PRAGMA application_id = 1234; PRAGMA user_version = 101;',
  ])
    it.effect(
      `refuses another application's SQLite file untouched (${stamp || 'unstamped'})`,
      () => {
        const storage = workspace();
        return Effect.gen(function* () {
          yield* Effect.sync(() => {
            const connection = reader(storage);
            try {
              connection.exec(
                `CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('mine');
             ${stamp}`,
              );
            } finally {
              connection.close();
            }
          });
          const failure = yield* Effect.flip(
            Database.pipe(Effect.provide(substrate(storage))),
          );
          expect(failure._tag).toBe('DatabaseOpenFailed');
          expect(failure.message).toContain('is not a session store');
          expect(failure.message).toContain('application id');
          const stored = reader(storage);
          try {
            expect(stored.prepare('SELECT body FROM notes').all()).toEqual([
              { body: 'mine' },
            ]);
          } finally {
            stored.close();
          }
        });
      },
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
            reason: 'corrupt',
          },
          commit: 0,
        });
        if (opened.movedAside == null) throw new Error('nothing moved aside');
        expect(readFileSync(opened.movedAside.aside)).toEqual(truncated);
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
        yield* Effect.flatMap(Database, (db) =>
          db.appendAll([runStart, olderStart, waiting]),
        ).pipe(Effect.provide(substrate(storage)));
        yield* corrupt(3);
        yield* Effect.gen(function* () {
          const db = yield* Database;
          expect(
            yield* Effect.flip(
              db.readAggregate(runStart.aggregateId, 0, ROW_TYPES),
            ),
          ).toMatchObject({
            _tag: 'DatabaseReadFailed',
            cause: {
              _tag: 'DatabaseRowCorrupt',
              type: 'run.position',
              commit: 3,
            },
          });
        }).pipe(Effect.provide(substrate(storage)));
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
              db.readRunRecords(runStart.aggregateId),
            ).pipe(Effect.provide(substrate(storage))),
          ),
        ).toMatchObject({
          _tag: 'DatabaseReadFailed',
          cause: { _tag: 'DatabaseRowCorrupt', type: 'run.start', commit: 1 },
        });
      });
    },
  );

  it.effect('refuses a store of a newer schema and changes nothing', () => {
    const storage = workspace();
    const format = 102;
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
        const first = yield* db.appendAll([runStart, olderStart, waiting]);
        const second = yield* db.appendAll([requested]);

        expect(
          [...first, ...second].map((e) => [e.aggregateId, e.seq, e.commit]),
        ).toEqual([
          [qualifyAggregateId('run', RUN), 1, 1],
          [qualifyAggregateId('run', OLDER), 1, 2],
          [qualifyAggregateId('run', RUN), 2, 3],
          [qualifyAggregateId('run', RUN), 3, 4],
        ]);
        // The writer is the process, stamped by the layer, and `at` is
        // the layer's own clock: no caller passes either.
        expect(first.every((e) => e.origin === SELF && e.at === now)).toBe(
          true,
        );
        // One wake per committed batch, independent of its event ordinal.
        expect(yield* SubscriptionRef.get(db.level)).toBe(2);
        expect(yield* db.currentCommit).toBe(4);
        // A run begins with exactly one `run.start` (decision 9): a second
        // creation of a live run is refused, and the sequence it allocated
        // rolls back with it.
        expect((yield* Effect.flip(db.appendAll([runStart])))._tag).toBe(
          'DatabaseWriteFailed',
        );
        expect((yield* db.appendAll([waiting]))[0]?.seq).toBe(4);
        expect(yield* db.currentCommit).toBe(5);
        expect(yield* SubscriptionRef.get(db.level)).toBe(3);
      }).pipe(Effect.provide(substrate(storage)));
    },
  );

  it.effect('reopens at the committed ordinal and never reuses one', () => {
    const storage = workspace();
    const append = Effect.gen(function* () {
      const db = yield* Database;
      return yield* db.appendAll([runStart, waiting]);
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
          next: yield* db.appendAll([runStart]),
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
      const card = (run: RunId, args: object): SessionEventDraft => ({
        type: 'tool.start',
        aggregateId: qualifyAggregateId('run', run),
        logId: 'call-1',
        toolName: 'script',
        input: { script: shared, args: { ...args, $b: 'mine', $$b: [shared] } },
      });
      const drafts = [
        runStart,
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
              aggregateId: qualifyAggregateId('run', run),
            },
          ]);
          yield* Fiber.join(yield* yield* deletionCollector(db, storage));
        });
      const opened = Layer.merge(substrate(storage), nodePlatformLayer);
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const db = yield* Database;
          yield* db.appendAll(drafts);
          const cards = (yield* rowsOf(
            db,
            runStart.aggregateId,
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
            yield* Effect.flip(
              fresh.readAggregate(
                qualifyAggregateId('run', OLDER),
                0,
                ROW_TYPES,
              ),
            ),
          ).toMatchObject({
            cause: { _tag: 'DatabaseRowCorrupt', type: 'tool.start' },
          });
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
      const root = runStart.aggregateId;
      const inquiry = qualifyAggregateId(
        'plugin',
        'external-inquiry:ei_012345abcdef',
      );
      const base = {
        threadId: 'ei_012345abcdef',
        parentRunId: RUN,
        status: 'open',
        lastQuestionPreview: 'Which boundary condition applies?',
        lastActivityIso: '2026-09-06T12:00:00.000Z',
        turnCount: 1,
      } as const;
      const thread = (patch: Partial<InquiryThreadSummary> = {}) =>
        inquiryThreadRow({ ...base, ...patch });
      // Every aggregate this case writes, the unrelated run's among them.
      const stored = rowsOf(
        first,
        root,
        olderStart.aggregateId,
        inquiry,
        qualifyAggregateId('run', NEWER),
      );
      const initial = yield* first.appendAll([
        runStart,
        olderStart,
        thread({ status: 'answered' }),
        thread({ parentRunId: OLDER, turnCount: 2 }),
        thread({ parentRunId: OLDER, status: 'answered', turnCount: 2 }),
        thread({ turnCount: 3 }),
      ]);
      const initialCommit = initial[0]?.commit;
      if (initialCommit === undefined) throw new Error('nothing appended');
      expect((yield* first.aggregateState([inquiry]))[0]?.parentId).toBe(root);
      expect(
        (yield* Effect.flip(
          first.appendAll([
            thread({
              parentRunId: Schema.decodeUnknownSync(RunIdSchema)('ffff00'),
            }),
          ]),
        ))._tag,
      ).toBe('DatabaseWriteFailed');
      // Visiting the first asker again must not let its delayed turn-1
      // answer regress state and then admit the former asker's turn-2 open.
      const staleBatches: SessionEventDraft[][] = [
        [
          thread({ status: 'answered' }),
          thread({ parentRunId: OLDER, turnCount: 2 }),
        ],
        [thread({ parentRunId: OLDER, status: 'answered', turnCount: 2 })],
        [thread({ parentRunId: OLDER, turnCount: 2 })],
      ];
      for (const stale of staleBatches) {
        expect((yield* Effect.flip(first.appendAll(stale)))._tag).toBe(
          'DatabaseWriteFailed',
        );
      }
      expect(yield* stored).toEqual(initial);
      expect((yield* first.aggregateState([inquiry]))[0]?.parentId).toBe(root);
      const committed = [
        ...(yield* first.appendAll([waiting])),
        ...(yield* first.runRemoval(root, initialCommit)),
      ];
      expect(committed.at(-1)).toMatchObject({
        type: 'run.removed',
        runIds: [RUN],
      });
      expect((yield* first.readAggregate(root, 0, ROW_TYPES)).at(-1)).toEqual(
        committed.at(-1),
      );
      expect(committed.map((row) => [row.seq, row.commit])).toEqual([
        [2, 7],
        [3, 8],
      ]);
      expect(
        (yield* first.aggregateState([root, inquiry])).every(
          (row) => row.closed,
        ),
      ).toBe(true);
      // Neither a late update nor a new inquiry can attach to the tombstoned
      // asker: the closed thread refuses its writer, a closed parent the new one.
      for (const [draft, refusal] of [
        [thread(), 'DatabaseAggregateClosed'],
        [thread({ parentRunId: OLDER }), 'DatabaseAggregateClosed'],
        [thread({ threadId: 'ei_abcdef012345' }), 'DatabaseWriteFailed'],
      ] as const) {
        expect((yield* Effect.flip(first.appendAll([draft])))._tag).toBe(
          refusal,
        );
      }
      expect(yield* first.currentCommit).toBe(8);
      const tombstone = committed.at(-1);
      const cleanupError = new Error(
        'The generated directory is not writable.',
      );
      if (tombstone?.type !== 'run.removed') throw new Error('no tombstone');
      // A failed cleanup keeps the tombstone for the next pass.
      expect(
        yield* Effect.flip(
          first.deletions.collect(tombstone, () => Effect.fail(cleanupError)),
        ),
      ).toBe(cleanupError);
      expect((yield* first.readAggregate(root, 0, ROW_TYPES)).at(-1)).toEqual(
        tombstone,
      );
      const unrelated: SessionEventDraft = {
        ...runStart,
        aggregateId: qualifyAggregateId('run', NEWER),
      };
      yield* first.deletions.collect(tombstone, (ids) =>
        Effect.gen(function* () {
          expect(ids).toEqual([RUN]);
          // Cleanup runs outside the database write permit: unrelated
          // runs remain writable while generated files are removed.
          yield* first.appendAll([unrelated]);
        }),
      );
      expect(yield* first.aggregateState([root, inquiry])).toEqual([]);
      // Collecting it again, as a second process would, is a no-op.
      const again = vi.fn(() => Effect.void);
      yield* first.deletions.collect(tombstone, again);
      expect(again).not.toHaveBeenCalled();
      expect((yield* stored).map((event) => event.aggregateId)).toEqual([
        olderStart.aggregateId,
        unrelated.aggregateId,
      ]);
      const replacement = yield* first.appendAll([runStart]);
      expect(
        (yield* Effect.flip(first.runRemoval(root, initialCommit)))._tag,
      ).toBe('DatabaseWriteFailed');
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
      yield* Fiber.join(yield* yield* deletionCollector(first, storage));
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
      yield* Fiber.join(yield* yield* deletionCollector(first, storage));
      expect(existsSync(generated)).toBe(false);
      expect(existsSync(sibling)).toBe(true);
      expect(existsSync(accepted)).toBe(true);
      expect(yield* first.aggregateState([unrelated.aggregateId])).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(substrate(storage), nodePlatformLayer)));
  });

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
      const own = qualifyAggregateId('run', RUN);
      const theirs = qualifyAggregateId('run', OLDER);
      const writer = (): Effect.Effect<{
        code: number | null;
        stderr: string;
      }> =>
        Effect.promise(async () => {
          const bundled = await bundleStoreWriter(storage);
          const child = spawn(
            process.execPath,
            [bundled, storage, OTHER, OLDER],
            { stdio: ['ignore', 'inherit', 'pipe'] },
          );
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
          yield* db.appendAll([runStart]);
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

// ---------------------------------------------------------------------------
// The run history over the real publisher and the real (in-memory) store: no
// second `RunHistory`, no hand-written `SessionEvents`, so a schema mistake
// fails here rather than in the PR that turns the writes on.
// ---------------------------------------------------------------------------

describe('RunHistory', () => {
  const runHistory = () =>
    runHistoryOverStore.pipe(Layer.provideMerge(graph([])));
  const AGGREGATE = qualifyAggregateId('run', RUN);
  const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz0123';
  const ORIGIN = {
    protocol: 'openai-responses',
    requestedModel: 'deepseek-test',
    deployment: {
      endpoint: 'https://api.example.test/v1',
      credentialScope: 'deepseek',
    },
    codecVersion: 1,
  } as const;
  const INVOCATION = {
    invocationId: '0f1e2d3c-4b5a-4a9b-8c7d-6e5f4a3b2c1d',
    attempt: 1,
  } as const;
  const RESPONSE_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
  const TURN = {
    kind: 'http',
    providerResponseId: 'resp-1',
    requestedOrigin: ORIGIN,
    returnedModel: null,
    modelFingerprint: null,
    content: [
      {
        kind: 'reasoning',
        summary: [],
        content: [{ kind: 'text', text: `the key is ${SECRET}` }],
        evidence: { kind: 'openai-responses-reasoning', itemId: 'rs-1' },
      },
      {
        kind: 'local-call',
        providerCallId: 'call-a',
        name: 'bash',
        argumentsText: `{"command":"echo ${SECRET}"}`,
      },
      {
        kind: 'local-call',
        providerCallId: 'call-b',
        name: 'bash',
        argumentsText: '{"command":"ls"}',
      },
    ],
    finishReason: 'tool-calls',
    usage: null,
  } as const;
  const CALLS = [
    {
      callId: 'call-a',
      toolName: 'bash',
      lane: 'barrier',
      replay: 'unsafe',
      duplicateOf: null,
      logId: 'card-a',
    },
    {
      callId: 'call-b',
      toolName: 'bash',
      lane: 'barrier',
      replay: 'unsafe',
      duplicateOf: 'call-a',
      logId: 'card-b',
    },
  ] as const;
  const snapshot = (): RunHistoryDraft => ({
    type: 'run.position',
    aggregateId: AGGREGATE,
    payload: { family: 'toolUse', at: 'turn.ready', turn: 0 },
  });
  const refusalOf = (error: unknown): RunHistoryRefused | null =>
    error instanceof RunHistoryRefused ? error : null;
  /** The approval a barrier call waits on. */
  const approvalRequested: RunHistoryDraft = {
    type: 'request.opened',
    aggregateId: AGGREGATE,
    requestId: 'req-1',
    payload: {
      kind: 'bash',
      data: {
        requestId: 'req-1',
        command: 'ls',
        allowBypass: true,
        runId: RUN,
      },
    },
  };
  const toolEnd = (callId: string): RunHistoryDraft => ({
    type: 'tool.end',
    aggregateId: AGGREGATE,
    logId: callId,
    status: 'completed',
  });
  const settled = (
    callId: string,
    body: Partial<
      Extract<RunHistoryDraft, { type: 'tool.result' }>['payload']
    > = {},
  ): RunHistoryDraft => ({
    type: 'tool.result',
    aggregateId: AGGREGATE,
    payload: {
      responseId: RESPONSE_ID,
      callId,
      attempt: 1,
      disposition: 'executed',
      duplicateOf: null,
      result: { status: 'executed', output: 'ok' },
      attachments: [],
      ...body,
    },
  });
  const group: RunHistoryDraft = {
    type: 'model.message',
    aggregateId: AGGREGATE,
    payload: {
      kind: 'append',
      sourceResponse: RESPONSE_ID,
      messages: [
        {
          role: 'tool',
          results: [
            {
              callOrdinal: 0,
              status: 'success',
              content: [{ kind: 'text', text: 'ok' }],
            },
            {
              callOrdinal: 1,
              status: 'success',
              content: [{ kind: 'text', text: 'ok' }],
            },
          ],
        },
      ],
    },
  };
  /** The batches of one turn, in order, up to and excluding the delivery. */
  const openTurn = (cell: RunCell) =>
    Effect.gen(function* () {
      yield* cell.append([
        {
          type: 'model.message',
          aggregateId: AGGREGATE,
          payload: {
            kind: 'append',
            sourceResponse: null,
            messages: [
              { role: 'user', content: [{ kind: 'text', text: 'ls' }] },
            ],
          },
        },
        snapshot(),
      ]);
      yield* cell.append([
        {
          type: 'model.message',
          aggregateId: AGGREGATE,
          payload: {
            kind: 'attempt',
            request: '0'.repeat(64),
            invocation: INVOCATION,
            origin: ORIGIN,
          },
        },
      ]);
      yield* cell.append([
        {
          type: 'model.message',
          aggregateId: AGGREGATE,
          payload: {
            kind: 'identified',
            invocation: INVOCATION,
            providerResponseId: 'resp-1',
          },
        },
      ]);
      return yield* cell.append([
        {
          type: 'model.message',
          aggregateId: AGGREGATE,
          payload: {
            kind: 'response',
            responseId: RESPONSE_ID,
            invocation: INVOCATION,
            turn: TURN,
            calls: CALLS,
            usage: null,
          },
        },
        {
          type: 'tool.intent',
          aggregateId: AGGREGATE,
          payload: {
            origin: { kind: 'response', responseId: RESPONSE_ID },
            callId: 'call-a',
            attempt: 1,
          },
        },
      ]);
    });

  it.effect(
    'holds the batch contract: a mismatched delivery dies, a loose-keyed attachment is accepted',
    () =>
      Effect.gen(function* () {
        const events = yield* SessionEvents;
        const run = yield* RunHistory;
        const log = yield* Database;
        yield* events.transact((append) => append([runStart]));
        const cell = yield* run.open(RUN);
        let state = yield* openTurn(cell);
        // Delivering before the settlements committed is a caller defect.
        const early = yield* cell.append([group]).pipe(Effect.exit);
        expect(Exit.isFailure(early) && Cause.hasDies(early.cause)).toBe(true);
        // A batch the fold rejects commits nothing: the refusal has to mean
        // "not written", or every later `load` meets the orphan row.
        const written = (yield* log.readAggregate(AGGREGATE, 1, ROW_TYPES))
          .length;
        const orphan = yield* cell
          .append([settled('call-z'), toolEnd('call-z')])
          .pipe(Effect.flip);
        expect(refusalOf(orphan)?.reason).toBe('inconsistent');
        expect((yield* log.readAggregate(AGGREGATE, 1, ROW_TYPES)).length).toBe(
          written,
        );
        expect(yield* run.load(RUN)).toEqual(state);
        // Same rule for the history the batch assembles: an append that leaves
        // a tool group with no calling assistant is refused before publishing,
        // not discovered on the next cold load.
        const orphanGroup = yield* cell
          .append([
            {
              type: 'model.message',
              aggregateId: AGGREGATE,
              payload: {
                kind: 'append',
                sourceResponse: null,
                messages: [
                  {
                    role: 'tool',
                    results: [
                      {
                        callOrdinal: 0,
                        status: 'success',
                        content: [{ kind: 'text', text: 'ok' }],
                      },
                    ],
                  },
                ],
              },
            },
          ])
          .pipe(Effect.flip);
        expect(refusalOf(orphanGroup)?.reason).toBe('unprepared-history');
        expect((yield* log.readAggregate(AGGREGATE, 1, ROW_TYPES)).length).toBe(
          written,
        );
        state = yield* cell.append([approvalRequested]);
        expect(state.requests['req-1']?.decision).toBeNull();
        expect(state.pendingResponse?.records['call-a']?.status).toEqual({
          kind: 'started',
          attempt: 1,
        });
        // A real attachment carries loose keys and binary fields: accepted, and
        // the binary fields never reach the row.
        state = yield* cell.append([
          settled('call-a', {
            result: {
              status: 'executed',
              output: 'ok',
              files: [
                {
                  path: 'out/plot.png',
                  mimeType: 'image/png',
                  base64Data: 'AAAA',
                  // cast: not part of the row shape; the decode must drop it.
                  bytes: new Uint8Array([1, 2]) as never,
                  sourceTool: 'bash',
                },
              ],
            },
          }),
          toolEnd('call-a'),
        ]);
        const settledA = state.pendingResponse?.records['call-a']?.status;
        const file =
          settledA?.kind === 'settled' ? settledA.result.files?.[0] : undefined;
        expect(file).toEqual({
          path: 'out/plot.png',
          mimeType: 'image/png',
          sourceTool: 'bash',
        });
        // A credential-bearing endpoint is refused before anything is written,
        // and the refusal carries the permitted components only: the rejected
        // query string is the credential this check exists to keep out.
        const unsafe = yield* cell
          .append([
            {
              type: 'model.message',
              aggregateId: AGGREGATE,
              payload: {
                kind: 'attempt',
                request: '0'.repeat(64),
                invocation: { ...INVOCATION, attempt: 2 },
                origin: {
                  ...ORIGIN,
                  deployment: {
                    ...ORIGIN.deployment,
                    endpoint: `https://api.example.test/v1?api-key=${SECRET}`,
                  },
                },
              },
            },
          ])
          .pipe(Effect.flip);
        expect(unsafe).toBeInstanceOf(RunHistoryRefused);
        expect(refusalOf(unsafe)?.reason).toBe('unsafe-endpoint');
        expect(refusalOf(unsafe)?.detail).not.toContain(SECRET);
        expect(refusalOf(unsafe)?.detail).toContain(
          'https://api.example.test/v1',
        );
      }).pipe(Effect.provide(runHistory())),
  );
});
