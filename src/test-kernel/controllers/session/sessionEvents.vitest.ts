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
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

// Third-party imports
import { it } from '@effect/vitest';
import { build } from 'esbuild';
import * as SqlDriver from '@effect/sql-sqlite-node/SqliteClient';
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Scope,
  Fiber,
  Layer,
  Stream,
  SubscriptionRef,
} from 'effect';
import { TestClock } from 'effect/testing';
import * as Reactivity from 'effect/unstable/reactivity/Reactivity';

import { afterAll, beforeAll, describe, expect, vi } from 'vitest';

vi.mock('@effect/sql-sqlite-node/SqliteClient', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@effect/sql-sqlite-node/SqliteClient')
  >()),
}));

import { runLedgerLayer } from '@agent/runtime/RunLedger';
import { sessionEventsLayer } from '@agent/runtime/SessionEvents';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  closeSession,
  listSessions,
  openSessionEffect,
} from '@agent/runtime/sessionGraph';
import { createSessionApprovals } from '@agent/runtime/runApprovalQueue';
import { SESSION_CLOSE_DEADLINE_MS } from '@agent/runtime/sessionGraph';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { inquiryRecordsLayer } from '@controllers/session/inquiryRecords';
import {
  databaseLayer,
  globalDatabaseLayer,
  storeOpenElsewhere,
} from '@controllers/session/Database';
import { openProjectStateStore } from '@controllers/session/appStateStore';
import { collectPendingDeletions } from '@controllers/session/deletionCleanup';
import { openStore } from '@controllers/session/storeSchema';
import { sessionRequests } from '@controllers/session/SessionRequests';
import { runActionGuard } from '@controllers/session/runActionGuard';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from '@controllers/session/sessionSources';
import { SessionViewService } from '@controllers/session/SessionView';
import { sessionInputsLayer } from '@controllers/session/sessionInputs';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { withProcessServices } from '@platform/processRuntime';
import { AppState, type StateStore } from '@platform/interfaces';
import type { ProcessProbe } from '@platform/defaults/nodeProcesses';
import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  AgentConfigFieldsSchema,
  emptyRunEndOutput,
  LocalRuntimeStateSchema,
  RUN_PHASE,
  RunIdSchema,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import { Database } from '@shared/session/database';
import { runActions } from '@shared/session/runActions';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { RunLedger, RunLedgerRefused } from '@shared/session/runLedger';
import type { RunLedgerDraft } from '@shared/session/runStateFold';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import { DownMessageSchema } from '@shared/session/sessionFrames';
import type { SessionView } from '@shared/session/sessionView';
import { untrackRun, closeSessionOf } from '@test/support/sessionEnd';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import {
  nodeSpawnerLayer,
  scriptedSpawnerLayer,
} from '@test/support/childProcessTestLayer';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { identityReads } from '@test/support/sessionGraphTestSetup';
import { REPO_ROOT } from '@test/support/repoScan';
import type { LeanLanguageServices } from '@tools/lean/leanLanguageServices';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/** A second OS process's writer: this build's `Database` over the store at
 *  `storage`, owned as `owner`, creating `run` and, once `<storage>/go`
 *  exists, appending `rows` positions to it, one transaction each. */
const STORE_WRITER = `
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { databaseLayer } from '@controllers/session/Database';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { nodePlatformServices } from '@platform/defaults/nodePlatform';
import { aggregateId, AgentCategory } from '@shared/schemas';
import { Database } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';

const [storage, owner, run, rows] = process.argv.slice(2);
const id = aggregateId('run', run);
const append = Effect.gen(function* () {
  const db = yield* Database;
  yield* db.appendAll([{ type: 'run.start', aggregateId: id,
    identity: { kind: 'agent', agent: 'chat' }, userFollowUpSupport: 'unsupported',
    category: AgentCategory.ToolUse, parent: null }]);
  while (!existsSync(join(storage, 'go'))) yield* Effect.sleep('1 millis');
  for (let i = 0; i < Number(rows); i += 1)
    yield* db.appendAll([{ type: 'run.position', aggregateId: id,
      payload: { family: 'toolUse', at: 'waiting' } }]);
});
await Effect.runPromise(append.pipe(Effect.provide(databaseLayer('persistent').pipe(
  Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
  Layer.provide(ProcessIdentity.layer(owner)),
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

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  platform: vi.fn(() => process.platform),
}));
/** Builds of the process runtime's Lean layer, which every root shares. */
const leanBuilds = vi.hoisted(() => ({
  count: 0,
  state: undefined as StateStore | undefined,
}));
vi.mock('@tools/lean/direct/directLspAdapter', async () => {
  const { Effect, Layer } = await import('effect');
  const { AppState } = await import('@platform/interfaces');
  const { LeanLanguageServices } =
    await import('@tools/lean/leanLanguageServices');
  return {
    directLeanLanguageServices: () =>
      Layer.effect(
        LeanLanguageServices,
        Effect.gen(function* () {
          leanBuilds.count += 1;
          leanBuilds.state = yield* AppState;
          return {} as LeanLanguageServices['Service'];
        }),
      ),
  };
});

const SELF = '["test-host",4242,"self-start"]';
const OTHER = '["test-host",4343,"other-start"]';
/** The run every case here is about; one id, the key of its one aggregate. */
const RUN = RunIdSchema.parse('ab12cd');
const OLDER = RunIdSchema.parse('ab12ce');
const NEWER = RunIdSchema.parse('ef56ab');

/** Wait on the fold's level until it holds a view `ready` accepts: the ref
 *  replays its current value on subscribe, so a view already there ends the
 *  wait at once and a later one ends it when the fold publishes it. */
const settle = (
  view: SubscriptionRef.SubscriptionRef<SessionView>,
  ready: (view: SessionView) => boolean,
) =>
  SubscriptionRef.changes(view).pipe(Stream.takeUntil(ready), Stream.runDrain);

const runStart: SessionEventDraft = {
  type: 'run.start',
  aggregateId: qualifyAggregateId('run', RUN),
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'unsupported',
  category: AgentCategory.ToolUse,
  parent: null,
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
  > = databaseLayer('ephemeral').pipe(Layer.orDie),
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
        const settled = yield* events.publish([
          {
            type: 'tool.end',
            aggregateId,
            logId: 'card-1',
            status: 'completed',
            result: { toolName: 'bash', output: { output: '' } },
          },
        ]);
        yield* events.settle;
        const rows = yield* Stream.runCollect(events.aggregate(aggregateId, 2));
        expect([...rows].map((row) => [row.type, row.seq])).toEqual([
          ['tool.start', 2],
          ['tool.end', 3],
        ]);
        expect(settled.map((row) => row.seq)).toEqual([3]);
      }).pipe(Effect.provide(graph([runStart]))),
  );

  it.effect(
    'does not publish unchanged views for a burst of source wakeups',
    () =>
      Effect.gen(function* () {
        const view = yield* SessionViewService;
        const text = yield* TextChunkSource;
        const events = yield* SessionEvents;
        yield* settle(
          view.ref,
          (state) => state.runs.has(RUN) && state.cursor === 1,
        );
        const initial = yield* SubscriptionRef.get(view.ref);
        const observed: SessionView[] = [];
        const finished = yield* Deferred.make<void>();
        yield* Effect.forkScoped(
          view.changes.pipe(
            Stream.drop(1),
            Stream.runForEach((state) =>
              Effect.gen(function* () {
                observed.push(state);
                if (state.cursor > initial.cursor) {
                  yield* Deferred.succeed(finished, undefined);
                }
              }),
            ),
          ),
        );
        yield* Effect.yieldNow;
        // A level notification can arrive after an earlier read has already
        // consumed its data. Repeating it must neither publish another view nor
        // prevent the next committed event from reaching the reader.
        const held = yield* SubscriptionRef.get(text.ref);
        for (let index = 0; index < 150; index += 1) {
          yield* SubscriptionRef.set(text.ref, held);
        }
        yield* TestClock.adjust('1 second');
        expect(yield* SubscriptionRef.get(view.ref)).toBe(initial);
        expect(observed).toHaveLength(0);
        yield* events.publish([waiting]);
        yield* Deferred.await(finished);
        expect(observed.length).toBeGreaterThan(0);
        expect(observed.every((state) => state.cursor > initial.cursor)).toBe(
          true,
        );
        expect(observed.at(-1)?.runs.get(RUN)?.status).toBe(RUN_PHASE.WAITING);
      }).pipe(Effect.provide(graph([runStart]))),
  );

  it.effect('keeps an inquiry independent of the run it was asked under', () =>
    Effect.gen(function* () {
      const events = yield* SessionEvents;
      const log = yield* Database;
      const threadId = 'ei_012345abcdef';
      const run = qualifyAggregateId('run', RUN);
      const inquiry = qualifyAggregateId('inquiry', threadId);
      const committed = yield* events.publish([
        runStart,
        {
          type: 'inquiryThreadUpdated',
          aggregateId: inquiry,
          threadId,
          parentRunId: null,
          status: 'open',
          lastQuestionPreview: 'Which boundary condition applies?',
          lastActivityIso: '2026-09-06T12:00:00.000Z',
          turnCount: 1,
        },
        { type: 'run.removed', aggregateId: run },
      ]);
      expect(yield* log.readAll(0)).toEqual(committed);
      expect((yield* log.aggregateState([run]))[0]?.closed).toBe(true);
      expect((yield* log.aggregateState([inquiry]))[0]?.closed).toBe(false);
      const rows = yield* Stream.runCollect(events.aggregate(inquiry, 0));
      expect(rows.map(({ type, seq }) => ({ type, seq }))).toEqual([
        { type: 'inquiryThreadUpdated', seq: 1 },
      ]);
    }).pipe(Effect.provide(graph([]))),
  );

  it.effect('hangs a workflow checkpoint under the run that invoked it', () =>
    Effect.gen(function* () {
      const events = yield* SessionEvents;
      const log = yield* Database;
      const checkpoint = qualifyAggregateId(
        'workflow-checkpoint',
        'cp-000000000000',
      );
      yield* events.publish([
        runStart,
        {
          type: 'workflow.script',
          aggregateId: checkpoint,
          parentRunId: RUN,
          script: 'return 1',
          args: { kind: 'undefined' },
          files: { inputFiles: [], contextFiles: [], mediaFiles: [] },
        },
      ]);
      // Without the edge the journal is unreachable once the run is gone:
      // deletion follows `parent_id`, and nothing else names this id.
      expect((yield* log.aggregateState([checkpoint]))[0]?.parentId).toBe(
        qualifyAggregateId('run', RUN),
      );
      yield* events.publish([
        { type: 'run.removed', aggregateId: qualifyAggregateId('run', RUN) },
      ]);
      expect((yield* log.aggregateState([checkpoint]))[0]?.closed).toBe(true);
    }).pipe(Effect.provide(graph([]))),
  );

  it.effect(
    'reparents an answered inquiry atomically before old-parent deletion',
    () =>
      Effect.gen(function* () {
        const db = yield* Database;
        const events = yield* SessionEvents;
        const oldParent = qualifyAggregateId('run', RUN);
        const newParentId = RunIdSchema.parse('aabbccdd1122');
        const newParent = qualifyAggregateId('run', newParentId);
        const inquiry = qualifyAggregateId('inquiry', 'ei_012345abcdef');
        const opened = {
          type: 'inquiryThreadUpdated' as const,
          aggregateId: inquiry,
          threadId: 'ei_012345abcdef',
          parentRunId: RUN,
          status: 'open' as const,
          lastQuestionPreview: 'Which boundary condition applies?',
          lastActivityIso: '2026-09-07T12:00:00.000Z',
          turnCount: 1,
        };
        yield* db.appendAll([
          runStart,
          { ...runStart, aggregateId: newParent },
          opened,
        ]);
        expect((yield* db.aggregateState([inquiry]))[0]).toMatchObject({
          parentId: oldParent,
          ownerId: null,
        });
        const invalid = yield* Effect.exit(
          db.appendAll([{ ...opened, parentRunId: newParentId }]),
        );
        expect(invalid._tag).toBe('Failure');
        expect((yield* db.aggregateState([inquiry]))[0]).toMatchObject({
          parentId: oldParent,
          ownerId: null,
        });
        expect(
          (yield* db.readAggregate(inquiry, 0)).map((row) => row.seq),
        ).toEqual([1]);
        yield* db.appendAll([{ ...opened, status: 'answered' }]);
        yield* db.releaseClaims([newParent]);
        expect(
          (yield* Effect.exit(
            db.appendAll([
              { ...opened, parentRunId: newParentId, turnCount: 2 },
            ]),
          ))._tag,
        ).toBe('Failure');
        expect((yield* db.aggregateState([inquiry]))[0]).toMatchObject({
          parentId: oldParent,
          ownerId: null,
        });
        expect((yield* db.readAggregate(inquiry, 0)).at(-1)?.seq).toBe(2);
        yield* db.acquireClaims([newParent]);
        yield* db.appendAll([
          { ...opened, parentRunId: newParentId, turnCount: 2 },
        ]);
        expect((yield* db.aggregateState([inquiry]))[0]).toMatchObject({
          parentId: newParent,
          ownerId: null,
        });
        expect(
          (yield* db.readAggregate(inquiry, 0)).map((row) => row.seq),
        ).toEqual([1, 2, 3]);
        yield* events.removeRun(
          oldParent,
          'single',
          (yield* db.aggregateState([oldParent]))[0]!.startCommit!,
        );
        expect((yield* db.aggregateState([inquiry]))[0]?.closed).toBe(false);
        yield* events.removeRun(
          newParent,
          'single',
          (yield* db.aggregateState([newParent]))[0]!.startCommit!,
        );
        expect((yield* db.aggregateState([inquiry]))[0]?.closed).toBe(true);
        expect(
          (yield* Effect.exit(
            db.appendAll([{ ...opened, status: 'answered' }]),
          ))._tag,
        ).toBe('Failure');
      }).pipe(Effect.provide(graph([]))),
  );

  /**
   * Failure mode: the tombstone commits around the publisher, so its
   * `run.removed` arm never runs and the removed run keeps its queued
   * follow-up and open stream in what the publisher tracks.
   */
  it.effect('forgets what a removed run left open or queued', () =>
    Effect.gen(function* () {
      const events = yield* SessionEvents;
      const run = qualifyAggregateId('run', RUN);
      const [start] = yield* events.publish([
        runStart,
        {
          type: 'followup.queued',
          aggregateId: run,
          followUpId: 'queued',
          content: { text: 'deliver me', from: { kind: 'user' } },
        },
        { type: 'stream.start', aggregateId: run, id: 's1', kind: 'default' },
      ]);
      expect(events.pendingFollowUps(run)).toHaveLength(1);
      expect(events.openWork(run)).toHaveLength(1);
      yield* events.removeRun(run, 'single', start!.commit);
      expect(events.pendingFollowUps(run)).toEqual([]);
      expect(events.openWork(run)).toEqual([]);
    }).pipe(Effect.provide(graph([]))),
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
      yield* events.publish([
        {
          type: 'request.decided',
          aggregateId: qualifyAggregateId('run', RUN),
          requestId: 'req-1',
          decision: { action: 'approve' },
        },
      ]);
      yield* events.publish([
        {
          type: 'run.position',
          aggregateId: qualifyAggregateId('run', RUN),
          payload: { family: 'toolUse', at: 'turn.begin', turn: 1 },
        },
      ]);
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

  it.effect(
    'folds a pending request to waiting only while its owner is live',
    () =>
      Effect.gen(function* () {
        const view = yield* SessionViewService;
        const local = yield* LocalRuntimeSource;
        yield* settle(view.ref, (v) => v.runs.has(RUN));
        // This process owns the run: it waits on the user.
        const own = yield* SubscriptionRef.get(view.ref);
        expect(own.runs.get(RUN)?.group).toBe('waiting');
        expect(own.rollup).toMatchObject({ waiting: 1, interrupted: 0 });
        // The owner is another process that is gone: nothing can answer.
        yield* SubscriptionRef.set(local.ref, {
          self: [OTHER],
          dead: [SELF],
          unreadable: [],
        });
        yield* settle(
          view.ref,
          (v) => v.runs.get(RUN)?.group === 'interrupted',
        );
        const orphaned = yield* SubscriptionRef.get(view.ref);
        expect(orphaned.runs.get(RUN)?.group).toBe('interrupted');
        expect(orphaned.runs.get(RUN)?.readOnly).toBe(false);
        // The owner is another process that is alive: held, waiting on it.
        yield* SubscriptionRef.set(local.ref, {
          self: [OTHER],
          dead: [],
          unreadable: [],
        });
        yield* settle(view.ref, (v) => v.runs.get(RUN)?.readOnly === true);
        const held = yield* SubscriptionRef.get(view.ref);
        expect(held.runs.get(RUN)?.group).toBe('waiting');
        expect(held.runs.get(RUN)?.readOnly).toBe(true);
        // A live process can release its claim without writing another event.
        const db = yield* Database;
        const id = qualifyAggregateId('run', RUN);
        yield* db.releaseClaims([id]);
        yield* settle(view.ref, (v) => v.runs.get(RUN)?.ownerId === null);
        const released = yield* SubscriptionRef.get(view.ref);
        expect(released.cursor).toBe(held.cursor);
        expect(released.runs.get(RUN)?.group).toBe('interrupted');
        expect(released.runs.get(RUN)?.readOnly).toBe(false);
        expect((yield* db.readAggregate(id, 1))[0]?.origin).toBe(SELF);
      }).pipe(Effect.provide(graph([runStart, waiting, requested]))),
  );
  it.effect('lists stored run facts in commit order and on the wire', () =>
    Effect.gen(function* () {
      const events = yield* SessionEvents;
      const log = yield* Database;
      const view = yield* SessionViewService;
      yield* settle(view.ref, (v) => v.runs.size === 2);
      const listed = yield* SubscriptionRef.get(view.ref);
      const older = listed.runs.get(OLDER);
      const newer = listed.runs.get(NEWER);
      // Distinct commits in the store's order, so the run registry keeps the
      // transcript's creation order rather than falling back to the id.
      expect(older?.createdAt).toBeGreaterThanOrEqual(1);
      expect(newer?.createdAt).toBeGreaterThan(older?.createdAt ?? 0);
      expect(newer?.description).toBe('the newer run');
      // Every listing row is a wire-valid event: the webview parses the
      // replay frame whole and drops it on one bad seq.
      const rows = yield* log.readListing();
      const frame = DownMessageSchema.safeParse({
        kind: 'events',
        session: 'k',
        generation: 0,
        cursor: 0,
        events: rows.map((event) => ({
          _tag: 'event',
          read: 'listing',
          event,
        })),
        chunks: [],
        local: null,
        host: null,
        debug: false,
        replayComplete: true,
        blocked: [],
        existence: {
          checkedAggregateIds: rows.map(({ aggregateId }) => aggregateId),
          removedAggregateIds: [],
          claims: rows.map(({ aggregateId, origin }) => ({
            aggregateId,
            ownerId: origin,
          })),
        },
      });
      expect(
        frame.success,
        frame.success ? '' : JSON.stringify(frame.error.issues, null, 1),
      ).toBe(true);
      // A run born after the build enters through its own row alone,
      // above the reserved space, so a renderer attached at open sees it
      // as new.
      yield* events.publish([
        { ...runStart, aggregateId: qualifyAggregateId('run', RUN) },
      ]);
      yield* settle(view.ref, (v) => v.runs.has(RUN));
      const live = yield* SubscriptionRef.get(view.ref);
      expect(live.runs.get(RUN)?.createdAt).toBeGreaterThan(
        newer?.createdAt ?? 0,
      );
      expect(live.runs.size).toBe(3);
    }).pipe(
      Effect.provide(
        graph([
          { ...runStart, aggregateId: qualifyAggregateId('run', OLDER) },
          { ...runStart, aggregateId: qualifyAggregateId('run', NEWER) },
          {
            type: 'run.description',
            aggregateId: qualifyAggregateId('run', NEWER),
            description: 'the newer run',
          },
        ]),
      ),
    ),
  );
});

/**
 * The session owner (proposal 2026-09-05, sections 3 and 9): `closeSession`
 * is how a session the `Sessions` map holds behind `openSessionEffect` ends.
 */
describe('Sessions owner', () => {
  it.effect(
    'admits requests by current claims despite a stale displayed owner',
    () =>
      Effect.gen(function* () {
        const db = yield* Database;
        const view = yield* SessionViewService;
        const local = yield* SubscriptionRef.make(
          LocalRuntimeStateSchema.parse({
            self: [OTHER],
            dead: [],
            unreadable: [],
          }),
        );
        const stop = vi.fn(() => ({
          accepted: () => true,
          settlement: Effect.void,
        }));
        const session = {
          view: view.ref,
          runs: { stop },
          roots: createFakeWorkspaceRoots({
            globalState: { [GlobalStateKey.DETACH_SUBAGENTS_ON_STOP]: true },
          }),
        } as unknown as SessionHandle;
        const requests = sessionRequests(
          session,
          createSessionApprovals(),
          { ...db, removeRun: (yield* SessionEvents).removeRun },
          local,
          yield* InquiryRecords,
        );
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
          inquiryRecordsLayer.pipe(
            Layer.provide(
              globalDatabaseLayer(
                createFakeWorkspaceRoots().globalStorage,
              ).pipe(
                Layer.provide(ProcessIdentity.layer(SELF)),
                Layer.provide(nodePlatformLayer),
                Layer.orDie,
              ),
            ),
          ),
        ),
      ),
  );

  it.effect(
    'refuses a delete rendered before the run started, and a second concurrent resume',
    () =>
      Effect.gen(function* () {
        const db = yield* Database;
        const view = yield* SessionViewService;
        const removeRun = vi.fn((yield* SessionEvents).removeRun);
        const requests = sessionRequests(
          { view: view.ref } as unknown as SessionHandle,
          createSessionApprovals(),
          { ...db, removeRun },
          yield* SubscriptionRef.make(
            LocalRuntimeStateSchema.parse({
              self: [SELF],
              dead: [],
              unreadable: [],
            }),
          ),
          yield* InquiryRecords,
        );
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
              return [id, { ...started, actions: runActions(started) }];
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

        // A second Resume while the first is in flight is refused at once,
        // not queued behind the first's whole run.
        const guard = runActionGuard(
          {} as Pick<SessionHandle, 'runView' | 'runs'>,
        );
        const finish = yield* Deferred.make<void>();
        const first = yield* Effect.forkChild(
          guard.resuming(Deferred.await(finish), RUN),
          { startImmediately: true },
        );
        const second = yield* guard
          .resuming(Effect.void, RUN)
          .pipe(Effect.flip);
        expect(second.reason).toBe('This run is already resuming.');
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(first);
        yield* guard.resuming(Effect.void, RUN);
      }).pipe(
        Effect.provide(graph([runStart])),
        Effect.provide(
          inquiryRecordsLayer.pipe(
            Layer.provide(
              globalDatabaseLayer(
                createFakeWorkspaceRoots().globalStorage,
              ).pipe(
                Layer.provide(ProcessIdentity.layer(SELF)),
                Layer.provide(nodePlatformLayer),
                Layer.orDie,
              ),
            ),
          ),
        ),
      ),
  );

  const open = (storagePath: string) =>
    openSessionEffect({
      roots: createFakeWorkspaceRoots({ storagePath }),
      transcriptMode: { kind: 'ephemeral', reason: 'sessions owner test' },
    });
  const isLive = (session: SessionHandle) =>
    Effect.map(listSessions(), (live) => live.includes(session));
  const track = (session: SessionHandle, runId: RunId) =>
    session.runs.track(testRunHandle({ runId, agent: 'chat' }));

  it.live(
    'shares the project database with its session until the project closes',
    () =>
      withProcessServices(
        testRuntime(),
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Effect.acquireRelease(
              Effect.sync(() =>
                mkdtempSync(join(tmpdir(), 'texra-project-owned-')),
              ),
              (root) =>
                Effect.sync(() =>
                  rmSync(root, { recursive: true, force: true }),
                ),
            );
            const opened = vi.spyOn(SqlDriver, 'make');
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => opened.mockRestore()),
            );
            const projectScope = yield* Scope.make();
            yield* Effect.addFinalizer(() =>
              Scope.close(projectScope, Exit.void),
            );
            const state = yield* openProjectStateStore(storage, undefined).pipe(
              Scope.provide(projectScope),
            );
            yield* state.update('shared', 'before session');
            const session = yield* Effect.acquireRelease(
              openSessionEffect({
                roots: {
                  ...createFakeWorkspaceRoots({ storagePath: storage }),
                  workspaceState: state,
                },
              }),
              (session) => closeSessionOf(session),
            );
            expect(
              opened.mock.calls.filter(
                ([options]) =>
                  options.readonly !== true &&
                  options.filename ===
                    join(realpathSync.native(storage), 'texra.db'),
              ),
            ).toHaveLength(1);
            yield* closeSessionOf(session);
            // Closing the graph releases its borrow, never the still-open project's state.
            yield* state.update('shared', 'after session');
            expect(yield* state.get('shared')).toBe('after session');
            yield* Scope.close(projectScope, Exit.void);
            expect((yield* Effect.flip(state.get('shared')))._tag).toBe(
              'StateReadFailed',
            );
            const reopened = yield* openProjectStateStore(storage, undefined);
            expect(yield* reopened.get('shared')).toBe('after session');
          }),
        ),
      ),
  );

  it.live('builds the process-wide Lean layer once, not per session', () =>
    Effect.gen(function* () {
      // Each root's entry is built fresh over the root-scoped layers; the
      // Lean pool must stay outside that `fresh` so its servers stay shared.
      yield* open('/workspace/owner/lean-once-a');
      yield* open('/workspace/owner/lean-once-b');
      yield* closeSession('/workspace/owner/lean-once-a');
      yield* closeSession('/workspace/owner/lean-once-b');
      expect(leanBuilds.count).toBe(1);
      expect(leanBuilds.state).toBe(
        yield* withProcessServices(testRuntime(), AppState),
      );
    }),
  );

  it.live('reads the process identity once, not per session', () =>
    Effect.gen(function* () {
      // `ProcessIdentity` is provided outside the entry's `Layer.fresh`, so
      // its read is the process's and no open repeats it. Counted over the
      // whole file: every session this module graph opened shares it.
      yield* open('/workspace/owner/identity-once-a');
      yield* open('/workspace/owner/identity-once-b');
      yield* closeSession('/workspace/owner/identity-once-a');
      yield* closeSession('/workspace/owner/identity-once-b');
      expect(identityReads.count).toBe(1);
    }),
  );

  // Real polling loops (`vi.waitFor`) on the process runtime's live work:
  // `it.live`, so nothing the session does waits on a test clock.
  it.live(
    'delivers committed runtime facts and never announces a rejected write',
    () =>
      Effect.gen(function* () {
        const session = yield* open('/workspace/owner/committed-status');
        const sweep = vi.spyOn(session.runs, 'sweepChildrenOfFoldedStop');

        try {
          session.publish([
            runStart,
            { ...runStart, aggregateId: qualifyAggregateId('run', OLDER) },
            {
              type: 'run.removed',
              aggregateId: qualifyAggregateId('run', RUN),
            },
          ]);
          yield* session.settlePublications();
          expect(session.now()).toBe(3);
          session.publish([
            {
              type: 'run.position',
              aggregateId: qualifyAggregateId('run', RUN),
              payload: { family: 'toolUse', at: 'waiting' },
            },
          ]);
          session.publish([
            {
              type: 'run.position',
              aggregateId: qualifyAggregateId('run', OLDER),
              payload: { family: 'toolUse', at: 'waiting' },
            },
          ]);
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(
                SubscriptionRef.getUnsafe(session.view).runs.get(OLDER)?.status,
              ).toBe(RUN_PHASE.WAITING),
            ),
          );
          const received = yield* Effect.all(
            [RUN, OLDER].map((id) =>
              Stream.runCollect(
                session.events.aggregate(qualifyAggregateId('run', id), 0),
              ),
            ),
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
            output: emptyRunEndOutput(AgentCategory.ToolUse),
          } as const;
          session.publish([
            { ...runEnd, aggregateId: qualifyAggregateId('run', RUN) },
          ]);
          session.publish([
            { ...runEnd, aggregateId: qualifyAggregateId('run', OLDER) },
          ]);
          yield* session.settlePublications();
          const committed = yield* Stream.runCollect(
            session.events.aggregate(qualifyAggregateId('run', OLDER), 0),
          );
          // The live run's `run.end` reaches the folded-stop sweep once the
          // view has folded it, and a `waiting` step never does; the
          // foreign-owned replay below must add none.
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(sweep).toHaveBeenCalledOnce()),
          );
          expect(sweep).toHaveBeenCalledWith(OLDER);
          for (const event of committed) {
            const foreign = { ...event, origin: OTHER };
            yield* session.receiveFoldedEvent(foreign);
          }
          expect(sweep).toHaveBeenCalledOnce();
        } finally {
          sweep.mockRestore();
          yield* closeSessionOf(session);
        }
      }),
  );

  // A fire-and-forget publication settles on its own schedule, and the drain
  // that decides a run's terminal row can arrive after it already rejected. A
  // failure dropped at that moment would let the row call itself the
  // post-drain fact of facts that rolled back, with no `artifact-drain`
  // marker: the failure is kept until the drain that answers for that run
  // reports it, and cleared by the one that does.
  it.live(
    "a failed publication outlives every barrier until its run's drain takes it, once",
    () =>
      Effect.gen(function* () {
        const session = yield* open('/workspace/owner/retained-failure');
        try {
          session.publish([runStart]);
          yield* session.settlePublications(RUN);
          // A second `run.start` on the live aggregate violates its sequence:
          // the batch rolls back whole and the publication fails.
          session.publish([runStart]);
          // A sibling run's drain awaits every publication — so this one has
          // settled by the time it returns — and reports no fact of this run's.
          yield* session.settlePublications(OLDER);
          // A session-wide settle is a barrier (host exit takes one before it
          // releases each live run's lease; so does a child launch): it awaits
          // every publication and answers for the session's own facts, so this
          // run's stays tracked for the drain that marks the row it decides.
          yield* session.settlePublications();
          // A mid-run barrier (the loop's park) observes without answering:
          // it reports the run's rollback so the run ends on it, and leaves
          // the failure for the drain that decides the terminal row, which is
          // the only place the `artifact-drain` marker can still be stamped.
          expect(
            yield* Effect.flip(
              session.settlePublications(RUN, { consume: false }),
            ),
          ).toMatchObject({ _tag: 'DatabaseWriteFailed' });
          expect(
            yield* Effect.flip(session.settlePublications(RUN)),
          ).toMatchObject({ _tag: 'DatabaseWriteFailed' });
          // Once: the drain that told the run cleared it, so the next drain
          // does not fail a run whose remaining facts are whole.
          yield* session.settlePublications(RUN);
        } finally {
          yield* closeSessionOf(session);
        }
      }),
  );

  // The request opened below commits from this fiber, so the session's own
  // work must not wait on a test clock: `it.live`.
  it.live(
    'close reports settled once the run ended, and releases the session',
    () =>
      Effect.gen(function* () {
        const session = yield* open('/workspace/owner/settled');
        session.publish([runStart]);
        yield* session.settlePublications();
        // A request nobody answers: the fold lists it while the fiber that
        // opened it waits on the decision.
        const pending = yield* Effect.forkScoped(
          session.openRequest(RUN, {
            kind: 'planApproval',
            data: {
              requestId: 'closing-plan',
              runId: RUN,
              plan: { objective: 'Settle the pending request during close.' },
            },
          }),
        );
        const requestIds = () =>
          SubscriptionRef.getUnsafe(session.view).requests.map(
            (request) => request.requestId,
          );
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(requestIds()).toEqual(['closing-plan'])),
        );
        // The run's teardown interrupts the fiber waiting on the decision,
        // which closes the request as cancelled: the close leaves no pending
        // request behind in the fold.
        yield* Fiber.interrupt(pending);
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(requestIds()).toEqual([])),
        );
        const settled = RunIdSchema.parse('aa0001');
        track(session, settled);
        // The run completes: its driver untracks it as it unwinds.
        untrackRun(session.runs, settled);
        // A native child between turns, detached from its stopped parent: its
        // activation is its only record, so the close must stop it itself, and
        // wait for the loop to release the activation after its last delivery.
        let releaseChild = (): void => {};
        const interrupt = vi.fn(() => releaseChild());
        releaseChild = session.runs.reserveChildActivation({
          runId: RunIdSchema.parse('aa0002'),
          parent: { current: null },
          retainsTerminalParent: true,
          interrupt,
        });

        expect(yield* closeSession('/workspace/owner/settled')).toEqual({
          settled: true,
          abandoned: [],
        });
        expect(interrupt).toHaveBeenCalledOnce();
        expect(SubscriptionRef.getUnsafe(session.view).cursor).toBe(
          session.now(),
        );
        expect(yield* isLive(session)).toBe(false);
      }),
  );

  it.effect(
    'close reports a failed stop, settles the run it reached no driver for, and releases the session',
    () =>
      Effect.gen(function* () {
        const root = '/workspace/owner/stop-defect';
        const session = yield* open(root);
        const runId = RunIdSchema.parse('aa0005');
        track(session, runId);
        vi.spyOn(session.runs, 'stop').mockReturnValue({
          accepted: () => false,
          settlement: Effect.fail(new Error('terminal write refused')),
        });

        expect(yield* closeSession(root)).toEqual({
          settled: true,
          abandoned: [],
        });
        expect(yield* isLive(session)).toBe(false);
      }),
  );

  it.effect(
    'close settles a run still live past the budget, reports it abandoned, and releases the session',
    () =>
      Effect.gen(function* () {
        const session = yield* open('/workspace/owner/abandoned');
        // A run whose driver takes the stop and never unwinds.
        const slow = RunIdSchema.parse('aa0003');
        session.runs.reserveChildActivation({
          runId: slow,
          parent: { current: null },
          retainsTerminalParent: false,
          interrupt: () => {},
        });
        const closing = yield* Effect.forkChild(
          closeSession('/workspace/owner/abandoned'),
        );
        // Let the forked close reach its settlement wait and register the
        // budget's sleep before the clock moves past the deadline.
        yield* Effect.promise(
          () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
        );
        yield* TestClock.adjust(`${SESSION_CLOSE_DEADLINE_MS} millis`);
        expect(yield* Fiber.join(closing)).toEqual({
          settled: false,
          abandoned: [slow],
        });
        expect(yield* isLive(session)).toBe(false);
      }),
  );
});

/**
 * The cutover substrate (persistence-substrate-decision 6.1, stage 1): the
 * C1 tables and the C6 write path. Nothing production reads them yet, so
 * these assertions are the whole acceptance for the schema and the
 * publisher.
 */
describe('the C1 event table and the C6 publisher', () => {
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

  it.effect('never replaces an earlier backup when it retires a store', () => {
    // A user restored another pre-1.0 store beside an earlier retirement's
    // copy: a rename onto `.pre1` would delete that copy on most platforms.
    const storage = workspace();
    return Effect.gen(function* () {
      const earlier = join(storage, 'texra.db.pre1');
      writeFileSync(earlier, 'the earlier backup');
      yield* legacyStore(storage, 44);
      const moved = yield* Database.pipe(
        Effect.map((database) => database.movedAside),
        Effect.provide(substrate(storage)),
      );
      expect(moved?.aside).toBe(
        join(realpathSync.native(storage), 'texra.db.pre1.2'),
      );
      expect(readFileSync(earlier, 'utf8')).toBe('the earlier backup');
    });
  });

  it.effect(
    'tells a prune a store another process holds from one that is not SQLite',
    () => {
      // `texra doctor --prune-storage` keeps an open store, and lists a
      // damaged one as unreadable instead of aborting the run on it.
      const held = join(workspace(), 'texra.db');
      const garbage = join(workspace(), 'texra.db');
      writeFileSync(garbage, 'not a database, just some text '.repeat(200));
      const holder = new DatabaseSync(held);
      holder.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (v);');
      return Effect.gen(function* () {
        expect(yield* storeOpenElsewhere(held)).toBe('open');
        expect(yield* storeOpenElsewhere(garbage)).toBe('unreadable');
        holder.close();
        expect(yield* storeOpenElsewhere(held)).toBe('free');
      }).pipe(
        Effect.ensuring(Effect.sync(() => holder.isOpen && holder.close())),
      );
    },
  );

  for (const [kind, stamp, why] of [
    // No TeXRA stamp and no TeXRA tables: not a pre-1.0 store, so nothing
    // retires it.
    ['unstamped', '', 'tables notes'],
    // Stamped by another application, even at the 1.0 schema's number.
    [
      'stamped',
      'PRAGMA application_id = 1234; PRAGMA user_version = 101;',
      'application id 1234',
    ],
  ] as const)
    it.effect(`refuses a foreign SQLite file (${kind}) untouched`, () => {
      // Another tool's database at the store's path.
      const storage = workspace();
      return Effect.gen(function* () {
        yield* Effect.sync(() => {
          const connection = reader(storage);
          try {
            connection.exec(
              `CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('mine'); ${stamp}`,
            );
          } finally {
            connection.close();
          }
        });
        const before = readFileSync(join(storage, 'texra.db'));
        const failure = yield* Effect.flip(
          Database.pipe(Effect.provide(substrate(storage))),
        );
        expect(failure._tag).toBe('DatabaseOpenFailed');
        expect(failure.message).toContain('not a TeXRA session store');
        expect(failure.message).toContain(why);
        expect(readFileSync(join(storage, 'texra.db'))).toEqual(before);
        expect(readdirSync(storage)).toEqual(['texra.db']);
        const stored = reader(storage);
        try {
          expect(stored.prepare('SELECT body FROM notes').all()).toEqual([
            { body: 'mine' },
          ]);
        } finally {
          stored.close();
        }
      });
    });

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
            rows: yield* database.readAll(0),
          };
        }).pipe(Effect.provide(substrate(storage)));
        expect(opened, `cut at ${length} bytes`).toEqual({
          movedAside: {
            path: file,
            aside: expect.stringMatching(/texra\.db\.corrupt-\d+$/),
            reason: 'corrupt',
          },
          rows: [],
        });
        expect(readFileSync(opened.movedAside!.aside)).toEqual(truncated);
      });
    }),
  );

  it.effect(
    'marks a projection that skipped a newer row, so a build that reads it rebuilds',
    () => {
      // A newer build's run.config lands where this build catches the
      // listing up: it cannot read the row, so the projection it builds
      // lacks it. Checkpointed past it unmarked, a build that reads the row
      // would trust that checkpoint and never list it.
      const storage = workspace();
      const bump = (version: number) =>
        Effect.sync(() => {
          const raw = reader(storage);
          try {
            raw.exec(`UPDATE event SET version = ${version} WHERE type = 'run.config';
              UPDATE stored_kind SET version = ${version} WHERE type = 'run.config';
              DROP TABLE projection_state;`);
          } finally {
            raw.close();
          }
        });
      const listing = Database.pipe(
        Effect.flatMap((database) => database.readListing()),
        Effect.map((rows) => rows.map((row) => row.type)),
        Effect.provide(substrate(storage)),
      );
      return Effect.gen(function* () {
        yield* Database.pipe(
          Effect.flatMap((database) =>
            database.appendAll([
              runStart,
              {
                type: 'run.config',
                aggregateId: runStart.aggregateId,
                config: AgentConfigFieldsSchema.parse({
                  agentCategory: AgentCategory.ToolUse,
                  model: 'test-model',
                }),
              },
            ]),
          ),
          Effect.provide(substrate(storage)),
        );
        yield* bump(2);
        expect(yield* listing).toEqual(['run.start']);
        const marked = reader(storage);
        try {
          expect(
            marked
              .prepare(
                "SELECT version FROM projection_state WHERE name = 'listing'",
              )
              .get(),
          ).toEqual({ version: -1 });
          // The row becomes one this build reads: as a newer build sees it.
          marked.exec(`UPDATE event SET version = 1 WHERE type = 'run.config';
            UPDATE stored_kind SET version = 1 WHERE type = 'run.config';`);
        } finally {
          marked.close();
        }
        expect(yield* listing).toEqual(['run.start', 'run.config']);
      });
    },
  );

  it.effect(
    'refuses a claim of a run a newer build wrote to since this connection last looked',
    () => {
      // A newer build commits a row this build cannot read and releases the
      // run before this connection's poll has seen it: its verdict cache is
      // stale, so only the claim's own transaction can refuse.
      const storage = workspace();
      return Effect.gen(function* () {
        const db = yield* Database;
        yield* db.appendAll([runStart, waiting]);
        yield* Effect.sync(() => {
          const raw = reader(storage);
          try {
            raw.exec(`UPDATE event SET version = 2 WHERE type = 'run.position';
              UPDATE stored_kind SET version = 2 WHERE type = 'run.position';
              UPDATE event_sequence SET owner_id = NULL;`);
          } finally {
            raw.close();
          }
        });
        expect(yield* db.readBlocked()).toEqual([]);
        const refused = yield* Effect.flip(
          db.acquireClaims([runStart.aggregateId]),
        );
        expect(refused).toMatchObject({
          _tag: 'DatabaseWriteFailed',
          cause: { _tag: 'DatabaseAggregateBlocked', type: 'run.position' },
        });
        const stored = reader(storage);
        try {
          expect(
            stored
              .prepare('SELECT owner_id AS owner FROM event_sequence')
              .get(),
          ).toEqual({ owner: null });
        } finally {
          stored.close();
        }
      }).pipe(Effect.provide(substrate(storage)));
    },
  );

  it.effect(
    'leaves a store another process already recovered from damage in place',
    () => {
      // Two processes saw the same damaged file. The first moved it aside
      // and created a fresh store; the second, recovering after it, must not
      // move that fresh store aside as if it were the damaged one.
      const storage = workspace();
      return Effect.gen(function* () {
        yield* Database.pipe(
          Effect.flatMap((database) => database.appendAll([runStart])),
          Effect.provide(substrate(storage)),
        );
        const filename = join(realpathSync.native(storage), 'texra.db');
        let attempts = 0;
        const connect = Effect.suspend(() =>
          (attempts += 1) === 1
            ? Effect.die(
                Object.assign(new Error('file is not a database'), {
                  errcode: 26,
                }),
              )
            : SqlDriver.make({ filename }),
        );
        const opened = yield* openStore(
          connect,
          SqlDriver.make({ filename, readonly: true, disableWAL: true }),
          'persistent',
          filename,
          filename,
        );
        expect(opened.movedAside).toBeNull();
        expect(
          readdirSync(storage).filter((name) => name.includes('.corrupt-')),
        ).toEqual([]);
        const rows = yield* opened.sql.unsafe<{ n: number }>(
          'SELECT count(*) AS n FROM event',
          [],
        );
        expect(rows[0]?.n).toBe(1);
      }).pipe(
        Effect.provide(Layer.merge(nodePlatformLayer, Reactivity.layer)),
        Effect.scoped,
      );
    },
  );

  it.effect(
    'lists a run whose own run.start a newer build wrote as blocked',
    () => {
      // The unreadable row is the one that creates the run: without it the
      // run would vanish from every listing instead of reading as blocked.
      const storage = workspace();
      return Effect.gen(function* () {
        yield* Database.pipe(
          Effect.flatMap((database) => database.appendAll([runStart, waiting])),
          Effect.provide(substrate(storage)),
        );
        yield* Effect.sync(() => {
          const raw = reader(storage);
          try {
            raw.exec(`UPDATE event SET version = 2 WHERE type = 'run.start';
            UPDATE stored_kind SET version = 2 WHERE type = 'run.start';`);
          } finally {
            raw.close();
          }
        });
        yield* Effect.gen(function* () {
          const view = yield* SessionViewService;
          yield* settle(view.ref, (v) => v.runs.has(RUN));
          const run = (yield* SubscriptionRef.get(view.ref)).runs.get(RUN);
          expect(run).toMatchObject({ blocked: 'newer', readOnly: true });
          const refused = yield* Effect.flip(
            (yield* Database).acquireClaims([runStart.aggregateId]),
          );
          expect(refused).toMatchObject({
            _tag: 'DatabaseWriteFailed',
            cause: { _tag: 'DatabaseAggregateBlocked', type: 'run.start' },
          });
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
      expect(failure.message).toContain('Update TeXRA');
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

  it.effect('rolls back a failed commit before reusing the connection', () => {
    const storage = workspace();
    return Effect.gen(function* () {
      const database = yield* Database;
      const connection = yield* Effect.acquireRelease(
        Effect.sync(() => reader(storage)),
        (opened) => Effect.sync(() => opened.close()),
      );
      connection.exec(`
        CREATE TABLE accepted_run (id TEXT PRIMARY KEY);
        INSERT INTO accepted_run VALUES ('${OLDER}');
        CREATE TABLE committed_run (
          id TEXT REFERENCES accepted_run(id) DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TRIGGER validate_run AFTER INSERT ON event
        BEGIN
          INSERT INTO committed_run VALUES (
            (SELECT logical_id FROM event_sequence WHERE id = NEW.aggregate));
        END;
      `);

      const failed = yield* Effect.exit(database.appendAll([runStart]));
      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed)) {
        expect(Cause.pretty(failed.cause)).toContain(
          'FOREIGN KEY constraint failed',
        );
      }
      expect(yield* SubscriptionRef.get(database.level)).toBe(0);
      expect(yield* SubscriptionRef.get(database.observedCommit)).toBe(0);

      const committed = yield* database.appendAll([olderStart]);
      expect(committed).toHaveLength(1);
      expect(committed[0]?.commit).toBe(1);
      expect(yield* database.readAll(0)).toEqual(committed);
      expect(connection.prepare('SELECT id FROM committed_run').all()).toEqual([
        { id: OLDER },
      ]);
      expect(yield* SubscriptionRef.get(database.level)).toBe(1);
      expect(yield* SubscriptionRef.get(database.observedCommit)).toBe(1);
    }).pipe(Effect.provide(substrate(storage)), Effect.scoped);
  });

  it.effect('wakes readers when cancellation arrives during commit', () =>
    Effect.gen(function* () {
      let writer: Fiber.Fiber<unknown, unknown> | undefined;
      const original = SqlDriver.make;
      const construct = vi
        .spyOn(SqlDriver, 'make')
        .mockImplementation((options) =>
          original(options).pipe(
            Effect.map((client) =>
              Object.assign(client, {
                reserve: client.reserve.pipe(
                  Effect.map((connection) => ({
                    ...connection,
                    executeUnprepared: (
                      ...args: Parameters<typeof connection.executeUnprepared>
                    ) =>
                      connection.executeUnprepared(...args).pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            if (args[0] === 'COMMIT') writer?.interruptUnsafe();
                          }),
                        ),
                      ),
                  })),
                ),
              }),
            ),
          ),
        );
      yield* Effect.gen(function* () {
        const database = yield* Database;
        const append = yield* Effect.forkChild(
          Effect.withFiber((fiber) => {
            writer = fiber;
            return database.appendAll([olderStart]);
          }),
        );
        const exit = yield* Fiber.await(append);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* SubscriptionRef.get(database.level)).toBe(1);
        expect(yield* SubscriptionRef.get(database.observedCommit)).toBe(1);
        expect(yield* database.readAll(0)).toHaveLength(1);
      }).pipe(
        Effect.provide(substrate(workspace())),
        Effect.ensuring(Effect.sync(() => construct.mockRestore())),
      );
    }).pipe(Effect.scoped),
  );

  it.effect('cancels a queued database append before it starts', () =>
    Effect.gen(function* () {
      const captured =
        yield* Deferred.make<
          Effect.Success<ReturnType<typeof SqlDriver.make>>
        >();
      const original = SqlDriver.make;
      const construct = vi
        .spyOn(SqlDriver, 'make')
        .mockImplementation((...args) =>
          original(...args).pipe(
            Effect.tap((client) => Deferred.succeed(captured, client)),
          ),
        );
      yield* Effect.gen(function* () {
        const database = yield* Database;
        const sql = yield* Deferred.await(captured);
        const held = yield* Scope.make();
        yield* Scope.provide(sql.reserve, held);
        const waiting = yield* Effect.forkChild(
          database.appendAll([olderStart]),
        );
        yield* Effect.yieldNow;
        waiting.interruptUnsafe();
        yield* Effect.yieldNow;
        yield* Scope.close(held, Exit.succeed(undefined));
        yield* Fiber.await(waiting);
        const rows = yield* database.readAll(0);
        expect(rows).toEqual([]);
      }).pipe(
        Effect.provide(substrate(workspace())),
        Effect.ensuring(Effect.sync(() => construct.mockRestore())),
      );
    }).pipe(Effect.scoped),
  );

  it.effect('keeps polling for other writers after a failed poll read', () =>
    Effect.gen(function* () {
      const storage = workspace();
      let failCommitRead = false;
      const original = SqlDriver.make;
      const construct = vi
        .spyOn(SqlDriver, 'make')
        .mockImplementationOnce((options) =>
          original(options).pipe(
            Effect.map((client) => {
              const unsafe = client.unsafe.bind(client);
              // The poll's first read of the new commit fails, as a busy
              // wait past the timeout would, after its version read passed.
              // The commit read is built once and re-run, so the check is
              // made on each run.
              return Object.assign(client, {
                unsafe: ((statement, params) => {
                  const read = unsafe(statement, params);
                  if (!statement.includes('sqlite_sequence')) return read;
                  return Effect.suspend(() => {
                    if (!failCommitRead) return read;
                    failCommitRead = false;
                    return Effect.die(new Error('database is locked'));
                  });
                }) as typeof client.unsafe,
              });
            }),
          ),
        );
      yield* Effect.gen(function* () {
        const follower = yield* Database;
        yield* Effect.gen(function* () {
          const writer = yield* Database;
          yield* writer.appendAll([olderStart]);
        }).pipe(Effect.provide(substrate(storage, OTHER)));
        failCommitRead = true;
        for (let tick = 0; tick < 8; tick++) {
          yield* TestClock.adjust('250 millis');
        }
        expect(failCommitRead).toBe(false);
        expect(yield* SubscriptionRef.get(follower.observedCommit)).toBe(1);
        expect(yield* SubscriptionRef.get(follower.level)).toBe(1);
      }).pipe(
        Effect.provide(substrate(storage)),
        Effect.ensuring(Effect.sync(() => construct.mockRestore())),
      );
    }).pipe(Effect.scoped),
  );

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
        // The writer is the process, stamped by the layer (C5), and `at` is
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
          parent: { id: RUN },
        };
        // A missing parent rejects the complete batch, including the earlier
        // creation and the child's sequence reservation.
        const rejected = yield* Effect.flip(
          db.appendAll([
            runStart,
            { ...child, parent: { id: RunIdSchema.parse('ffff00') } },
          ]),
        );
        expect(rejected._tag).toBe('DatabaseWriteFailed');
        expect(yield* db.readAll(0)).toEqual([]);
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
        expect(yield* db.readAll(0)).toEqual(created);
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
                RunIdSchema.parse('ab12d0'),
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

  it.effect(
    'commits rows another connection reads back, on a verified WAL connection',
    () => {
      const storage = workspace();
      return Effect.gen(function* () {
        const db = yield* Database;
        const now = yield* Clock.currentTimeMillis;
        const suppliedEnvelope = {
          ...runStart,
          seq: 700,
          commit: 800,
          origin: OTHER,
          at: 1,
        };
        yield* db.appendAll([suppliedEnvelope, olderStart]);

        const observed = yield* Effect.sync(() => {
          const raw = reader(storage);
          try {
            return {
              journal: raw.prepare('PRAGMA journal_mode').get()?.journal_mode,
              foreignKeys: raw.prepare('PRAGMA foreign_keys').get()
                ?.foreign_keys,
              events: raw
                .prepare(
                  `SELECT "commit" AS "commit", aggregate, seq, type, version,
                          origin, at, data
                   FROM event ORDER BY "commit"`,
                )
                .all(),
              sequences: raw
                .prepare(
                  `SELECT id, kind, logical_id AS logicalId, seq,
                          owner_id AS ownerId, parent_id AS parentId,
                          start_commit AS startCommit, closed_by AS closedBy
                   FROM event_sequence ORDER BY id`,
                )
                .all(),
              integrity: raw.prepare('PRAGMA integrity_check').get()
                ?.integrity_check,
            };
          } finally {
            raw.close();
          }
        });

        expect(observed.journal).toBe('wal');
        expect(observed.foreignKeys).toBe(1);
        expect(observed.integrity).toBe('ok');
        // The envelope C1 gives its own columns is in those columns, and the
        // payload holds the arm and nothing the envelope already carries.
        expect(observed.events).toEqual([
          {
            commit: 1,
            aggregate: 1,
            seq: 1,
            type: 'run.start',
            version: 1,
            origin: SELF,
            at: now,
            data: JSON.stringify({
              identity: runStart.identity,
              userFollowUpSupport: 'unsupported',
              category: AgentCategory.ToolUse,
              parent: null,
            }),
          },
          {
            commit: 2,
            aggregate: 2,
            seq: 1,
            type: 'run.start',
            version: 1,
            origin: SELF,
            at: now,
            data: JSON.stringify({
              identity: runStart.identity,
              userFollowUpSupport: 'unsupported',
              category: AgentCategory.ToolUse,
              parent: null,
            }),
          },
        ]);
        // Creation claims the run: one aggregate, one sequence row, and no
        // parent link for a root.
        expect(observed.sequences).toEqual([
          {
            id: 1,
            kind: 'run',
            logicalId: RUN,
            seq: 1,
            ownerId: SELF,
            parentId: null,
            startCommit: 1,
            closedBy: null,
          },
          {
            id: 2,
            kind: 'run',
            logicalId: OLDER,
            seq: 1,
            ownerId: SELF,
            parentId: null,
            startCommit: 2,
            closedBy: null,
          },
        ]);
      }).pipe(Effect.provide(substrate(storage)));
    },
  );

  it.effect(
    'rejects malformed present configuration before creating the run',
    () => {
      const storage = workspace();
      return Effect.gen(function* () {
        const db = yield* Database;
        const config = AgentConfigFieldsSchema.parse({
          agentCategory: AgentCategory.ToolUse,
          model: 'test-model',
        });
        const configured: SessionEventDraft = {
          type: 'run.config',
          aggregateId: runStart.aggregateId,
          config,
        };
        const malformed = {
          ...configured,
          config: { ...config, toolConfig: { autoCompileInputPdf: 'yes' } },
        } as unknown as SessionEventDraft;
        const failure = yield* Effect.flip(db.appendAll([runStart, malformed]));
        expect(failure._tag).toBe('DatabaseWriteFailed');
        expect(yield* db.readAll(0)).toEqual([]);
        expect(yield* SubscriptionRef.get(db.level)).toBe(0);

        const committed = yield* db.appendAll([runStart, configured]);
        expect(yield* db.readAll(0)).toEqual(committed);
        expect(committed[1]).toMatchObject({ config });
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

  it.effect(
    'reports non-JSON payloads as typed write failures before assigning ordinals',
    () => {
      const storage = workspace();
      return Effect.gen(function* () {
        const db = yield* Database;
        const failure = yield* Effect.flip(
          db.appendAll([
            {
              type: 'log',
              aggregateId: runStart.aggregateId,
              level: 'info',
              message: 'non-json',
              data: 1n as never,
            },
          ]),
        );
        expect(failure._tag).toBe('DatabaseWriteFailed');
        expect(yield* SubscriptionRef.get(db.level)).toBe(0);
        expect((yield* db.appendAll([runStart]))[0]?.commit).toBe(1);
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
      // A second host process deletes the whole aggregate: the C1 cascade
      // takes its events with it, and the AUTOINCREMENT high-water mark
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
   * Outlined strings (the design's §2). Failure modes: a string of 4 KB or
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
      const script = (
        id: string,
        run: RunId,
        args: object,
      ): SessionEventDraft => ({
        type: 'workflow.script',
        aggregateId: qualifyAggregateId('workflow-checkpoint', id),
        parentRunId: run,
        script: shared,
        args: { kind: 'json', value: { ...args, $b: 'mine', $$b: [shared] } },
        files: { inputFiles: [], contextFiles: [], mediaFiles: [] },
      });
      const drafts = [
        runStart,
        olderStart,
        script('cp-000000000001', RUN, { solo }),
        script('cp-000000000002', OLDER, {}),
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
          yield* collectPendingDeletions(db, storage);
        });
      return Effect.gen(function* () {
        const db = yield* Database;
        yield* db.appendAll(drafts);
        const scripts = (yield* db.readAll(0)).filter(
          (event) => event.type === 'workflow.script',
        );
        expect(
          scripts.map(({ script, args }) => JSON.stringify({ script, args })),
        ).toEqual(
          drafts.slice(2).map((draft) =>
            JSON.stringify({
              script: shared,
              args: 'args' in draft && draft.args,
            }),
          ),
        );
        const raw = reader(storage);
        try {
          const data = raw
            .prepare("SELECT data FROM event WHERE type = 'workflow.script'")
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
            fresh.readAggregate(
              qualifyAggregateId('workflow-checkpoint', 'cp-000000000002'),
              0,
            ),
          );
        }).pipe(Effect.provide(substrate(storage)));
        expect(reopened).toMatchObject({ cause: { reason: 'corrupt' } });
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
        const absent = qualifyAggregateId('run', RunIdSchema.parse('ab99ff'));
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
        expect(yield* db.readAll(2, 5)).toEqual(rows.slice(2, 5));
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
        // A closed target is the typed ownership refusal (D6 b); a seq-1
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
        const inquiry = qualifyAggregateId('inquiry', 'ei_012345abcdef');
        const thread = {
          type: 'inquiryThreadUpdated',
          aggregateId: inquiry,
          threadId: 'ei_012345abcdef',
          parentRunId: RUN,
          status: 'open',
          lastQuestionPreview: 'Which boundary condition applies?',
          lastActivityIso: '2026-09-06T12:00:00.000Z',
          turnCount: 1,
        } as const;
        const initial = yield* first.appendAll([
          runStart,
          olderStart,
          { ...thread, status: 'answered' },
          { ...thread, parentRunId: OLDER, turnCount: 2 },
          {
            ...thread,
            parentRunId: OLDER,
            status: 'answered',
            turnCount: 2,
          },
          { ...thread, turnCount: 3 },
        ]);
        expect((yield* first.aggregateState([inquiry]))[0]?.parentId).toBe(
          root,
        );
        expect(
          (yield* Effect.flip(
            first.appendAll([
              { ...thread, parentRunId: RunIdSchema.parse('ffff00') },
            ]),
          ))._tag,
        ).toBe('DatabaseWriteFailed');
        // Visiting the first asker again must not let its delayed turn-1
        // answer regress state and then admit the former asker's turn-2 open.
        const staleBatches: SessionEventDraft[][] = [
          [
            { ...thread, status: 'answered' },
            { ...thread, parentRunId: OLDER, turnCount: 2 },
          ],
          [
            {
              ...thread,
              parentRunId: OLDER,
              status: 'answered',
              turnCount: 2,
            },
          ],
          [{ ...thread, parentRunId: OLDER, turnCount: 2 }],
        ];
        for (const stale of staleBatches) {
          expect((yield* Effect.flip(first.appendAll(stale)))._tag).toBe(
            'DatabaseWriteFailed',
          );
        }
        expect(yield* first.readAll(0)).toEqual(initial);
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
          expect(yield* first.readAll(0)).toEqual(initial);
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
          ).toMatchObject({
            _tag: 'DatabaseWriteFailed',
          });
          expect(yield* first.readAll(0)).toEqual(initial);
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
        // Neither a late update nor a new inquiry can attach to the tombstoned asker.
        for (const draft of [
          thread,
          { ...thread, parentRunId: OLDER },
          {
            ...thread,
            aggregateId: qualifyAggregateId('inquiry', 'ei_abcdef012345'),
            threadId: 'ei_abcdef012345',
          },
        ]) {
          expect((yield* Effect.flip(first.appendAll([draft])))._tag).toBe(
            'DatabaseWriteFailed',
          );
        }
        expect(yield* first.currentCommit).toBe(8);
        const tombstone = committed.at(-1)!;
        const cleanupError = new Error(
          'The generated directory is not writable.',
        );
        expect(
          yield* Effect.flip(
            first.collectDeletion(root, tombstone.commit, () =>
              Effect.gen(function* () {
                yield* Effect.gen(function* () {
                  const second = yield* Database;
                  const remove = vi.fn(() => Effect.void);
                  expect(
                    yield* Effect.result(
                      second.collectDeletion(root, tombstone.commit, remove),
                    ),
                  ).toMatchObject({
                    _tag: 'Failure',
                    failure: { _tag: 'DatabaseWriteFailed' },
                  });
                  expect(remove).not.toHaveBeenCalled();
                }).pipe(Effect.provide(substrate(storage, OTHER)));
                return yield* Effect.fail(cleanupError);
              }),
            ),
          ),
        ).toBe(cleanupError);
        expect((yield* first.readAggregate(root, 0)).at(-1)).toEqual(tombstone);
        // Losing the claim during file removal preserves the database record.
        expect(
          yield* Effect.flip(
            first.collectDeletion(root, tombstone.commit, () =>
              first.releaseClaims([root]),
            ),
          ),
        ).toMatchObject({ _tag: 'DatabaseWriteFailed' });
        expect((yield* first.readAggregate(root, 0)).at(-1)).toEqual(tombstone);
        const unrelated: SessionEventDraft = {
          ...runStart,
          aggregateId: qualifyAggregateId('run', NEWER),
        };
        yield* first.collectDeletion(root, tombstone.commit, (ids) =>
          Effect.gen(function* () {
            expect(ids).toEqual([RUN]);
            // Cleanup holds its root claim, not the database write permit.
            // Unrelated runs remain writable while generated files are removed.
            yield* first.appendAll([unrelated]);
          }),
        );
        expect(yield* first.aggregateState([root, inquiry])).toEqual([]);
        expect(
          (yield* first.readAll(0)).map((event) => event.aggregateId),
        ).toEqual([olderStart.aggregateId, unrelated.aggregateId]);
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
        yield* collectPendingDeletions(first, storage);
        expect(existsSync(join(outside, 'keep.tex'))).toBe(true);
        expect(
          yield* first.aggregateState([unrelated.aggregateId]),
        ).toMatchObject([{ closed: true, ownerId: null }]);
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
        yield* collectPendingDeletions(first, storage);
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
   * Two OS processes on one file (the storage design's §8 and §11): a child
   * Node process appends to its run while this one appends to its own and
   * reads. Failure modes: an append lost to `SQLITE_BUSY`; a seq or commit
   * skipped or reused; a commit this connection observed going backwards;
   * and this process's thread held in SQLite's busy wait past the 25 ms
   * slice instead of retrying on its fiber schedule.
   */
  it.live('shares one store with another OS process', () => {
    const storage = workspace();
    const ROWS = 400;
    const own = qualifyAggregateId('run', RUN);
    const theirs = qualifyAggregateId('run', OLDER);
    return Effect.gen(function* () {
      const writer = yield* Effect.promise(() => bundleStoreWriter(storage));
      const db = yield* Database;
      const observed: number[] = [];
      yield* SubscriptionRef.changes(db.observedCommit).pipe(
        Stream.runForEach((commit) => Effect.sync(() => observed.push(commit))),
        Effect.forkScoped,
      );
      yield* db.appendAll([runStart]);
      const child = spawn(
        process.execPath,
        [writer, storage, OTHER, OLDER, String(ROWS)],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      );
      const exited = new Promise<number | null>((done) =>
        child.on('exit', (code) => done(code)),
      );
      // The child has opened the store and created its run; both then start
      // appending at once, so the two contend for the lock.
      while ((yield* db.aggregateState([theirs])).length === 0) {
        expect(child.exitCode, 'the writer exited before writing').toBeNull();
        yield* Effect.sleep('5 millis');
      }
      const delay = monitorEventLoopDelay({ resolution: 5 });
      delay.enable();
      writeFileSync(join(storage, 'go'), '');
      for (let i = 0; i < ROWS; i += 1) {
        yield* db.appendAll([waiting]);
        yield* db.readAggregate(own, i + 1);
      }
      const code = yield* Effect.promise(() => exited);
      delay.disable();
      expect(code).toBe(0);
      const total = 2 * (ROWS + 1);
      while ((yield* SubscriptionRef.get(db.observedCommit)) < total)
        yield* Effect.sleep('50 millis');
      const rows = yield* db.readAll(0);
      expect(rows.map((row) => row.commit)).toEqual(
        Array.from({ length: total }, (_, i) => i + 1),
      );
      for (const id of [own, theirs])
        expect(
          rows.filter((row) => row.aggregateId === id).map((row) => row.seq),
        ).toEqual(Array.from({ length: ROWS + 1 }, (_, i) => i + 1));
      expect(observed).toEqual(observed.toSorted((a, b) => a - b));
      expect(observed.at(-1)).toBe(total);
      // The busy slice bounds one wait in SQLite; the retry sleeps on the
      // fiber. A thread held for the whole contention fails this.
      expect(delay.max / 1e6).toBeLessThan(250);
    }).pipe(Effect.provide(substrate(storage)), Effect.scoped);
  });

  /**
   * C14: the lease file is gone, so the only thing that frees a crashed
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
        const events = yield* SessionEvents;
        expect(yield* restarted.claimOwner(target)).toEqual({
          ownerId: CRASHED,
          liveness: 'dead',
        });
        // Fenced until the claim moves: the run is another owner's.
        expect((yield* Effect.flip(restarted.appendAll([waiting])))._tag).toBe(
          'DatabaseNotOwner',
        );
        expect(events.pendingFollowUps(target)).toEqual([]);
        yield* (yield* RunLedger).acquire(RUN);
        expect((yield* restarted.aggregateState([target]))[0]?.ownerId).toBe(
          SELF,
        );
        // The claim that moved here seeds the input the crash left queued.
        expect(events.pendingFollowUps(target)).toEqual([followUp]);
        // The resumed run appends onto the rows the crash left behind.
        expect((yield* restarted.appendAll([waiting]))[0]?.commit).toBe(3);
      }).pipe(
        Effect.provide(
          runLedgerLayer.pipe(
            Layer.provideMerge(sessionEventsLayer),
            Layer.provideMerge(substrate(storage)),
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
          // The lost single-owner race is typed and names the holder (D6 b).
          const fenced = yield* Effect.flip(second.appendAll([waiting]));
          expect(fenced).toMatchObject({
            _tag: 'DatabaseNotOwner',
            aggregateId: waiting.aggregateId,
            ownerId: SELF,
            closed: false,
          });
          expect((yield* Effect.flip(second.acquireClaims(targets)))._tag).toBe(
            'DatabaseWriteFailed',
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
              _tag: 'DatabaseWriteFailed',
              cause: { _tag: 'DatabaseClaimRefused', verdict: 'unprovable' },
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
// The run ledger over the real publisher and the real (in-memory) store: no
// second `RunLedger`, no hand-written `SessionEvents`, so a schema mistake
// fails here rather than in the PR that turns the writes on.
// ---------------------------------------------------------------------------

describe('RunLedger', () => {
  const ledger = () =>
    runLedgerLayer.pipe(
      Layer.provideMerge(sessionEventsLayer),
      Layer.provideMerge(databaseLayer('ephemeral').pipe(Layer.orDie)),
      Layer.provide(
        Layer.succeed(WorkspaceRoots)(
          createFakeWorkspaceRoots({ storagePath: '/workspace/ledger' }),
        ),
      ),
      Layer.provide(ProcessIdentity.layer(SELF)),
      Layer.provide(nodePlatformLayer),
    );
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
      ordinal: 0,
      parallelSafe: false,
      replay: 'unsafe',
      partition: 0,
      duplicateOf: null,
      logId: 'card-a',
      stageId: null,
    },
    {
      callId: 'call-b',
      toolName: 'bash',
      ordinal: 1,
      parallelSafe: false,
      replay: 'unsafe',
      partition: 0,
      duplicateOf: 'call-a',
      logId: 'card-b',
      stageId: null,
    },
  ] as const;
  const snapshot = (): RunLedgerDraft => ({
    type: 'run.snapshot',
    aggregateId: AGGREGATE,
    payload: {
      family: 'toolUse',
      runtime: {
        modelId: 'gpt-test',
        modelCompatibilityKey: null,
        lastError: null,
        declinedRoutes: [],
      },
      state: {
        stateSlices: null,
      },
    },
  });
  const refusalOf = (error: unknown): RunLedgerRefused | null =>
    error instanceof RunLedgerRefused ? error : null;
  /** The approval a barrier call waits on, and the row that binds it. */
  const approvalRequested: RunLedgerDraft = {
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
  const approvalBinding: RunLedgerDraft = {
    type: 'tool.binding',
    aggregateId: AGGREGATE,
    payload: { callId: 'call-a', attempt: 1, requestId: 'req-1' },
  };
  const toolEnd = (callId: string): RunLedgerDraft => ({
    type: 'tool.end',
    aggregateId: AGGREGATE,
    logId: callId,
    status: 'completed',
  });
  const settled = (
    callId: string,
    body: Partial<
      Extract<RunLedgerDraft, { type: 'tool.result' }>['payload']
    > = {},
  ): RunLedgerDraft => ({
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
      stateMutation: [],
      ...body,
    },
  });
  const group: RunLedgerDraft = {
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
  const openTurn = (run: typeof RunLedger.Service) =>
    Effect.gen(function* () {
      let state = yield* run.appendBatch(RUN, null, [
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
      state = yield* run.appendBatch(RUN, state, [
        {
          type: 'model.message',
          aggregateId: AGGREGATE,
          payload: {
            kind: 'attempt',
            request: '0'.repeat(64),
            invocation: INVOCATION,
            origin: ORIGIN,
            delivery: 'stream',
          },
        },
      ]);
      state = yield* run.appendBatch(RUN, state, [
        {
          type: 'model.message',
          aggregateId: AGGREGATE,
          payload: {
            kind: 'identified',
            invocation: INVOCATION,
            providerResponseId: 'resp-1',
            returnedModel: null,
          },
        },
      ]);
      state = yield* run.appendBatch(RUN, state, [
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
          payload: { responseId: RESPONSE_ID, callIds: ['call-a'], attempt: 1 },
        },
      ]);
      return state;
    });

  it.effect('live state equals reloaded state', () =>
    Effect.gen(function* () {
      const events = yield* SessionEvents;
      const run = yield* RunLedger;
      yield* events.publish([runStart]);
      yield* run.acquire(RUN);
      let state = yield* openTurn(run);
      state = yield* run.appendBatch(RUN, state, [
        settled('call-a'),
        toolEnd('call-a'),
      ]);
      state = yield* run.appendBatch(RUN, state, [
        settled('call-b', { disposition: 'duplicate', duplicateOf: 'call-a' }),
        toolEnd('call-b'),
      ]);
      state = yield* run.appendBatch(RUN, state, [
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
    }).pipe(Effect.provide(ledger())),
  );

  it.effect(
    'holds the batch contract: a mismatched delivery dies, a loose-keyed attachment is accepted',
    () =>
      Effect.gen(function* () {
        const events = yield* SessionEvents;
        const run = yield* RunLedger;
        const log = yield* Database;
        yield* events.publish([runStart]);
        let state = yield* openTurn(run);
        // Delivering before the settlements committed is a caller defect.
        const early = yield* run
          .appendBatch(RUN, state, [group])
          .pipe(Effect.exit);
        expect(Exit.isFailure(early) && Cause.hasDies(early.cause)).toBe(true);
        // A batch the fold rejects commits nothing: the refusal has to mean
        // "not written", or every later `load` meets the orphan row.
        const written = (yield* log.readAggregate(AGGREGATE, 1)).length;
        const orphan = yield* run
          .appendBatch(RUN, state, [settled('call-z'), toolEnd('call-z')])
          .pipe(Effect.flip);
        expect(refusalOf(orphan)?.reason).toBe('inconsistent');
        expect((yield* log.readAggregate(AGGREGATE, 1)).length).toBe(written);
        expect(yield* run.load(RUN)).toEqual(state);
        // Same rule for the history the batch assembles: an append that leaves
        // a tool group with no calling assistant is refused before publishing,
        // not discovered on the next cold load.
        const orphanGroup = yield* run
          .appendBatch(RUN, state, [
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
        // The approval and the row that binds it commit in one batch; the
        // binding names the intent the rows already hold.
        state = yield* run.appendBatch(RUN, state, [
          approvalRequested,
          approvalBinding,
        ]);
        expect(state.requests['req-1']?.resolved).toBe(false);
        expect(state.pendingIntents['call-a']?.approvalRequestId).toBe('req-1');
        // A real attachment carries loose keys and binary fields: accepted, and
        // the binary fields never reach the row.
        state = yield* run.appendBatch(RUN, state, [
          settled('call-a', {
            result: {
              status: 'executed',
              output: 'ok',
              files: [
                {
                  path: 'out/plot.png',
                  mimeType: 'image/png',
                  base64Data: 'AAAA',
                  bytes: new Uint8Array([1, 2]),
                  sourceTool: 'bash',
                },
              ],
            },
          }),
          toolEnd('call-a'),
        ]);
        const file =
          state.pendingResponse?.settled['call-a']?.result.files?.[0];
        expect(file).toEqual({
          path: 'out/plot.png',
          mimeType: 'image/png',
          sourceTool: 'bash',
        });
        // A credential-bearing endpoint is refused before anything is written,
        // and the refusal carries the permitted components only: the rejected
        // query string is the credential this check exists to keep out.
        const unsafe = yield* run
          .appendBatch(RUN, state, [
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
                delivery: 'stream',
              },
            },
          ])
          .pipe(Effect.flip);
        expect(unsafe).toBeInstanceOf(RunLedgerRefused);
        expect(refusalOf(unsafe)?.reason).toBe('unsafe-endpoint');
        expect(refusalOf(unsafe)?.detail).not.toContain(SECRET);
        expect(refusalOf(unsafe)?.detail).toContain(
          'https://api.example.test/v1',
        );
      }).pipe(Effect.provide(ledger())),
  );
});
