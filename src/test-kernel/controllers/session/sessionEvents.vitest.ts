/**
 * The session graph's durable boundary (PRD one-fold-three-renderers, 7.1
 * and 7.2, acceptance for lane 2): replay framing and the live-owner
 * waiting rule.
 *
 * Framing: the log a graph is built over is history under the plane's
 * anchor. The fold publishes nothing before the replay marker, so the first
 * state a mounting reader sees already holds the listing, the aggregate
 * history, and the local snapshot; the tail then publishes every commit in
 * order. The waiting rule: a pending request on a run whose owner this
 * process holds (`self`) or whose owner is alive (`heldBy`) folds to
 * `waiting`; the same log with the owner gone folds to `interrupted`.
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
import * as SqlDriver from '@effect/sql-sqlite-node/SqliteClient';
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Fiber,
  type FileSystem,
  Layer,
  type Path,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';
import { TestClock } from 'effect/testing';
import * as Reactivity from 'effect/reactivity/Reactivity';

import { afterAll, beforeAll, describe, expect, vi } from 'vitest';
import * as toast from '@agent/runtime/terminalResultToast';

vi.mock('@effect/sql-sqlite-node/SqliteClient', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@effect/sql-sqlite-node/SqliteClient')
  >()),
}));

import { makeRunHistory } from '@agent/runtime/RunHistory';
import { sessionEventsLayer } from '@agent/runtime/SessionEvents';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import {
  databaseLayer,
  globalDatabaseLayer,
} from '@controllers/session/Database';
import { deletionCollector } from '@controllers/session/deletionCleanup';
import { openStore } from '@controllers/session/storeSchema';
import { sessionRequests } from '@controllers/session/SessionRequests';
import { makeSessionStore } from '@controllers/session/sessionStore';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from '@controllers/session/sessionSources';
import { SessionViewService } from '@controllers/session/SessionView';
import { sessionInputsLayer } from '@controllers/session/sessionInputs';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { type GlobalValues } from '@platform/processRuntime';
import type { ProcessProbe } from '@platform/defaults/nodeProcesses';
import {
  qualifyAggregateId,
  emptyRunEndOutput,
  LocalRuntimeStateSchema,
  RUN_PHASE,
  RunIdSchema,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  runStateAppend,
  RunHistory,
  RunHistoryRefused,
  type RunCell,
} from '@shared/session/runHistory';
import { Database } from '@shared/session/database';
import { runActions } from '@shared/session/runActions';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { RunHistoryDraft } from '@shared/session/runState';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import type { SessionView } from '@shared/session/sessionView';
import { closeSessionOf, openTestSession } from '@test/support/sessionEnd';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import {
  nodeSpawnerLayer,
  scriptedSpawnerLayer,
} from '@test/support/childProcessTestLayer';
import { seedRows } from '@test/support/sessionTestUtils';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import '@test/support/sessionGraphTestSetup';
import {
  storePluginsLayer,
  globalValuesOver,
} from '@test/support/setupPlatform';
import { inquiryThreadRow } from '@test/support/inquiryThreadRow';
import { REPO_ROOT } from '@test/support/repoScan';
import type { InquiryThreadSummary } from '@texra/shared/plugins/externalInquiry';
import type { LeanLanguageServices } from '@texra/tools/lean/leanLanguageServices';
import { toolTable } from '@tools/toolTable';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  platform: vi.fn(() => process.platform),
}));
vi.mock('@texra/tools/lean/direct/directLspAdapter', async () => {
  const { Layer } = await import('effect');
  const { LeanLanguageServices } =
    await import('@texra/tools/lean/leanLanguageServices');
  return {
    directLeanLanguageServices: () =>
      Layer.succeed(LeanLanguageServices)(
        {} as LeanLanguageServices['Service'],
      ),
  };
});

/** A second OS process's writer: this build's `Database` over the store at
 *  `storage`, owned as `owner`, creating `run` and, once `<storage>/go`
 *  exists, holding the write lock for `hold` ms (a slow writer, announced by
 *  `<storage>/held`), then appending `rows` positions to it, one
 *  transaction each. */
const STORE_WRITER = `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Effect, Layer } from 'effect';
import { databaseLayer } from '@controllers/session/Database';
import { ToolRegistry, toolTable } from '@tools/toolTable';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { nodePlatformServices } from '@platform/defaults/nodePlatform';
import { qualifyAggregateId } from '@shared/schemas';
import { Database } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';

const [storage, owner, run, rows, hold] = process.argv.slice(2);
const id = qualifyAggregateId('run', run);
const append = Effect.gen(function* () {
  const db = yield* Database;
  yield* db.appendAll([{ type: 'run.start', aggregateId: id,
    identity: { kind: 'agent', agent: 'chat' }, userFollowUpSupport: 'unsupported',
    parent: null, provenance: null }]);
  while (!existsSync(join(storage, 'go'))) yield* Effect.sleep('1 millis');
  const slow = new DatabaseSync(join(storage, 'texra.db'));
  slow.exec('BEGIN IMMEDIATE');
  writeFileSync(join(storage, 'held'), '');
  yield* Effect.sleep(Number(hold));
  slow.exec('COMMIT');
  slow.close();
  for (let i = 0; i < Number(rows); i += 1)
    yield* db.appendAll([{ type: 'run.position', aggregateId: id,
      payload: { family: 'toolUse', at: 'waiting' } }]);
});
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

const SELF = '["test-host",4242,"self-start"]';
const OTHER = '["test-host",4343,"other-start"]';
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

/** Every row of the aggregates `ids`, in commit order. */
const rowsOf = (
  db: Database['Service'],
  ...ids: readonly SessionEvent['aggregateId'][]
) =>
  Effect.forEach(ids, (id) => db.readAggregate(id, 0)).pipe(
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

/** Enqueue rows on a session's publisher and return at once, as a
 *  detached producer does; a reader waits on `session.log.settled`. */
const publishTestRows = (
  session: SessionHandle,
  rows: readonly SessionEventDraft[],
): void => {
  Effect.runFork(seedRows(session.log)(rows));
};

/** The view access a request handler reads: the fold's level and one run
 *  of it. */
const viewAccess = (ref: SubscriptionRef.SubscriptionRef<SessionView>) => ({
  ref,
  run: (runId: RunId) => SubscriptionRef.getUnsafe(ref).runs.get(runId),
});

describe('session events and view', () => {
  it.effect(
    'commits a detached publication before a batch awaited after it',
    () =>
      Effect.gen(function* () {
        // The tool card's start row is detached by the trace subscriber; the
        // loop's settlement batch, awaited on its own fiber, follows it in
        // program order. The one inbox makes that the commit order too, so
        // a fast tool's card never closes before it opens (the inversion of
        // 2026-09-12: 24 of 89 cards in one session).
        const events = yield* SessionEvents;
        const aggregateId = qualifyAggregateId('run', RUN);
        events.detach((append) =>
          append([
            {
              type: 'tool.start',
              aggregateId,
              logId: 'card-1',
              toolName: 'bash',
              input: { command: 'ls' },
            },
          ]).pipe(Effect.orDie),
        );
        const settled = yield* events.transact((append) =>
          append([
            {
              type: 'tool.end',
              aggregateId,
              logId: 'card-1',
              status: 'completed',
              result: { toolName: 'bash', output: { output: '' } },
            },
          ]),
        );
        const rows = yield* (yield* Database).readDisplayAggregate(
          aggregateId,
          2,
        );
        expect([...rows].map((row) => [row.type, row.seq])).toEqual([
          ['tool.start', 2],
          ['tool.end', 3],
        ]);
        expect(settled.map((row) => row.seq)).toEqual([3]);
      }).pipe(Effect.provide(graph([runStart]))),
  );

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
 * The session owner (proposal 2026-09-05, sections 3 and 9): `closeSession`
 * is how a session the `Sessions` map holds behind `openTestSession` ends.
 */
describe('Sessions owner', () => {
  it.effect(
    'admits requests by current claims despite a stale displayed owner',
    () =>
      Effect.gen(function* () {
        const db = yield* Database;
        const view = yield* SessionViewService;
        const local = yield* SubscriptionRef.make(
          Schema.decodeUnknownSync(LocalRuntimeStateSchema)({
            self: [OTHER],
            dead: [],
            unreadable: [],
            resumeBlocked: [],
          }),
        );
        const stop = vi.fn(() => ({
          accepted: () => true,
          settlement: Effect.void,
        }));
        const session = {
          view: viewAccess(view.ref),
          runs: { stop },
          roots: createFakeWorkspaceRoots({
            globalState: { [GlobalStateKey.DETACH_SUBAGENTS_ON_STOP]: true },
          }),
        } as unknown as SessionHandle;
        const events = yield* SessionEvents;
        const requests = sessionRequests({
          session: () => session,
          log: { ...db, removeRun: events.removeRun, detach: events.detach },
          local,
          plugins: toolTable([]),
          services: yield* Effect.context<
            GlobalValues | FileSystem.FileSystem | Path.Path
          >(),
          closed: () => false,
        });
        // The displayed fold was built as SELF and considers this run writable.
        // This requesting process is OTHER; it must respect the current claim.
        yield* settle(view.ref, (v) => v.runs.has(RUN));
        expect(
          SubscriptionRef.getUnsafe(view.ref).runs.get(RUN)?.readOnly,
        ).toBe(false);
        const request = {
          kind: 'run.stop',
          runId: RUN,
          reason: 'user',
        } as const;
        const refused = yield* requests.request(request).pipe(Effect.flip);
        expect(refused._tag).toBe('NotOwner');
        expect(stop).not.toHaveBeenCalled();

        yield* db.releaseClaims([qualifyAggregateId('run', RUN)]);
        yield* SubscriptionRef.update(view.ref, (v) => ({
          ...v,
          runs: new Map(
            [...v.runs].map(([id, run]) => [id, { ...run, readOnly: true }]),
          ),
        }));
        // A released claim is not held, even while the display still says so.
        expect(yield* requests.request(request)).toEqual({ kind: 'done' });
        // A stop that leaves the child policy unset takes the session's
        // configured "Keep subagents running".
        expect(stop).toHaveBeenCalledExactlyOnceWith(RUN, {
          detachActiveChildren: true,
          reason: 'user',
        });
      }).pipe(
        Effect.provide(graph([runStart])),
        Effect.provide(
          globalValuesOver(
            globalDatabaseLayer(createFakeWorkspaceRoots().globalStorage).pipe(
              Layer.provide(ProcessIdentity.layer(SELF)),
              Layer.provide(nodePlatformLayer),
              Layer.orDie,
            ),
          ),
        ),
        Effect.provide(nodePlatformLayer),
      ),
  );

  it.effect(
    'refuses a delete rendered before the run started, and a second concurrent resume',
    () =>
      Effect.gen(function* () {
        const db = yield* Database;
        const view = yield* SessionViewService;
        const events = yield* SessionEvents;
        const removeRun = vi.fn(events.removeRun);
        const session = {
          view: viewAccess(view.ref),
        } as unknown as SessionHandle;
        const requests = sessionRequests({
          session: () => session,
          log: { ...db, removeRun, detach: events.detach },
          local: yield* SubscriptionRef.make(
            Schema.decodeUnknownSync(LocalRuntimeStateSchema)({
              self: [SELF],
              dead: [],
              unreadable: [],
              resumeBlocked: [],
            }),
          ),
          plugins: toolTable([]),
          services: yield* Effect.context<
            GlobalValues | FileSystem.FileSystem | Path.Path
          >(),
          closed: () => false,
        });
        yield* settle(view.ref, (v) => v.runs.has(RUN));
        // The host rendered Delete session from this view; by the time the
        // click is handled the run has started in this process.
        yield* SubscriptionRef.update(view.ref, (v) => ({
          ...v,
          runs: new Map(
            [...v.runs].map(([id, run]) => {
              const started = {
                ...run,
                status: RUN_PHASE.RUNNING,
                group: 'running' as const,
                readOnly: false,
              };
              return [id, { ...started, actions: runActions(started, false) }];
            }),
          ),
        }));
        const refused = yield* requests
          .request({ kind: 'run.delete', runId: RUN })
          .pipe(Effect.flip);
        expect(refused).toMatchObject({
          _tag: 'Rejected',
          reason: expect.stringContaining('stop it first'),
        });
        expect(removeRun).not.toHaveBeenCalled();
      }).pipe(
        Effect.provide(graph([runStart])),
        Effect.provide(
          globalValuesOver(
            globalDatabaseLayer(createFakeWorkspaceRoots().globalStorage).pipe(
              Layer.provide(ProcessIdentity.layer(SELF)),
              Layer.provide(nodePlatformLayer),
              Layer.orDie,
            ),
          ),
        ),
        Effect.provide(nodePlatformLayer),
      ),
  );

  const open = (storagePath: string) =>
    openTestSession({
      roots: createFakeWorkspaceRoots({ storagePath }),
      transcriptMode: { kind: 'ephemeral' },
    });

  // Real polling loops (`vi.waitFor`) on the process runtime's live work:
  // `it.live`, so nothing the session does waits on a test clock.
  it.live(
    'delivers committed runtime facts and never announces a rejected write',
    () =>
      Effect.gen(function* () {
        const session = yield* open('/workspace/owner/committed-status');
        // The folded tail presents each `run.end` this process committed:
        // the presenter's calls say which rows the tail delivered.
        const presented = vi.spyOn(toast, 'presentTerminalResult');

        try {
          publishTestRows(session, [
            runStart,
            { ...runStart, aggregateId: qualifyAggregateId('run', OLDER) },
            {
              type: 'run.removed',
              aggregateId: qualifyAggregateId('run', RUN),
            },
          ]);
          yield* session.log.settled;
          expect(session.log.now()).toBe(3);
          publishTestRows(session, [
            {
              type: 'run.position',
              aggregateId: qualifyAggregateId('run', RUN),
              payload: { family: 'toolUse', at: 'waiting' },
            },
          ]);
          publishTestRows(session, [
            {
              type: 'run.position',
              aggregateId: qualifyAggregateId('run', OLDER),
              payload: { family: 'toolUse', at: 'waiting' },
            },
          ]);
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(
                SubscriptionRef.getUnsafe(session.view.ref).runs.get(OLDER)
                  ?.status,
              ).toBe(RUN_PHASE.WAITING),
            ),
          );
          const received = yield* Effect.all(
            [RUN, OLDER].map((id) => session.log.display(id)),
          );
          expect(
            received.flat().filter((event) => event.type === 'run.position'),
          ).toEqual([
            expect.objectContaining({
              type: 'run.position',
              aggregateId: qualifyAggregateId('run', OLDER),
              payload: { family: 'toolUse', at: 'waiting' },
              seq: 2,
              commit: 4,
            }),
          ]);
          const runEnd = {
            type: 'run.end',
            outcome: 'completed',
            output: emptyRunEndOutput(),
          } as const;
          publishTestRows(session, [
            { ...runEnd, aggregateId: qualifyAggregateId('run', RUN) },
          ]);
          publishTestRows(session, [
            { ...runEnd, aggregateId: qualifyAggregateId('run', OLDER) },
          ]);
          yield* session.log.settled;
          // The live run's `run.end` reaches the folded tail once the view
          // has folded it, and a `waiting` step never does.
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(presented).toHaveBeenCalledOnce()),
          );
          expect(presented).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ runId: OLDER }),
          );
        } finally {
          presented.mockRestore();
          yield* closeSessionOf(session);
        }
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
      expect(mount.calls.map((command) => command.command)).toEqual([
        '/sbin/mount',
      ]);
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
        expect(readFileSync(opened.movedAside!.aside)).toEqual(truncated);
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
        // Any undecodable row of a run damages it, not only its start.
        yield* Effect.gen(function* () {
          const db = yield* Database;
          yield* db.appendAll([runStart, olderStart, waiting]);
          yield* corrupt(3);
          expect(
            yield* Effect.flip(db.readAggregate(runStart.aggregateId, 0)),
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
            (v) => v.runs.has(OLDER) && v.runs.get(RUN)?.readOnly === true,
          );
          expect(
            (yield* SubscriptionRef.get(view.ref)).runs.get(RUN),
          ).toMatchObject({
            readOnly: true,
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

  it.effect(
    "lists a run with an earlier build's row as that build's, not as damaged",
    () => {
      // `model.message` v1 has no upcaster to this build's version.
      const storage = workspace();
      return Effect.gen(function* () {
        yield* Database.pipe(
          Effect.flatMap((db) =>
            db.appendAll([
              runStart,
              {
                type: 'model.message',
                aggregateId: runStart.aggregateId,
                payload: {
                  kind: 'append',
                  sourceResponse: null,
                  messages: [
                    { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
                  ],
                },
              },
            ]),
          ),
          Effect.provide(substrate(storage)),
        );
        const raw = reader(storage);
        raw.exec(`UPDATE event SET version = 1 WHERE type = 'model.message'`);
        raw.close();
        const read = yield* Effect.flip(
          Effect.flatMap(Database, (db) =>
            db.readAggregate(runStart.aggregateId, 0),
          ).pipe(Effect.provide(substrate(storage))),
        );
        expect(read.cause).toMatchObject({
          _tag: 'DatabaseRowEarlier',
          type: 'model.message',
        });
        // A record read (history, resume, follow-up) refuses it the same way,
        // though the records never select its `model.message` row.
        const records = yield* Effect.flip(
          Effect.flatMap(Database, (db) =>
            db.readRunRecords(runStart.aggregateId),
          ).pipe(Effect.provide(substrate(storage))),
        );
        expect(records.cause).toMatchObject({ _tag: 'DatabaseRowEarlier' });
        yield* Effect.gen(function* () {
          const view = yield* SessionViewService;
          yield* settle(view.ref, (v) => v.runs.get(RUN)?.readOnly === true);
          expect(
            (yield* SubscriptionRef.get(view.ref)).runs.get(RUN)?.statusNotice,
          ).toStrictEqual({ kind: 'earlierBuild' });
        }).pipe(
          Effect.provide(graph([], substrate(storage).pipe(Layer.orDie))),
          Effect.scoped,
        );
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

  it.effect(
    'captures the parent incarnation in the creation transaction',
    () => {
      const storage = workspace();
      return Effect.gen(function* () {
        const db = yield* Database;
        const child: SessionEventDraft = {
          ...olderStart,
          parent: { id: RUN, callId: null },
          provenance: null,
        };
        // A missing parent rejects the complete batch, including the earlier
        // creation and the child's sequence reservation.
        const rejected = yield* Effect.flip(
          db.appendAll([
            runStart,
            {
              ...child,
              parent: {
                id: Schema.decodeUnknownSync(RunIdSchema)('ffff00'),
                callId: null,
              },
            },
          ]),
        );
        expect(rejected._tag).toBe('DatabaseWriteFailed');
        expect(yield* db.currentCommit).toBe(0);
        expect(yield* SubscriptionRef.get(db.level)).toBe(0);

        // The parent can be created earlier in this same transaction. The
        // database stamps its actual incarnation uid; the launcher names
        // only the parent's id.
        const created = yield* db.appendAll([runStart, child]);
        const [parentState] = yield* db.aggregateState([
          qualifyAggregateId('run', RUN),
        ]);
        expect(created[1]).toMatchObject({
          parent: { id: RUN, uid: parentState?.uid },
        });
        expect(
          yield* rowsOf(db, runStart.aggregateId, child.aggregateId),
        ).toEqual(created);
        expect(created[0]).toMatchObject({ parent: null });

        yield* db.appendAll([
          {
            type: 'run.removed',
            aggregateId: qualifyAggregateId('run', RUN),
          },
        ]);
        const beforeRejectedChild = yield* db.currentCommit;
        const closedParent = yield* Effect.flip(
          db.appendAll([
            {
              ...child,
              aggregateId: qualifyAggregateId(
                'run',
                Schema.decodeUnknownSync(RunIdSchema)('ab12d0'),
              ),
            },
          ]),
        );
        expect(closedParent._tag).toBe('DatabaseWriteFailed');
        expect(yield* db.currentCommit).toBe(beforeRejectedChild);
        // The independent child survives its parent's closure, retaining the
        // declared incarnation for the runtime's effective-parent check.
        expect(yield* db.readAggregate(child.aggregateId, 0)).toEqual([
          created[1],
        ]);
      }).pipe(Effect.provide(substrate(storage)));
    },
  );

  it.effect('rolls a rejected batch back whole, leaving nothing behind', () => {
    const storage = workspace();
    return Effect.gen(function* () {
      const db = yield* Database;
      yield* db.appendAll([runStart]);
      // Reject the second insert after the first member changed its sequence.
      // This exercises rollback, independently of pre-transaction validation.
      yield* Effect.sync(() => {
        const raw = reader(storage);
        try {
          raw.exec(`CREATE TRIGGER reject_run_position BEFORE INSERT ON event
            WHEN NEW.type = 'run.position'
            BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`);
        } finally {
          raw.close();
        }
      });
      // The trigger is another connection's commit: let the poll take its
      // wake first, so the level below counts this process's batches.
      yield* TestClock.adjust('300 millis');
      const level = yield* SubscriptionRef.get(db.level);
      const failure = yield* Effect.flip(db.appendAll([olderStart, waiting]));

      expect(failure._tag).toBe('DatabaseWriteFailed');
      const rows = yield* Effect.sync(() => {
        const raw = reader(storage);
        try {
          return raw.prepare('SELECT seq FROM event').all();
        } finally {
          raw.close();
        }
      });
      expect(rows).toEqual([{ seq: 1 }]);
      expect(yield* SubscriptionRef.get(db.level)).toBe(level);
    }).pipe(Effect.provide(substrate(storage)));
  });

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
        Effect.sync(() => {
          const raw = reader(storage);
          try {
            return raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n;
          } finally {
            raw.close();
          }
        });
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
      return Effect.gen(function* () {
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
        const raw = reader(storage);
        try {
          const data = raw
            .prepare("SELECT data FROM event WHERE type = 'tool.start'")
            .all()
            .map((row) => String(row.data));
          expect(data.every((text) => !text.includes(shared))).toBe(true);
          expect(data[0]).toContain('"$$b":"mine","$$$b":[{"$b":"');
          const sizes = raw
            .prepare('SELECT length(value) AS n FROM blob ORDER BY n DESC')
            .all()
            .map((row) => Number(row.n));
          expect(sizes).toHaveLength(2);
          expect(sizes[0]).toBeLessThan(shared.length / 10);
        } finally {
          raw.close();
        }
        yield* remove(RUN);
        expect(yield* count('blob')).toBe(1);
        expect(yield* count('event_blob')).toBe(1);
        yield* Effect.sync(() => {
          const raw = reader(storage);
          try {
            raw.exec("UPDATE blob SET value = X'28b52ffd0000'");
          } finally {
            raw.close();
          }
        });
        const reopened = yield* Effect.gen(function* () {
          const fresh = yield* Database;
          return yield* Effect.flip(
            fresh.readAggregate(qualifyAggregateId('run', OLDER), 0),
          );
        }).pipe(Effect.provide(substrate(storage)));
        expect(reopened).toMatchObject({
          cause: { _tag: 'DatabaseRowCorrupt', type: 'tool.start' },
        });
        yield* remove(OLDER);
        expect(yield* count('blob')).toBe(0);
      }).pipe(
        Effect.provide(Layer.merge(substrate(storage), nodePlatformLayer)),
      );
    },
  );

  it.effect(
    'reads bounded history, latest listing facts, and outstanding requests',
    () => {
      const storage = workspace();
      return Effect.gen(function* () {
        const db = yield* Database;
        const id = qualifyAggregateId('run', RUN);
        const other = qualifyAggregateId('run', OLDER);
        const absent = qualifyAggregateId(
          'run',
          Schema.decodeUnknownSync(RunIdSchema)('ab99ff'),
        );
        const rows = yield* db.appendAll([
          runStart,
          olderStart,
          waiting,
          requested,
          { ...requested, requestId: 'second' },
          {
            type: 'request.decided',
            aggregateId: id,
            requestId: 'second',
            decision: { action: 'approve' },
          },
          {
            ...waiting,
            payload: { family: 'toolUse', at: 'waiting' },
          },
          {
            type: 'response.finalized',
            aggregateId: id,
            text: 'final answer',
          },
          { type: 'run.removed', aggregateId: other },
        ]);
        // Keyed by `listingKeyOf`: the tombstone replaces its run's
        // `run.start` under the one lifecycle key the fold keeps.
        expect((yield* db.readListing()).map((row) => row.commit)).toEqual([
          1, 4, 7, 9,
        ]);
        const withoutTranscript = yield* db.readInputBatch([], 0);
        expect(withoutTranscript.cursor).toBe(9);
        expect(withoutTranscript.events).toEqual(
          rows.filter((row) => row.commit !== 8),
        );
        expect((yield* db.readInputBatch([id], 0)).events).toEqual(rows);
        expect(yield* db.readAggregate(id, 3)).toEqual(
          rows.filter((row) => row.aggregateId === id && row.seq >= 3),
        );
        expect(yield* db.aggregateState([id, other, absent])).toEqual([
          {
            aggregateId: id,
            uid: expect.any(String),
            ownerId: SELF,
            closed: false,
            parentId: null,
            startCommit: 1,
          },
          {
            aggregateId: other,
            uid: expect.any(String),
            ownerId: SELF,
            closed: true,
            parentId: null,
            startCommit: 2,
          },
        ]);
        // A closed target is the typed ownership rejection; a seq-1
        // violation on an open or absent one is a plain write failure.
        for (const [draft, tag] of [
          [{ ...waiting, aggregateId: other }, 'DatabaseNotOwner'],
          [olderStart, 'DatabaseNotOwner'],
          [runStart, 'DatabaseWriteFailed'],
          [{ ...waiting, aggregateId: absent }, 'DatabaseWriteFailed'],
        ] as const) {
          expect((yield* Effect.flip(db.appendAll([draft])))._tag).toBe(tag);
        }
        expect(yield* db.currentCommit).toBe(9);
        expect(yield* db.aggregateState([absent])).toEqual([]);
      }).pipe(Effect.provide(substrate(storage)));
    },
  );
  it.effect(
    'requires every dependent claim before committing a deletion',
    () => {
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
        expect((yield* first.aggregateState([inquiry]))[0]?.parentId).toBe(
          root,
        );
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
        expect((yield* first.aggregateState([inquiry]))[0]?.parentId).toBe(
          root,
        );
        yield* first.releaseClaims([inquiry]);
        const removal: SessionEventDraft = {
          type: 'run.removed',
          aggregateId: root,
        };
        const refusesDeletion = Effect.gen(function* () {
          const before = yield* SubscriptionRef.get(first.level);
          expect(
            (yield* Effect.flip(first.appendAll([waiting, removal])))._tag,
          ).toBe('DatabaseWriteFailed');
          expect(yield* stored).toEqual(initial);
          expect(
            (yield* first.aggregateState([root, inquiry])).every(
              (row) => !row.closed,
            ),
          ).toBe(true);
          expect(yield* SubscriptionRef.get(first.level)).toBe(before);
        });
        // An unclaimed dependent also has to be acquired, not silently closed.
        yield* refusesDeletion;
        yield* Effect.gen(function* () {
          const second = yield* Database;
          yield* second.acquireClaims([inquiry]);
          yield* refusesDeletion;
          expect(
            yield* Effect.flip(
              Effect.flatten(
                first.prepareRunRemoval(root, 'bulk', initial[0]!.commit),
              ),
            ),
          ).toMatchObject({ _tag: 'DatabaseClaimRefused' });
          expect(yield* stored).toEqual(initial);
          yield* second.releaseClaims([inquiry]);
        }).pipe(Effect.provide(substrate(storage, OTHER)));
        const committed = [
          ...(yield* first.appendAll([waiting])),
          ...(yield* Effect.flatten(
            first.prepareRunRemoval(root, 'bulk', initial[0]!.commit),
          )),
        ];
        expect(committed.at(-1)).toMatchObject({
          type: 'run.removed',
          runIds: [RUN],
        });
        expect((yield* first.readAggregate(root, 0)).at(-1)).toEqual(
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
          [thread(), 'DatabaseNotOwner'],
          [thread({ parentRunId: OLDER }), 'DatabaseNotOwner'],
          [thread({ threadId: 'ei_abcdef012345' }), 'DatabaseWriteFailed'],
        ] as const) {
          expect((yield* Effect.flip(first.appendAll([draft])))._tag).toBe(
            refusal,
          );
        }
        expect(yield* first.currentCommit).toBe(8);
        const tombstone = committed.at(-1)!;
        const cleanupError = new Error(
          'The generated directory is not writable.',
        );
        if (tombstone.type !== 'run.removed') throw new Error('no tombstone');
        // A failed cleanup keeps the tombstone for the next pass.
        expect(
          yield* Effect.flip(
            first.deletions.collect(tombstone, () => Effect.fail(cleanupError)),
          ),
        ).toBe(cleanupError);
        expect((yield* first.readAggregate(root, 0)).at(-1)).toEqual(tombstone);
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
          (yield* Effect.flip(
            Effect.flatten(
              first.prepareRunRemoval(root, 'single', initial[0]!.commit),
            ),
          ))._tag,
        ).toBe('DatabaseWriteFailed');
        expect(yield* first.readAggregate(root, 0)).toEqual(replacement);
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
        const generated = join(
          storage,
          WORKSPACE_STORAGE_LAYOUT.runs,
          'ef56ab',
        );
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
        expect(yield* first.aggregateState([unrelated.aggregateId])).toEqual(
          [],
        );
      }).pipe(
        Effect.provide(Layer.merge(substrate(storage), nodePlatformLayer)),
      );
    },
  );

  /**
   * Two OS processes on one file: a child
   * Node process appends to its run while this one appends to its own and
   * reads. Failure modes: an append lost to `SQLITE_BUSY`; a seq or commit
   * skipped or reused; a commit this connection observed going backwards;
   * and this process's thread held in SQLite's busy wait past the 25 ms
   * slice instead of retrying on its fiber schedule. That last mode is
   * checked in two parts, neither a wall-clock bound (a shared runner
   * stalls for seconds: 9 s seen on Windows CI). The slice itself is pinned
   * as the store's opened connection reports it. And the child first holds
   * the write lock for `HOLD_MS` while a ticker fiber runs every 5 ms: with
   * the slice the retry sleeps (5 ms doubling to 250 ms) fill most of the
   * hold, about 320 ticks, while a busy wait of `HOLD_MS / 3` or more leaves
   * room for at most three attempts, so two retry sleeps (about 5 and 10 ms)
   * and a few ticks. That catches a block the pragma does not show, such as
   * a wait outside SQLite's busy handler.
   */
  it.live(
    'shares one store with another OS process',
    () => {
      const storage = workspace();
      const ROWS = 400;
      const HOLD_MS = 2000;
      /** Far below the 25 ms slice's count, above a long busy wait's. */
      const MIN_TICKS = 20;
      const own = qualifyAggregateId('run', RUN);
      const theirs = qualifyAggregateId('run', OLDER);
      return Effect.gen(function* () {
        const writer = yield* Effect.promise(() => bundleStoreWriter(storage));
        const db = yield* Database;
        const observed: number[] = [];
        yield* SubscriptionRef.changes(db.observedCommit).pipe(
          Stream.runForEach((commit) =>
            Effect.sync(() => observed.push(commit)),
          ),
          Effect.forkScoped,
        );
        yield* db.appendAll([runStart]);
        const child = spawn(
          process.execPath,
          [writer, storage, OTHER, OLDER, String(ROWS), String(HOLD_MS)],
          { stdio: ['ignore', 'inherit', 'inherit'] },
        );
        const exited = new Promise<number | null>((done) =>
          child.on('exit', (code) => done(code)),
        );
        // The child has opened the store and created its run; it then holds
        // the write lock, and both append at once, so the two contend for it.
        while ((yield* db.aggregateState([theirs])).length === 0) {
          expect(child.exitCode, 'the writer exited before writing').toBeNull();
          yield* Effect.sleep('5 millis');
        }
        writeFileSync(join(storage, 'go'), '');
        while (!existsSync(join(storage, 'held')))
          yield* Effect.sleep('1 millis');
        let ticks = 0;
        yield* Effect.forever(
          Effect.sync(() => (ticks += 1)).pipe(
            Effect.andThen(Effect.sleep('5 millis')),
          ),
        ).pipe(Effect.forkScoped);
        const blocked = performance.now();
        for (let i = 0; i < ROWS; i += 1) {
          const before = ticks;
          yield* db.appendAll([waiting]);
          if (i === 0) {
            // The first append waited out the hold, so the check is not vacuous.
            expect(performance.now() - blocked).toBeGreaterThan(HOLD_MS / 2);
            // The retry sleeps on the fiber: the ticker runs through the hold.
            expect(
              ticks - before,
              'the thread was held in SQLite for much of the hold',
            ).toBeGreaterThanOrEqual(MIN_TICKS);
          }
          yield* db.readAggregate(own, i + 1);
        }
        const code = yield* Effect.promise(() => exited);
        expect(code).toBe(0);
        const total = 2 * (ROWS + 1);
        while ((yield* SubscriptionRef.get(db.observedCommit)) < total)
          yield* Effect.sleep('50 millis');
        const rows = yield* rowsOf(db, own, theirs);
        expect(rows.map((row) => row.commit)).toEqual(
          Array.from({ length: total }, (_, i) => i + 1),
        );
        for (const id of [own, theirs])
          expect(
            rows.filter((row) => row.aggregateId === id).map((row) => row.seq),
          ).toEqual(Array.from({ length: ROWS + 1 }, (_, i) => i + 1));
        expect(observed).toEqual(observed.toSorted((a, b) => a - b));
        expect(observed.at(-1)).toBe(total);
        const filename = join(realpathSync.native(storage), 'texra.db');
        const opened = yield* openStore(
          SqlDriver.make({ filename }),
          SqlDriver.make({ filename, readonly: true, disableWAL: true }),
          'persistent',
          filename,
          filename,
        );
        const [slice] = yield* opened.sql.unsafe<{ timeout: number }>(
          'PRAGMA busy_timeout',
          [],
        );
        expect(slice?.timeout).toBe(25);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            substrate(storage),
            nodePlatformLayer,
            Reactivity.layer,
          ),
        ),
        Effect.scoped,
      );
    },
    30_000,
  );

  /**
   * There is no lease file, so the only thing that frees a crashed
   * process's claim is proving its recorded owner dead. A restart that meets
   * a stale claim it cannot disprove never resumes the run, for the life of
   * the store, so this is the one window whose regression costs every run
   * that was live at the crash. The recorded owner here is this pid under a
   * start identity from before the crash: the pid resolves, its identity
   * differs, and that is `proveOwnerLiveness`'s pid-reuse verdict. The
   * follow-up the crash left queued reaches the restarted publisher's
   * pending set where the claim moves.
   */
  it.live('reclaims a run whose recorded owner is provably dead', () => {
    const storage = workspace();
    const CRASHED = JSON.stringify([
      os.hostname().toLowerCase(),
      process.pid,
      'an-earlier-process',
    ]);
    const target = qualifyAggregateId('run', RUN);
    const followUp = {
      followUpId: 'left-queued',
      content: { text: 'deliver me', from: { kind: 'user' as const } },
    };
    return Effect.gen(function* () {
      yield* Database.pipe(
        Effect.flatMap((crashed) =>
          crashed.appendAll([
            runStart,
            { type: 'followup.queued', aggregateId: target, ...followUp },
          ]),
        ),
        Effect.provide(substrate(storage, CRASHED)),
      );
      yield* Effect.gen(function* () {
        const restarted = yield* Database;
        expect(yield* restarted.claimOwner(target)).toEqual({
          ownerId: CRASHED,
          liveness: 'dead',
        });
        // Fenced until the claim moves: the run is another owner's.
        expect((yield* Effect.flip(restarted.appendAll([waiting])))._tag).toBe(
          'DatabaseNotOwner',
        );
        yield* (yield* RunHistory).open(RUN, {
          activation: () => Effect.succeed([]),
        });
        expect((yield* restarted.aggregateState([target]))[0]?.ownerId).toBe(
          SELF,
        );
        // The resumed run appends onto the rows the crash left behind.
        expect((yield* restarted.appendAll([waiting]))[0]?.commit).toBe(3);
      }).pipe(
        Effect.provide(
          runHistoryOverStore.pipe(
            Layer.provideMerge(graph([], substrate(storage).pipe(Layer.orDie))),
          ),
        ),
      );
    });
  });

  it.effect(
    'fences a second writer and transfers only released claims together',
    () => {
      const storage = workspace();
      return Effect.gen(function* () {
        const first = yield* Database;
        const targets = [
          qualifyAggregateId('run', RUN),
          qualifyAggregateId('run', OLDER),
        ];
        yield* first.appendAll([runStart, olderStart]);
        yield* Effect.gen(function* () {
          const second = yield* Database;
          // The lost single-owner race is typed and names the holder.
          const fenced = yield* Effect.flip(second.appendAll([waiting]));
          expect(fenced).toMatchObject({
            _tag: 'DatabaseNotOwner',
            aggregateId: waiting.aggregateId,
            ownerId: SELF,
            closed: false,
          });
          expect((yield* Effect.flip(second.acquireClaims(targets)))._tag).toBe(
            'DatabaseClaimRefused',
          );
          yield* second.releaseClaims(targets);
          expect(
            (yield* first.aggregateState(targets)).every(
              (row) => row.ownerId === SELF,
            ),
          ).toBe(true);
          yield* first.releaseClaims(targets);
          expect(yield* first.currentCommit).toBe(2);
          expect(
            (yield* second.aggregateState(targets)).every(
              (row) => row.ownerId === null,
            ),
          ).toBe(true);
          const wakeBeforeTransfer = yield* SubscriptionRef.get(first.level);
          yield* second.acquireClaims(targets);
          yield* TestClock.adjust('250 millis');
          expect(yield* SubscriptionRef.get(first.level)).toBeGreaterThan(
            wakeBeforeTransfer,
          );
          expect(
            (yield* first.aggregateState(targets)).every(
              (row) => row.ownerId === OTHER,
            ),
          ).toBe(true);
          expect(yield* second.currentCommit).toBe(2);
          // The claim moved: the former holder is now the fenced writer.
          expect(yield* Effect.flip(first.appendAll([waiting]))).toMatchObject({
            _tag: 'DatabaseNotOwner',
            ownerId: OTHER,
            closed: false,
          });
          expect((yield* second.appendAll([waiting]))[0]?.commit).toBe(3);
          const otherRoot = qualifyAggregateId('run', OLDER);
          const otherStart = (yield* first.aggregateState([otherRoot]))[0]!
            .startCommit!;
          for (const mode of ['bulk', 'automatic'] as const) {
            expect(
              yield* Effect.flip(
                Effect.flatten(
                  first.prepareRunRemoval(otherRoot, mode, otherStart),
                ),
              ),
            ).toMatchObject({
              _tag: 'DatabaseClaimRefused',
              verdict: 'unprovable',
            });
          }
          expect((yield* first.aggregateState([otherRoot]))[0]?.closed).toBe(
            false,
          );
          yield* Effect.flatten(
            first.prepareRunRemoval(otherRoot, 'single', otherStart),
          );
          expect((yield* first.aggregateState([otherRoot]))[0]?.closed).toBe(
            true,
          );
        }).pipe(Effect.provide(substrate(storage, OTHER)));
      }).pipe(Effect.provide(substrate(storage)));
    },
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
            purpose: 'turn',
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

  it.effect('live state equals reloaded state', () =>
    Effect.gen(function* () {
      const events = yield* SessionEvents;
      const run = yield* RunHistory;
      yield* events.transact((append) => append([runStart]));
      const cell = yield* run.open(RUN, {
        activation: () => Effect.succeed([]),
      });
      yield* openTurn(cell);
      yield* cell.append([settled('call-a'), toolEnd('call-a')]);
      yield* cell.append([
        settled('call-b', { disposition: 'duplicate', duplicateOf: 'call-a' }),
        toolEnd('call-b'),
      ]);
      const state = yield* cell.append([
        group,
        snapshot(),
        {
          type: 'run.position',
          aggregateId: AGGREGATE,
          payload: { family: 'toolUse', at: 'turn.end', turn: 1 },
        },
      ]);
      expect(state.messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'tool',
      ]);
      expect(yield* run.load(RUN)).toEqual(state);
    }).pipe(Effect.provide(runHistory())),
  );

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
        const written = (yield* log.readAggregate(AGGREGATE, 1)).length;
        const orphan = yield* cell
          .append([settled('call-z'), toolEnd('call-z')])
          .pipe(Effect.flip);
        expect(refusalOf(orphan)?.reason).toBe('inconsistent');
        expect((yield* log.readAggregate(AGGREGATE, 1)).length).toBe(written);
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
        expect((yield* log.readAggregate(AGGREGATE, 1)).length).toBe(written);
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
                  // Not part of the row shape: the decode must drop it.
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
                purpose: 'turn',
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
