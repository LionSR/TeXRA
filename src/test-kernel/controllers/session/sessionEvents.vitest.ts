/**
 * The session graph's durable boundary (PRD one-fold-three-renderers, 7.1
 * and 7.2, acceptance for lane 2): replay framing and the live-owner
 * waiting rule.
 *
 * Framing: the log a graph is built over is history under the plane's
 * anchor. The fold publishes nothing before the replay marker, so the first
 * state a mounting reader sees already holds the listing, the aggregate
 * history, and the local snapshot; the tail then publishes every commit in
 * order. The waiting rule: a pending approval on a run whose owner this
 * process holds (`self`) or whose owner is alive (`heldBy`) folds to
 * `waiting`; the same log with the owner gone folds to `interrupted`.
 */
import '@test/support/sessionGraphTestSetup';

// Node imports
import * as childProcess from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Third-party imports
import { it } from '@effect/vitest';
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

import { afterAll, beforeAll, describe, expect, vi } from 'vitest';

vi.mock('@effect/sql-sqlite-node/SqliteClient', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@effect/sql-sqlite-node/SqliteClient')
  >()),
}));

import { TraceEmitter } from '@agent/trace';
import { runLedgerLayer } from '@agent/runtime/RunLedger';
import { sessionEventsLayer } from '@agent/runtime/SessionEvents';
import {
  forEachLiveSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { closeSession, openSession } from '@agent/runtime/sessionGraph';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { inquiryRecordsLayer } from '@controllers/session/inquiryRecords';
import { databaseLayer } from '@controllers/session/Database';
import { collectPendingDeletions } from '@controllers/session/deletionCleanup';
import { sessionRequests } from '@controllers/session/SessionRequests';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from '@controllers/session/sessionSources';
import { SessionViewService } from '@controllers/session/SessionView';
import { sessionInputsLayer } from '@controllers/session/sessionInputs';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { SHUTDOWN_PHASE_DEADLINE_MS } from '@platform/defaults/lifecycleHost';
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
import { RunLedger, RunLedgerRefused } from '@shared/session/runLedger';
import type { RunLedgerDraft } from '@shared/session/runStateFold';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import { DownMessageSchema } from '@shared/session/sessionFrames';
import type { SessionView } from '@shared/session/sessionView';
import { createFakePlatform } from '@test/support/FakePlatform';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { StreamLogStore } from '@transcript/StreamLogStore';

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  platform: vi.fn(() => process.platform),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
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
  isRemote: false,
  parent: null,
};

const waiting: SessionEventDraft = {
  type: 'status',
  aggregateId: qualifyAggregateId('run', RUN),
  phase: RUN_PHASE.WAITING,
  cause: 'wait',
};

const requested: SessionEventDraft = {
  type: 'approval.requested',
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
const graph = (history: readonly SessionEventDraft[]) => {
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
        Layer.provideMerge(
          seeded.pipe(
            Layer.provideMerge(databaseLayer('ephemeral').pipe(Layer.orDie)),
          ),
        ),
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
  );
};

/** What a renderer would draw of each state: the run's status and the
 *  outstanding approvals, at the state's cursor. */
function drawn(view: SessionView) {
  return {
    cursor: view.cursor,
    status: view.runs.get(RUN)?.status ?? null,
    approvals: view.approvals.map((a) => a.requestId),
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

  it.effect(
    'reparents an answered inquiry atomically before old-parent deletion',
    () =>
      Effect.gen(function* () {
        const db = yield* Database;
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
        yield* db.removeRun(
          oldParent,
          'single',
          (yield* db.aggregateState([oldParent]))[0]!.startCommit!,
        );
        expect((yield* db.aggregateState([inquiry]))[0]?.closed).toBe(false);
        yield* db.removeRun(
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
          type: 'approval.resolved',
          aggregateId: qualifyAggregateId('run', RUN),
          requestId: 'req-1',
        },
      ]);
      yield* events.publish([
        {
          type: 'status',
          aggregateId: qualifyAggregateId('run', RUN),
          phase: RUN_PHASE.RUNNING,
          previousPhase: RUN_PHASE.WAITING,
          cause: 'resume',
        },
      ]);
      // The first state with the run in it has all of the history: no
      // state with the run started but not yet waiting, or waiting with
      // no approval, is ever published. The anchor is the seeded log's
      // level, so the history is under it and the tail repeats none of it.
      expect(drawnSequence(yield* Fiber.join(states))).toEqual([
        { cursor: 0, status: RUN_PHASE.WAITING, approvals: ['req-1'] },
        { cursor: 5, status: RUN_PHASE.RUNNING, approvals: [] },
      ]);
    }).pipe(Effect.provide(graph([runStart, waiting, requested]))),
  );

  it.effect(
    'folds a pending approval to waiting only while its owner is live',
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
        expect((yield* db.readAggregate(id, 1))[0]?.ownerId).toBe(SELF);
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
      // Distinct commits in the store's order, so the roster keeps the
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
        replayComplete: true,
        existence: {
          checkedAggregateIds: rows.map(({ aggregateId }) => aggregateId),
          removedAggregateIds: [],
          claims: rows.map(({ aggregateId, ownerId }) => ({
            aggregateId,
            ownerId,
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
 * is how a session the `Sessions` map holds behind `openSession` ends.
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
        const stopAgentRun = vi.fn(() => Effect.void);
        const session = {
          view: view.ref,
          runs: { stopAgentRun },
        } as unknown as SessionHandle;
        const requests = sessionRequests(
          session,
          db,
          local,
          yield* InquiryRecords,
        );
        // The displayed fold was built as SELF and considers this run writable.
        // This requesting process is OTHER; it must respect the current claim.
        yield* settle(view.ref, (v) => v.runs.has(RUN));
        expect(
          SubscriptionRef.getUnsafe(view.ref).runs.get(RUN)?.readOnly,
        ).toBe(false);
        const request = { kind: 'run.stop', runId: RUN } as const;
        const refused = yield* requests.request(request).pipe(Effect.flip);
        expect(refused._tag).toBe('NotOwner');
        expect(stopAgentRun).not.toHaveBeenCalled();

        yield* db.releaseClaims([qualifyAggregateId('run', RUN)]);
        yield* SubscriptionRef.update(view.ref, (v) => ({
          ...v,
          runs: new Map(
            [...v.runs].map(([id, run]) => [id, { ...run, readOnly: true }]),
          ),
        }));
        // A released claim is not held, even while the display still says so.
        expect(yield* requests.request(request)).toEqual({ kind: 'done' });
        expect(stopAgentRun).toHaveBeenCalledOnce();
      }).pipe(
        Effect.provide(graph([runStart])),
        Effect.provide(
          inquiryRecordsLayer(() =>
            createFakePlatform().storage.getGlobalStoragePath(),
          ).pipe(Layer.provide(ProcessIdentity.layer(SELF))),
        ),
      ),
  );

  const open = (storagePath: string) =>
    openSession({
      roots: createFakeWorkspaceRoots({ storagePath }),
      transcriptMode: { kind: 'ephemeral', reason: 'sessions owner test' },
    });
  const isLive = (session: SessionHandle): boolean => {
    let live = false;
    forEachLiveSession((candidate) => {
      live ||= candidate === session;
    });
    return live;
  };
  const track = (session: SessionHandle, runId: RunId) =>
    session.runs.track(testRunHandle({ runId, agent: 'chat' }));

  // Real polling loops (`vi.waitFor`) on the process runtime's live work:
  // `it.live`, so nothing the session does waits on a test clock.
  it.live(
    'delivers committed runtime facts and never announces a rejected write',
    () =>
      Effect.gen(function* () {
        const session = open('/workspace/owner/committed-status');
        const handleStatus = vi.spyOn(session.runs, 'handleStatus');
        const onResult = vi.fn();
        const detachResult = session.onResult(onResult);

        try {
          session.publish([
            runStart,
            { ...runStart, aggregateId: qualifyAggregateId('run', OLDER) },
            {
              type: 'run.removed',
              aggregateId: qualifyAggregateId('run', RUN),
            },
          ]);
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(session.now()).toBe(3)),
          );
          session.publishStatus({
            type: 'status',
            runId: RUN,
            phase: RUN_PHASE.COMPLETED,
            cause: 'lifecycle',
          });
          session.publishStatus({
            type: 'status',
            runId: OLDER,
            phase: RUN_PHASE.WAITING,
            cause: 'wait',
          });
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(handleStatus).toHaveBeenCalledOnce()),
          );
          expect(handleStatus).toHaveBeenCalledWith(OLDER);
          const received = yield* Effect.all(
            [RUN, OLDER].map((id) =>
              Stream.runCollect(
                session.events.aggregate(qualifyAggregateId('run', id), 0),
              ),
            ),
          );
          expect(
            received.flat().filter((event) => event.type === 'status'),
          ).toEqual([
            expect.objectContaining({
              type: 'status',
              aggregateId: qualifyAggregateId('run', OLDER),
              phase: RUN_PHASE.WAITING,
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
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce()),
          );
          expect(onResult.mock.calls[0][0]).toMatchObject({
            type: 'run.end',
            runId: OLDER,
            outcome: 'completed',
            seq: 3,
            commit: 5,
          });
          const committed = yield* Stream.runCollect(
            session.events.aggregate(qualifyAggregateId('run', OLDER), 0),
          );
          // `run.end` carries the terminal phase, so the live run's end is a
          // second status notification; the replay below must add none.
          const statusCalls = handleStatus.mock.calls.length;
          for (const event of committed)
            yield* session.receiveCommittedEvent({ ...event, ownerId: OTHER });
          expect(handleStatus).toHaveBeenCalledTimes(statusCalls);
          expect(onResult).toHaveBeenCalledOnce();
        } finally {
          detachResult();
          handleStatus.mockRestore();
          session.dispose();
        }
      }),
  );

  // #12017's ownership fence: a committed row another process authored is
  // accepted like any other, and only its local side effects are fenced.
  // (That the fold itself keeps a foreign-owned run is stated over the
  // recorded log in the fold suite.)
  it.live(
    "accepts another process's committed facts without firing local side effects",
    () =>
      Effect.gen(function* () {
        const session = open('/workspace/owner/foreign-fold');
        const onResult = vi.fn();
        const detachResult = session.onResult(onResult);
        const foreign = RunIdSchema.parse('cd34ef');
        const aggregateId = qualifyAggregateId('run', foreign);
        try {
          yield* session.receiveCommittedEvent({
            type: 'run.start',
            aggregateId,
            identity: { kind: 'agent', agent: 'chat' },
            userFollowUpSupport: 'unsupported',
            category: AgentCategory.ToolUse,
            isRemote: false,
            parent: null,
            ownerId: OTHER,
            at: 0,
            seq: 1,
            commit: 1,
          });
          yield* session.receiveCommittedEvent({
            type: 'run.description',
            aggregateId,
            description: 'a run in another process',
            ownerId: OTHER,
            at: 0,
            seq: 2,
            commit: 2,
          });
          yield* session.receiveCommittedEvent({
            type: 'run.end',
            aggregateId,
            outcome: 'completed',
            output: emptyRunEndOutput(AgentCategory.ToolUse),
            ownerId: OTHER,
            at: 0,
            seq: 3,
            commit: 3,
          });
          // Host presentation of a terminal result stays with the process
          // that authored it.
          expect(onResult).not.toHaveBeenCalled();
        } finally {
          detachResult();
          session.dispose();
        }
      }),
  );

  it.effect(
    'close reports settled once the run ended, and releases the session',
    () =>
      Effect.gen(function* () {
        const session = open('/workspace/owner/settled');
        session.publish([runStart]);
        yield* Effect.promise(() => session.settlePublications());
        const pending = session.interactions.requestPlanApproval({
          requestId: 'closing-plan',
          runId: RUN,
          plan: { objective: 'Settle the pending approval during close.' },
          goalEnabled: false,
        });
        yield* Effect.promise(() => session.settlePublications());
        expect(SubscriptionRef.getUnsafe(session.view).approvals).toHaveLength(
          1,
        );
        const settled = RunIdSchema.parse('aa0001');
        track(session, settled);
        // The run completes: its driver untracks it as it unwinds.
        session.runs.untrack(settled);
        // A native child between turns, detached from its stopped parent: its
        // activation is its only record, so the close must stop it itself, and
        // wait for the loop to release the activation after its last delivery.
        let releaseChild = (): void => {};
        const interrupt = vi.fn(() => releaseChild());
        releaseChild = session.runs.reserveChildActivation({
          runId: RunIdSchema.parse('aa0002'),
          parentRunId: settled,
          interrupt,
          detach: () => {},
          isDetached: () => true,
        });

        expect(yield* closeSession('/workspace/owner/settled')).toEqual({
          settled: true,
          abandoned: [],
        });
        expect(interrupt).toHaveBeenCalledOnce();
        expect(yield* Effect.promise(() => pending)).toMatchObject({
          action: 'reject',
        });
        expect(SubscriptionRef.getUnsafe(session.view).approvals).toHaveLength(
          0,
        );
        expect(SubscriptionRef.getUnsafe(session.view).cursor).toBe(
          session.now(),
        );
        expect(isLive(session)).toBe(false);
      }),
  );

  it.effect(
    'close retains the session until an untracked waiting generation finishes its owned teardown',
    () =>
      Effect.gen(function* () {
        const root = '/workspace/owner/waiting-teardown';
        const session = open(root);
        const handle = testRunHandle({
          runId: RunIdSchema.parse('aa0004'),
          agent: 'chat',
        });
        const release = yield* Deferred.make<void>();
        handle.suspend(
          Effect.gen(function* () {
            session.runs.untrack(handle.runId);
            yield* Deferred.await(release);
          }),
        );
        session.runs.track(handle);
        const closing = yield* Effect.forkChild(closeSession(root));
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(session.runs.getActiveIds()).toEqual([])),
        );
        yield* TestClock.adjust(`${SHUTDOWN_PHASE_DEADLINE_MS} millis`);
        expect(yield* Fiber.join(closing)).toEqual({
          settled: false,
          abandoned: [],
        });
        expect(isLive(session)).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(isLive(session)).toBe(false)),
        );
      }),
  );

  it.effect(
    'close reports a run still live past the budget as abandoned, and releases the session at its settlement',
    () =>
      Effect.gen(function* () {
        const session = open('/workspace/owner/abandoned');
        // A run that ignores its interrupt: no handler, no driver to unwind it.
        const slow = RunIdSchema.parse('aa0003');
        track(session, slow);
        const closing = yield* Effect.forkChild(
          closeSession('/workspace/owner/abandoned'),
        );
        // Let the forked close reach its settlement wait and register the
        // budget's sleep before the clock moves past the deadline.
        yield* Effect.promise(
          () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
        );
        yield* TestClock.adjust(`${SHUTDOWN_PHASE_DEADLINE_MS} millis`);
        expect(yield* Fiber.join(closing)).toEqual({
          settled: false,
          abandoned: [slow],
        });
        expect(isLive(session)).toBe(true);
        session.runs.untrack(slow);
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(isLive(session)).toBe(false)),
        );
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

  const substrate = (storage: string, owner = SELF) =>
    databaseLayer('persistent').pipe(
      Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
      Layer.provide(ProcessIdentity.layer(owner)),
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
    const mount = vi
      .mocked(childProcess.execFileSync)
      .mockReturnValue(`server:/paper on ${resolved} (nfs, nodev)\n`);
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Database.pipe(Effect.provide(substrate(storage))),
      );
      expect(failure._tag).toBe('DatabaseOpenFailed');
      expect(String(failure.cause)).toContain('verified local filesystem');
      expect(existsSync(join(storage, 'texra.db'))).toBe(false);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          mount.mockRestore();
          system.mockRestore();
        }),
      ),
    );
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
          INSERT INTO committed_run
            VALUES (json_extract(NEW.aggregate_id, '$[1]'));
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
        expect(first.every((e) => e.ownerId === SELF && e.at === now)).toBe(
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
        // database stamps its actual creation commit; the launcher names
        // only the parent's id.
        const created = yield* db.appendAll([runStart, child]);
        expect(created[1]).toMatchObject({
          parent: { id: RUN, startCommit: created[0]?.commit },
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
          ownerId: OTHER,
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
                  `SELECT "commit" AS "commit", aggregate_id AS aggregateId,
                          seq, type, owner_id AS ownerId, at, data
                   FROM event ORDER BY "commit"`,
                )
                .all(),
              sequences: raw
                .prepare(
                  `SELECT aggregate_id AS aggregateId, seq,
                          owner_id AS ownerId, parent_id AS parentId, closed
                   FROM event_sequence ORDER BY aggregate_id`,
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
            aggregateId: qualifyAggregateId('run', RUN),
            seq: 1,
            type: 'run.start.1',
            ownerId: SELF,
            at: now,
            data: JSON.stringify({
              identity: runStart.identity,
              userFollowUpSupport: 'unsupported',
              category: AgentCategory.ToolUse,
              isRemote: false,
              parent: null,
            }),
          },
          {
            commit: 2,
            aggregateId: qualifyAggregateId('run', OLDER),
            seq: 1,
            type: 'run.start.1',
            ownerId: SELF,
            at: now,
            data: JSON.stringify({
              identity: runStart.identity,
              userFollowUpSupport: 'unsupported',
              category: AgentCategory.ToolUse,
              isRemote: false,
              parent: null,
            }),
          },
        ]);
        // Creation claims the run: one aggregate, one sequence row, and no
        // parent link for a root.
        expect(observed.sequences).toEqual([
          {
            aggregateId: qualifyAggregateId('run', RUN),
            seq: 1,
            ownerId: SELF,
            parentId: null,
            closed: 0,
          },
          {
            aggregateId: qualifyAggregateId('run', OLDER),
            seq: 1,
            ownerId: SELF,
            parentId: null,
            closed: 0,
          },
        ]);
      }).pipe(Effect.provide(substrate(storage)));
    },
  );

  it.effect(
    'commits a skill snapshot with its envelope and sanitized payload',
    () =>
      Effect.gen(function* () {
        const db = yield* Database;
        const rows = yield* db.appendAll([
          runStart,
          {
            type: 'skills.snapshot',
            aggregateId: runStart.aggregateId,
            stageId: 'skills-stage',
            skills: [
              {
                name: 'proof-review',
                description: 'Use API_KEY=skills-snapshot-secret\n  carefully',
                source: 'project',
              },
            ],
          },
        ]);
        expect(rows[1]).toMatchObject({
          type: 'skills.snapshot',
          stageId: 'skills-stage',
          seq: 2,
          commit: 2,
          skills: [
            {
              name: 'proof-review',
              description: 'Use API_KEY=[redacted] carefully',
              source: 'project',
            },
          ],
        });
        expect(yield* db.readAll(0)).toEqual(rows);
      }).pipe(Effect.provide(substrate(workspace()))),
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
          raw.exec(`CREATE TRIGGER reject_status BEFORE INSERT ON event
            WHEN NEW.type = 'status.1'
            BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`);
        } finally {
          raw.close();
        }
      });
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
      expect(yield* SubscriptionRef.get(db.level)).toBe(1);
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
              type: 'transcript.entry',
              aggregateId: runStart.aggregateId,
              entry: {
                seqNo: 1,
                id: 'non-json',
                type: 'log',
                level: 'info',
                timestamp: 1,
                messageType: 'internal',
                data: 1n,
              },
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
            .prepare('DELETE FROM event_sequence WHERE aggregate_id = ?')
            .run(qualifyAggregateId('run', RUN));
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
          { type: 'approval.resolved', aggregateId: id, requestId: 'second' },
          { ...waiting, cause: 'latest status' },
          {
            type: 'response.finalized',
            aggregateId: id,
            text: 'API_KEY=publication-boundary-secret',
          },
          { type: 'run.removed', aggregateId: other },
        ]);
        expect((yield* db.readListing()).map((row) => row.commit)).toEqual([
          1, 2, 4, 7, 9,
        ]);
        expect(rows[7]).toMatchObject({ text: 'API_KEY=[redacted]' });
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
            ownerId: SELF,
            closed: false,
            parentId: null,
            startCommit: 1,
          },
          {
            aggregateId: other,
            ownerId: SELF,
            closed: true,
            parentId: null,
            startCommit: 2,
          },
        ]);
        for (const draft of [
          { ...waiting, aggregateId: other },
          olderStart,
          runStart,
          { ...waiting, aggregateId: absent },
        ]) {
          expect((yield* Effect.flip(db.appendAll([draft])))._tag).toBe(
            'DatabaseWriteFailed',
          );
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
              first.removeRun(root, 'bulk', initial[0]!.commit),
            ),
          ).toMatchObject({
            _tag: 'DatabaseWriteFailed',
          });
          expect(yield* first.readAll(0)).toEqual(initial);
          yield* second.releaseClaims([inquiry]);
        }).pipe(Effect.provide(substrate(storage, OTHER)));
        const committed = [
          ...(yield* first.appendAll([waiting])),
          ...(yield* first.removeRun(root, 'bulk', initial[0]!.commit)),
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
            first.removeRun(root, 'single', initial[0]!.commit),
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
      }).pipe(Effect.provide(substrate(storage)));
    },
  );

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
          expect((yield* Effect.flip(second.appendAll([waiting])))._tag).toBe(
            'DatabaseWriteFailed',
          );
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
          expect((yield* Effect.flip(first.appendAll([waiting])))._tag).toBe(
            'DatabaseWriteFailed',
          );
          expect((yield* second.appendAll([waiting]))[0]?.commit).toBe(3);
          const otherRoot = qualifyAggregateId('run', OLDER);
          const otherStart = (yield* first.aggregateState([otherRoot]))[0]!
            .startCommit!;
          for (const mode of ['bulk', 'automatic'] as const) {
            expect(
              yield* Effect.flip(first.removeRun(otherRoot, mode, otherStart)),
            ).toMatchObject({
              _tag: 'DatabaseWriteFailed',
              cause: { _tag: 'DatabaseClaimRefused', verdict: 'unprovable' },
            });
          }
          expect((yield* first.aggregateState([otherRoot]))[0]?.closed).toBe(
            false,
          );
          yield* first.removeRun(otherRoot, 'single', otherStart);
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
    );
  const AGGREGATE = qualifyAggregateId('run', RUN);
  const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz0123';
  const ORIGIN = {
    protocol: 'deepseek-chat',
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
        evidence: { kind: 'chat-reasoning-content' },
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
      partition: 0,
      duplicateOf: null,
      logId: null,
      stageId: null,
    },
    {
      callId: 'call-b',
      toolName: 'bash',
      ordinal: 1,
      parallelSafe: false,
      partition: 0,
      duplicateOf: 'call-a',
      logId: null,
      stageId: null,
    },
  ] as const;
  const snapshot = (
    phase: string,
    references: Extract<
      RunLedgerDraft,
      { type: 'flow.snapshot' }
    >['payload']['references'] = {
      pendingIntents: [],
      pendingResponse: null,
    },
  ): RunLedgerDraft => ({
    type: 'flow.snapshot',
    aggregateId: AGGREGATE,
    payload: {
      family: 'toolUse',
      runtime: {
        phase: phase === 'round.ready' ? 'round.ready' : 'results.ready',
        round: 0,
        turn: 0,
        continuationIndex: 0,
        modelId: 'gpt-test',
        modelHandlerCompatibilityKey: null,
        lastError: null,
        pendingRetry: null,
      },
      references,
      state: { shouldSkipCycle: false, stateSlices: null },
    },
  });
  const refusalOf = (error: unknown): RunLedgerRefused | null =>
    error instanceof RunLedgerRefused ? error : null;
  /** The approval a barrier call waits on, and the snapshot that binds it. */
  const approvalRequested: RunLedgerDraft = {
    type: 'approval.requested',
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
  const bindingSnapshot = snapshot('results.ready', {
    pendingIntents: [
      {
        callId: 'call-a',
        attempt: 1,
        responseId: RESPONSE_ID,
        approvalRequestId: 'req-1',
      },
    ],
    pendingResponse: { responseId: RESPONSE_ID, settled: [] },
  });
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
        snapshot('round.ready'),
      ]);
      state = yield* run.appendBatch(RUN, state, [
        {
          type: 'model.message',
          aggregateId: AGGREGATE,
          payload: {
            kind: 'attempt',
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
        settled('call-a', {
          stateMutation: [
            { op: 'add', path: ['usage', 'totalCost'], amount: 0.25 },
          ],
        }),
        toolEnd('call-a'),
      ]);
      state = yield* run.appendBatch(RUN, state, [
        settled('call-b', { disposition: 'duplicate', duplicateOf: 'call-a' }),
        toolEnd('call-b'),
      ]);
      state = yield* run.appendBatch(RUN, state, [
        group,
        snapshot('results.ready'),
        {
          type: 'flow.step',
          aggregateId: AGGREGATE,
          payload: { family: 'toolUse', step: 'turn.end', turn: 1 },
        },
      ]);
      expect(state.messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'tool',
      ]);
      expect(state.usage.totalCost).toBe(0.25);
      expect(yield* run.load(RUN)).toEqual(state);
    }).pipe(Effect.provide(ledger())),
  );

  it.effect(
    'stores ledger rows byte-exact while the same secret in a log row is redacted',
    () =>
      Effect.gen(function* () {
        const events = yield* SessionEvents;
        const run = yield* RunLedger;
        const log = yield* Database;
        yield* events.publish([runStart]);
        yield* openTurn(run);
        yield* events.publish([
          {
            type: 'log',
            aggregateId: AGGREGATE,
            level: 'info',
            message: `the key is ${SECRET}`,
          },
        ]);
        const rows = yield* log.readAggregate(AGGREGATE, 1);
        const response = rows.find(
          (row) =>
            row.type === 'model.message' && row.payload.kind === 'response',
        );
        expect(
          response?.type === 'model.message' &&
            response.payload.kind === 'response'
            ? response.payload.turn
            : null,
        ).toEqual(TURN);
        const logged = rows.find((row) => row.type === 'log');
        expect(logged?.type === 'log' ? logged.message : null).not.toContain(
          SECRET,
        );
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
        // An approval precedes the snapshot that binds it. The other order is
        // a caller defect, not a refusal the loop could act on.
        const late = yield* run
          .appendBatch(RUN, state, [bindingSnapshot, approvalRequested])
          .pipe(Effect.exit);
        expect(Exit.isFailure(late) && Cause.hasDies(late.cause)).toBe(true);
        state = yield* run.appendBatch(RUN, state, [
          approvalRequested,
          bindingSnapshot,
        ]);
        expect(state.approvals['req-1']?.resolved).toBe(false);
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
