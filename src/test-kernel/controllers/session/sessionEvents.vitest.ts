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
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
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
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Stream,
  SubscriptionRef,
} from 'effect';
import { TestClock } from 'effect/testing';

import { afterAll, beforeAll, describe, expect, vi } from 'vitest';

import { TraceEmitter } from '@agent/trace';
import { removeExecutionDirectories } from '@agent/storage/nativeGeneratedCleanup.mjs';
import { sessionEventsLayer } from '@agent/runtime/SessionEvents';
import {
  forEachLiveSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { closeSession, openSession } from '@agent/runtime/sessionGraph';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
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
  LocalRuntimeStateSchema,
  STREAM_PHASE,
  type ExecutionId,
  type SessionEventDraft,
  type StreamTabId,
} from '@shared/schemas';
import { Database } from '@shared/session/database';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import { DownMessageSchema } from '@shared/session/sessionFrames';
import type { SessionView } from '@shared/session/sessionView';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
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
const STREAM = 'stream:framing' as StreamTabId;
const EXECUTION = 'ab12cd' as ExecutionId;
const OLDER = 'stream:older' as StreamTabId;
const NEWER = 'stream:newer' as StreamTabId;

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
  aggregateId: qualifyAggregateId('stream', STREAM),
  executionId: EXECUTION,
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'unsupported',
  category: AgentCategory.ToolUse,
  isRemote: false,
};

const waiting: SessionEventDraft = {
  type: 'status',
  aggregateId: qualifyAggregateId('stream', STREAM),
  phase: STREAM_PHASE.WAITING,
  cause: 'wait',
};

const requested: SessionEventDraft = {
  type: 'approval.requested',
  aggregateId: qualifyAggregateId('stream', STREAM),
  requestId: 'req-1',
  payload: {
    kind: 'bash',
    data: {
      requestId: 'req-1',
      command: 'lake build',
      allowBypass: true,
      streamId: STREAM,
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

/** What a renderer would draw of each state: the stream's status and the
 *  outstanding approvals, at the state's cursor. */
function drawn(view: SessionView) {
  return {
    cursor: view.cursor,
    status: view.streams.get(STREAM)?.status ?? null,
    approvals: view.approvals.map((a) => a.requestId),
  };
}

/** The drawn states with the stream present, consecutive repeats
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
    'keeps an inquiry independent of a removed stream with the same logical id',
    () =>
      Effect.gen(function* () {
        const events = yield* SessionEvents;
        const log = yield* Database;
        const logicalId = 'ei_012345abcdef';
        const stream = qualifyAggregateId('stream', logicalId);
        const inquiry = qualifyAggregateId('inquiry', logicalId);
        const committed = yield* events.publish([
          { ...runStart, aggregateId: stream },
          {
            type: 'inquiryThreadUpdated',
            aggregateId: inquiry,
            threadId: logicalId,
            parentStreamId: null,
            status: 'open',
            lastQuestionPreview: 'Which boundary condition applies?',
            lastActivityIso: '2026-09-06T12:00:00.000Z',
            turnCount: 1,
          },
          { type: 'stream.removed', aggregateId: stream },
        ]);
        expect(yield* log.readAll(0)).toEqual(committed);
        expect((yield* log.aggregateState([stream]))[0]?.closed).toBe(true);
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
        const oldParent = qualifyAggregateId('stream', STREAM);
        const newParentId = 'new-inquiry-parent' as StreamTabId;
        const newParent = qualifyAggregateId('stream', newParentId);
        const inquiry = qualifyAggregateId('inquiry', 'ei_012345abcdef');
        const opened = {
          type: 'inquiryThreadUpdated' as const,
          aggregateId: inquiry,
          threadId: 'ei_012345abcdef',
          parentStreamId: STREAM,
          status: 'open' as const,
          lastQuestionPreview: 'Which boundary condition applies?',
          lastActivityIso: '2026-09-07T12:00:00.000Z',
          turnCount: 1,
        };
        yield* db.appendAll([
          runStart,
          {
            ...runStart,
            aggregateId: newParent,
            executionId: 'aabbccdd1122' as ExecutionId,
          },
          opened,
        ]);
        expect((yield* db.aggregateState([inquiry]))[0]).toMatchObject({
          parentId: oldParent,
          ownerId: null,
        });
        const invalid = yield* Effect.exit(
          db.appendAll([{ ...opened, parentStreamId: newParentId }]),
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
              { ...opened, parentStreamId: newParentId, turnCount: 2 },
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
          { ...opened, parentStreamId: newParentId, turnCount: 2 },
        ]);
        expect((yield* db.aggregateState([inquiry]))[0]).toMatchObject({
          parentId: newParent,
          ownerId: null,
        });
        expect(
          (yield* db.readAggregate(inquiry, 0)).map((row) => row.seq),
        ).toEqual([1, 2, 3]);
        yield* db.removeStream(
          oldParent,
          'single',
          (yield* db.aggregateState([oldParent]))[0]!.startCommit!,
        );
        expect((yield* db.aggregateState([inquiry]))[0]?.closed).toBe(false);
        yield* db.removeStream(
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
      // view's stream index is shared with the views after it. `changes`
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
      yield* settle(view.ref, (v) => v.streams.has(STREAM));
      yield* events.publish([
        {
          type: 'approval.resolved',
          aggregateId: qualifyAggregateId('stream', STREAM),
          requestId: 'req-1',
        },
      ]);
      yield* events.publish([
        {
          type: 'status',
          aggregateId: qualifyAggregateId('stream', STREAM),
          phase: STREAM_PHASE.RUNNING,
          previousPhase: STREAM_PHASE.WAITING,
          cause: 'resume',
        },
      ]);
      // The first state with the stream in it has all of the history: no
      // state with the run started but not yet waiting, or waiting with
      // no approval, is ever published. The anchor is the seeded log's
      // level, so the history is under it and the tail repeats none of it.
      expect(drawnSequence(yield* Fiber.join(states))).toEqual([
        { cursor: 0, status: STREAM_PHASE.WAITING, approvals: ['req-1'] },
        { cursor: 5, status: STREAM_PHASE.RUNNING, approvals: [] },
      ]);
    }).pipe(Effect.provide(graph([runStart, waiting, requested]))),
  );

  it.effect(
    'folds a pending approval to waiting only while its owner is live',
    () =>
      Effect.gen(function* () {
        const view = yield* SessionViewService;
        const local = yield* LocalRuntimeSource;
        yield* settle(view.ref, (v) => v.streams.has(STREAM));
        // This process owns the run: it waits on the user.
        const own = yield* SubscriptionRef.get(view.ref);
        expect(own.streams.get(STREAM)?.group).toBe('waiting');
        expect(own.rollup).toMatchObject({ waiting: 1, interrupted: 0 });
        // The owner is another process that is gone: nothing can answer.
        yield* SubscriptionRef.set(local.ref, {
          self: [OTHER],
          dead: [SELF],
          unreadable: [],
        });
        yield* settle(
          view.ref,
          (v) => v.streams.get(STREAM)?.group === 'interrupted',
        );
        const orphaned = yield* SubscriptionRef.get(view.ref);
        expect(orphaned.streams.get(STREAM)?.group).toBe('interrupted');
        expect(orphaned.streams.get(STREAM)?.readOnly).toBe(false);
        // The owner is another process that is alive: held, waiting on it.
        yield* SubscriptionRef.set(local.ref, {
          self: [OTHER],
          dead: [],
          unreadable: [],
        });
        yield* settle(
          view.ref,
          (v) => v.streams.get(STREAM)?.readOnly === true,
        );
        const held = yield* SubscriptionRef.get(view.ref);
        expect(held.streams.get(STREAM)?.group).toBe('waiting');
        expect(held.streams.get(STREAM)?.readOnly).toBe(true);
        // A live process can release its claim without writing another event.
        const db = yield* Database;
        const id = qualifyAggregateId('stream', STREAM);
        yield* db.releaseClaims([id]);
        yield* settle(view.ref, (v) => v.streams.get(STREAM)?.ownerId === null);
        const released = yield* SubscriptionRef.get(view.ref);
        expect(released.cursor).toBe(held.cursor);
        expect(released.streams.get(STREAM)?.group).toBe('interrupted');
        expect(released.streams.get(STREAM)?.readOnly).toBe(false);
        expect((yield* db.readAggregate(id, 1))[0]?.ownerId).toBe(SELF);
      }).pipe(Effect.provide(graph([runStart, waiting, requested]))),
  );
  it.effect('lists stored stream facts in commit order and on the wire', () =>
    Effect.gen(function* () {
      const events = yield* SessionEvents;
      const log = yield* Database;
      const view = yield* SessionViewService;
      yield* settle(view.ref, (v) => v.streams.size === 2);
      const listed = yield* SubscriptionRef.get(view.ref);
      const older = listed.streams.get(OLDER);
      const newer = listed.streams.get(NEWER);
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
      // A stream born after the build enters through its own row alone,
      // above the reserved space, so a renderer attached at open sees it
      // as new.
      yield* events.publish([
        { ...runStart, aggregateId: qualifyAggregateId('stream', STREAM) },
      ]);
      yield* settle(view.ref, (v) => v.streams.has(STREAM));
      const live = yield* SubscriptionRef.get(view.ref);
      expect(live.streams.get(STREAM)?.createdAt).toBeGreaterThan(
        newer?.createdAt ?? 0,
      );
      expect(live.streams.size).toBe(3);
    }).pipe(
      Effect.provide(
        graph([
          {
            ...runStart,
            executionId: 'ab12ce',
            aggregateId: qualifyAggregateId('stream', OLDER),
          },
          {
            ...runStart,
            executionId: 'ab12cf',
            aggregateId: qualifyAggregateId('stream', NEWER),
          },
          {
            type: 'updateStreamDescription',
            aggregateId: qualifyAggregateId('stream', NEWER),
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
        const stopAgentStream = vi.fn(() => Effect.void);
        const session = {
          view: view.ref,
          executions: { stopAgentStream },
        } as unknown as SessionHandle;
        const requests = sessionRequests(session, db, local);
        // The displayed fold was built as SELF and considers this run writable.
        // This requesting process is OTHER; it must respect the current claim.
        yield* settle(view.ref, (v) => v.streams.has(STREAM));
        expect(
          SubscriptionRef.getUnsafe(view.ref).streams.get(STREAM)?.readOnly,
        ).toBe(false);
        const request = { kind: 'stream.stop', streamId: STREAM } as const;
        const refused = yield* requests.request(request).pipe(Effect.flip);
        expect(refused._tag).toBe('NotOwner');
        expect(stopAgentStream).not.toHaveBeenCalled();

        yield* db.releaseClaims([qualifyAggregateId('stream', STREAM)]);
        yield* SubscriptionRef.update(view.ref, (v) => ({
          ...v,
          streams: new Map(
            [...v.streams].map(([id, stream]) => [
              id,
              { ...stream, readOnly: true },
            ]),
          ),
        }));
        // A released claim is not held, even while the display still says so.
        expect(yield* requests.request(request)).toEqual({ kind: 'done' });
        expect(stopAgentStream).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(graph([runStart]))),
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
  const track = (session: SessionHandle, executionId: string) =>
    session.executions.track(
      testExecutionHandle({
        executionId,
        parentStreamId: `stream:${executionId}` as StreamTabId,
        agent: 'chat',
      }),
    );

  // Real polling loops (`vi.waitFor`) on the process runtime's live work:
  // `it.live`, so nothing the session does waits on a test clock.
  it.live(
    'delivers committed runtime facts and never announces a rejected write',
    () =>
      Effect.gen(function* () {
        const session = open('/workspace/owner/committed-status');
        const handleStatus = vi.spyOn(session.executions, 'handleStatus');
        const onResult = vi.fn();
        const detachResult = session.onResult(onResult);

        try {
          session.publish([
            runStart,
            {
              ...runStart,
              executionId: 'ab12ce',
              aggregateId: qualifyAggregateId('stream', OLDER),
            },
            {
              type: 'stream.removed',
              aggregateId: qualifyAggregateId('stream', STREAM),
            },
          ]);
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(session.now()).toBe(3)),
          );
          session.publishStatus({
            type: 'status',
            streamId: STREAM,
            phase: STREAM_PHASE.COMPLETED,
            cause: 'lifecycle',
          });
          session.publishStatus({
            type: 'status',
            streamId: OLDER,
            phase: STREAM_PHASE.WAITING,
            cause: 'wait',
          });
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(handleStatus).toHaveBeenCalledOnce()),
          );
          expect(handleStatus).toHaveBeenCalledWith(OLDER);
          const received = yield* Effect.all(
            [STREAM, OLDER].map((id) =>
              Stream.runCollect(
                session.events.aggregate(qualifyAggregateId('stream', id), 0),
              ),
            ),
          );
          expect(
            received.flat().filter((event) => event.type === 'status'),
          ).toEqual([
            expect.objectContaining({
              type: 'status',
              aggregateId: qualifyAggregateId('stream', OLDER),
              phase: STREAM_PHASE.WAITING,
              seq: 2,
              commit: 4,
            }),
          ]);
          const result = {
            type: 'result',
            outcome: 'completed',
            executionId: EXECUTION,
            streamId: STREAM,
            agentName: 'chat',
            category: AgentCategory.ToolUse,
            isSubagent: false,
          } as const;
          session.publishRunEvent(STREAM, result);
          session.publishRunEvent(OLDER, { ...result, streamId: OLDER });
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce()),
          );
          expect(onResult.mock.calls[0][0]).toMatchObject({
            type: 'result',
            streamId: OLDER,
            outcome: 'completed',
            agentName: 'chat',
            seq: 3,
            commit: 5,
          });
          const committed = yield* Stream.runCollect(
            session.events.aggregate(qualifyAggregateId('stream', OLDER), 0),
          );
          for (const event of committed)
            yield* session.receiveCommittedEvent({ ...event, ownerId: OTHER });
          expect(handleStatus).toHaveBeenCalledOnce();
          expect(onResult).toHaveBeenCalledOnce();
        } finally {
          detachResult();
          handleStatus.mockRestore();
          session.dispose();
        }
      }),
  );

  // #12017's ownership fence must not reach the fold: the snapshot store is
  // an in-memory reading of the shared table, and its synchronous accessors
  // are the runtime's answer for any stream, including one another process
  // owns.
  it.live(
    "folds another process's committed facts without firing local side effects",
    () =>
      Effect.gen(function* () {
        const session = open('/workspace/owner/foreign-fold');
        const onResult = vi.fn();
        const detachResult = session.onResult(onResult);
        const foreign = 'stream:foreign' as StreamTabId;
        const aggregateId = qualifyAggregateId('stream', foreign);
        const foreignExecution = 'cd34ef' as ExecutionId;
        try {
          yield* session.receiveCommittedEvent({
            type: 'run.start',
            aggregateId,
            executionId: foreignExecution,
            identity: { kind: 'agent', agent: 'chat' },
            userFollowUpSupport: 'unsupported',
            category: AgentCategory.ToolUse,
            isRemote: false,
            ownerId: OTHER,
            at: 0,
            seq: 1,
            commit: 1,
          });
          yield* session.receiveCommittedEvent({
            type: 'updateStreamDescription',
            aggregateId,
            description: 'a run in another process',
            ownerId: OTHER,
            at: 0,
            seq: 2,
            commit: 2,
          });
          yield* session.receiveCommittedEvent({
            type: 'result',
            aggregateId,
            outcome: 'completed',
            executionId: foreignExecution,
            agentName: 'chat',
            category: AgentCategory.ToolUse,
            isSubagent: false,
            ownerId: OTHER,
            at: 0,
            seq: 3,
            commit: 3,
          });
          expect(session.snapshots.hasProvenance(foreign)).toBe(true);
          expect(session.snapshots.getRunMetadata(foreign)).toMatchObject({
            executionId: foreignExecution,
            description: 'a run in another process',
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
          streamId: STREAM,
          plan: { objective: 'Settle the pending approval during close.' },
          goalEnabled: false,
        });
        yield* Effect.promise(() => session.settlePublications());
        expect(SubscriptionRef.getUnsafe(session.view).approvals).toHaveLength(
          1,
        );
        track(session, 'exec:settled');
        // The run completes: its driver untracks it as it unwinds.
        session.executions.untrack('exec:settled');
        // A native child between turns, detached from its stopped parent: its
        // activation is its only record, so the close must stop it itself, and
        // wait for the loop to release the activation after its last delivery.
        let releaseChild = (): void => {};
        const interrupt = vi.fn(() => releaseChild());
        releaseChild = session.executions.reserveChildActivation({
          executionId: 'exec:child' as ExecutionId,
          parentStreamId: 'stream:exec:settled' as StreamTabId,
          childStreamId: 'stream:exec:child' as StreamTabId,
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
        const handle = testExecutionHandle({
          executionId: 'exec:waiting-teardown',
          parentStreamId: 'stream:exec:waiting-teardown' as StreamTabId,
          agent: 'chat',
        });
        const release = yield* Deferred.make<void>();
        handle.suspend(
          Effect.gen(function* () {
            session.executions.untrack(handle.executionId);
            yield* Deferred.await(release);
          }),
        );
        session.executions.track(handle);
        const closing = yield* Effect.forkChild(closeSession(root));
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(session.executions.getActiveIds()).toEqual([]),
          ),
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
        track(session, 'exec:slow');
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
          abandoned: ['exec:slow'],
        });
        expect(isLive(session)).toBe(true);
        session.executions.untrack('exec:slow');
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
    executionId: 'ab12ce',
    aggregateId: qualifyAggregateId('stream', OLDER),
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
          [qualifyAggregateId('stream', STREAM), 1, 1],
          [qualifyAggregateId('stream', OLDER), 1, 2],
          [qualifyAggregateId('stream', STREAM), 2, 3],
          [qualifyAggregateId('stream', STREAM), 3, 4],
        ]);
        // The writer is the process, stamped by the layer (C5), and `at` is
        // the layer's own clock: no caller passes either.
        expect(first.every((e) => e.ownerId === SELF && e.at === now)).toBe(
          true,
        );
        // One wake per committed batch, independent of its event ordinal.
        expect(yield* SubscriptionRef.get(db.level)).toBe(2);
        expect(yield* db.currentCommit).toBe(4);
        // An execution has one owning stream. A conflicting creation rolls
        // back its stream row as well as its event and sequence allocation.
        const conflicting = qualifyAggregateId('stream', NEWER);
        expect(
          (yield* Effect.flip(
            db.appendAll([{ ...runStart, aggregateId: conflicting }]),
          ))._tag,
        ).toBe('DatabaseWriteFailed');
        expect(yield* db.aggregateState([conflicting])).toEqual([]);
        expect(yield* db.currentCommit).toBe(4);
        expect(yield* SubscriptionRef.get(db.level)).toBe(2);
      }).pipe(Effect.provide(substrate(storage)));
    },
  );

  it.effect(
    'captures the parent incarnation in the creation transaction',
    () => {
      const storage = workspace();
      return Effect.gen(function* () {
        const db = yield* Database;
        const child = {
          ...olderStart,
          parentStreamId: STREAM,
          parentStartCommit: 999,
        };
        // A missing parent rejects the complete batch, including the earlier
        // creation and the child's sequence reservation.
        const rejected = yield* Effect.flip(
          db.appendAll([
            runStart,
            { ...child, parentStreamId: 'stream:missing' as StreamTabId },
          ]),
        );
        expect(rejected._tag).toBe('DatabaseWriteFailed');
        expect(yield* db.readAll(0)).toEqual([]);
        expect(yield* SubscriptionRef.get(db.level)).toBe(0);

        // The parent can be created earlier in this same transaction. Its
        // actual creation commit replaces any caller-supplied value.
        const created = yield* db.appendAll([runStart, child]);
        expect(created[1]).toMatchObject({
          parentStreamId: STREAM,
          parentStartCommit: created[0]?.commit,
        });
        expect(yield* db.readAll(0)).toEqual(created);
        expect(created[0]).not.toHaveProperty('parentStartCommit');

        yield* db.appendAll([
          {
            type: 'stream.removed',
            aggregateId: qualifyAggregateId('stream', STREAM),
          },
        ]);
        const beforeRejectedChild = yield* db.currentCommit;
        const closedParent = yield* Effect.flip(
          db.appendAll([
            {
              ...child,
              aggregateId: qualifyAggregateId('stream', 'stream:later-child'),
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
            aggregateId: qualifyAggregateId('stream', STREAM),
            seq: 1,
            type: 'run.start.1',
            ownerId: SELF,
            at: now,
            data: JSON.stringify({
              executionId: EXECUTION,
              identity: runStart.identity,
              userFollowUpSupport: 'unsupported',
              category: AgentCategory.ToolUse,
              isRemote: false,
            }),
          },
          {
            commit: 2,
            aggregateId: qualifyAggregateId('stream', OLDER),
            seq: 1,
            type: 'run.start.1',
            ownerId: SELF,
            at: now,
            data: JSON.stringify({
              executionId: 'ab12ce',
              identity: runStart.identity,
              userFollowUpSupport: 'unsupported',
              category: AgentCategory.ToolUse,
              isRemote: false,
            }),
          },
        ]);
        // Creation claims each stream and its dependent execution atomically.
        // An execution has no events until its first own append.
        expect(observed.sequences).toEqual([
          {
            aggregateId: qualifyAggregateId('execution', EXECUTION),
            seq: 0,
            ownerId: SELF,
            parentId: qualifyAggregateId('stream', STREAM),
            closed: 0,
          },
          {
            aggregateId: qualifyAggregateId('execution', 'ab12ce'),
            seq: 0,
            ownerId: SELF,
            parentId: qualifyAggregateId('stream', OLDER),
            closed: 0,
          },
          {
            aggregateId: qualifyAggregateId('stream', STREAM),
            seq: 1,
            ownerId: SELF,
            parentId: null,
            closed: 0,
          },
          {
            aggregateId: qualifyAggregateId('stream', OLDER),
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
          executionId: EXECUTION,
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
            .run(qualifyAggregateId('stream', STREAM));
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
        const id = qualifyAggregateId('stream', STREAM);
        const other = qualifyAggregateId('stream', OLDER);
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
          { type: 'stream.removed', aggregateId: other },
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
        expect(yield* db.aggregatesAfterCommit([other], 1, 8)).toEqual([
          rows[1],
        ]);
        expect(
          yield* db.aggregateState([
            id,
            other,
            qualifyAggregateId('stream', 'absent'),
          ]),
        ).toEqual([
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
          { ...waiting, aggregateId: qualifyAggregateId('stream', 'absent') },
        ]) {
          expect((yield* Effect.flip(db.appendAll([draft])))._tag).toBe(
            'DatabaseWriteFailed',
          );
        }
        expect(yield* db.currentCommit).toBe(9);
        expect(
          yield* db.aggregateState([qualifyAggregateId('stream', 'absent')]),
        ).toEqual([]);
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
          parentStreamId: STREAM,
          status: 'open',
          lastQuestionPreview: 'Which boundary condition applies?',
          lastActivityIso: '2026-09-06T12:00:00.000Z',
          turnCount: 1,
        } as const;
        const initial = yield* first.appendAll([
          runStart,
          olderStart,
          { ...thread, status: 'answered' },
          { ...thread, parentStreamId: OLDER, turnCount: 2 },
          {
            ...thread,
            parentStreamId: OLDER,
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
              { ...thread, parentStreamId: 'stream:missing' as StreamTabId },
            ]),
          ))._tag,
        ).toBe('DatabaseWriteFailed');
        // Visiting the first asker again must not let its delayed turn-1
        // answer regress state and then admit the former asker's turn-2 open.
        const staleBatches: SessionEventDraft[][] = [
          [
            { ...thread, status: 'answered' },
            { ...thread, parentStreamId: OLDER, turnCount: 2 },
          ],
          [
            {
              ...thread,
              parentStreamId: OLDER,
              status: 'answered',
              turnCount: 2,
            },
          ],
          [{ ...thread, parentStreamId: OLDER, turnCount: 2 }],
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
        // Include another execution owned by this stream in the recursive closure.
        yield* Effect.sync(() => {
          const raw = new DatabaseSync(join(storage, 'texra.db'));
          try {
            raw
              .prepare(
                `INSERT INTO event_sequence
              (aggregate_id, seq, owner_id, parent_id) VALUES (?, 0, ?, ?)`,
              )
              .run(qualifyAggregateId('execution', 'cd34ef'), SELF, root);
          } finally {
            raw.close();
          }
        });
        yield* first.releaseClaims([inquiry]);
        const removal: SessionEventDraft = {
          type: 'stream.removed',
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
              first.removeStream(root, 'bulk', initial[0]!.commit),
            ),
          ).toMatchObject({
            _tag: 'DatabaseWriteFailed',
          });
          expect(yield* first.readAll(0)).toEqual(initial);
          yield* second.releaseClaims([inquiry]);
        }).pipe(Effect.provide(substrate(storage, OTHER)));
        const committed = [
          ...(yield* first.appendAll([waiting])),
          ...(yield* first.removeStream(root, 'bulk', initial[0]!.commit)),
        ];
        expect(committed.at(-1)).toMatchObject({
          type: 'stream.removed',
          executionIds: [EXECUTION, 'cd34ef'],
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
          { ...thread, parentStreamId: OLDER },
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
        const unrelated = {
          ...runStart,
          aggregateId: qualifyAggregateId('stream', NEWER),
          executionId: 'ef56ab',
        };
        yield* first.collectDeletion(root, tombstone.commit, (ids) =>
          Effect.gen(function* () {
            expect(ids).toEqual([EXECUTION, 'cd34ef']);
            // Cleanup holds its root claim, not the database write permit.
            // Unrelated runs remain writable while generated files are removed.
            yield* first.appendAll([unrelated]);
          }),
        );
        expect(
          yield* first.aggregateState([
            root,
            inquiry,
            qualifyAggregateId('execution', EXECUTION),
            qualifyAggregateId('execution', 'cd34ef'),
          ]),
        ).toEqual([]);
        expect(
          (yield* first.readAll(0)).map((event) => event.aggregateId),
        ).toEqual([olderStart.aggregateId, unrelated.aggregateId]);
        const replacement = yield* first.appendAll([runStart]);
        expect(
          (yield* Effect.flip(
            first.removeStream(root, 'single', initial[0]!.commit),
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
          { type: 'stream.removed', aggregateId: unrelated.aggregateId },
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

  it.skipIf(process.platform === 'win32')(
    'keeps replaced storage and queued cleanup confined to the owned directory',
    async () => {
      const directory = workspace();
      const admitted = join(directory, 'admitted');
      const moved = join(directory, 'moved');
      const outside = join(directory, 'outside');
      const generated = join(
        admitted,
        WORKSPACE_STORAGE_LAYOUT.runs,
        EXECUTION,
      );
      const replacement = join(
        outside,
        WORKSPACE_STORAGE_LAYOUT.runs,
        EXECUTION,
      );
      mkdirSync(generated, { recursive: true });
      mkdirSync(replacement, { recursive: true });
      writeFileSync(join(generated, 'output.tex'), 'generated');
      writeFileSync(join(replacement, 'keep.tex'), 'outside contents');
      symlinkSync(outside, join(generated, 'reference'));
      // Admission is synchronous even though deletion is performed by a worker.
      const pending = removeExecutionDirectories(
        realpathSync.native(admitted),
        WORKSPACE_STORAGE_LAYOUT.runs,
        [EXECUTION],
      );
      renameSync(admitted, moved);
      symlinkSync(outside, admitted);
      await pending;
      // A crash after physical removal must permit the same tombstone to retry.
      await removeExecutionDirectories(
        realpathSync.native(moved),
        WORKSPACE_STORAGE_LAYOUT.runs,
        [EXECUTION],
      );
      expect(
        existsSync(join(moved, WORKSPACE_STORAGE_LAYOUT.runs, EXECUTION)),
      ).toBe(false);
      expect(readFileSync(join(replacement, 'keep.tex'), 'utf8')).toBe(
        'outside contents',
      );
    },
  );

  it.skipIf(
    process.platform !== 'win32' || !process.env.TEXRA_NATIVE_CLEANUP_UNC_ROOT,
  )(
    'confines ephemeral generated cleanup beneath an admitted UNC share',
    async () => {
      const directory = mkdtempSync(
        join(
          String(process.env.TEXRA_NATIVE_CLEANUP_UNC_ROOT),
          'texra-cleanup-',
        ),
      );
      roots.push(directory);
      const generated = join(
        directory,
        WORKSPACE_STORAGE_LAYOUT.runs,
        EXECUTION,
      );
      mkdirSync(generated, { recursive: true });
      writeFileSync(join(generated, 'output.tex'), 'generated');
      writeFileSync(join(directory, 'keep.tex'), 'retained sibling');
      await removeExecutionDirectories(
        directory,
        WORKSPACE_STORAGE_LAYOUT.runs,
        [EXECUTION],
      );
      expect(existsSync(generated)).toBe(false);
      expect(readFileSync(join(directory, 'keep.tex'), 'utf8')).toBe(
        'retained sibling',
      );
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'keeps Windows junction deletion and renamed storage confined to held handles',
    async () => {
      const directory = workspace();
      const admitted = join(directory, 'admitted');
      const moved = join(directory, 'moved');
      const outside = join(directory, 'outside');
      const runs = join(admitted, WORKSPACE_STORAGE_LAYOUT.runs);
      mkdirSync(runs, { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(outside, 'keep.tex'), 'outside contents');
      // A generated leaf junction is removed through its own handle.
      symlinkSync(outside, join(runs, EXECUTION), 'junction');
      await removeExecutionDirectories(
        admitted,
        WORKSPACE_STORAGE_LAYOUT.runs,
        [EXECUTION],
      );
      expect(existsSync(join(runs, EXECUTION))).toBe(false);
      expect(readFileSync(join(outside, 'keep.tex'), 'utf8')).toBe(
        'outside contents',
      );

      // Replacing the generated root with a junction never grants access to
      // its target. The storage directory itself is still admissible.
      rmSync(runs, { recursive: true });
      symlinkSync(outside, runs, 'junction');
      await expect(
        removeExecutionDirectories(admitted, WORKSPACE_STORAGE_LAYOUT.runs, [
          EXECUTION,
        ]),
      ).rejects.toMatchObject({ code: 'ELOOP' });
      expect(readFileSync(join(outside, 'keep.tex'), 'utf8')).toBe(
        'outside contents',
      );
      rmSync(runs, { recursive: true });

      mkdirSync(join(runs, EXECUTION, 'nested'), { recursive: true });
      writeFileSync(
        join(runs, EXECUTION, 'nested', 'generated.tex'),
        'original',
      );
      const pending = removeExecutionDirectories(
        admitted,
        WORKSPACE_STORAGE_LAYOUT.runs,
        [EXECUTION],
      );
      // Windows may refuse an ancestor rename while the worker holds a child
      // without delete sharing. Both outcomes must preserve confinement.
      const destination = (() => {
        try {
          renameSync(admitted, moved);
          return moved;
        } catch (error) {
          expect(error).toMatchObject({
            code: expect.stringMatching(/^(EACCES|EPERM|EBUSY)$/),
          });
          return admitted;
        }
      })();
      const replacement = join(
        admitted,
        WORKSPACE_STORAGE_LAYOUT.runs,
        EXECUTION,
      );
      if (destination === moved) {
        mkdirSync(replacement, { recursive: true });
        writeFileSync(join(replacement, 'keep.tex'), 'replacement contents');
      }
      await pending;
      expect(
        existsSync(join(destination, WORKSPACE_STORAGE_LAYOUT.runs, EXECUTION)),
      ).toBe(false);
      expect(readFileSync(join(outside, 'keep.tex'), 'utf8')).toBe(
        'outside contents',
      );
      if (destination === moved) {
        expect(readFileSync(join(replacement, 'keep.tex'), 'utf8')).toBe(
          'replacement contents',
        );
      }
    },
  );

  it.effect(
    'fences a second writer and transfers only released claims together',
    () => {
      const storage = workspace();
      return Effect.gen(function* () {
        const first = yield* Database;
        const targets = [
          qualifyAggregateId('stream', STREAM),
          qualifyAggregateId('stream', OLDER),
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
          const otherRoot = qualifyAggregateId('stream', OLDER);
          const otherStart = (yield* first.aggregateState([otherRoot]))[0]!
            .startCommit!;
          for (const mode of ['bulk', 'automatic'] as const) {
            expect(
              yield* Effect.flip(
                first.removeStream(otherRoot, mode, otherStart),
              ),
            ).toMatchObject({
              _tag: 'DatabaseWriteFailed',
              cause: { _tag: 'DatabaseClaimRefused', verdict: 'unprovable' },
            });
          }
          expect((yield* first.aggregateState([otherRoot]))[0]?.closed).toBe(
            false,
          );
          yield* first.removeStream(otherRoot, 'single', otherStart);
          expect((yield* first.aggregateState([otherRoot]))[0]?.closed).toBe(
            true,
          );
        }).pipe(Effect.provide(substrate(storage, OTHER)));
      }).pipe(Effect.provide(substrate(storage)));
    },
  );
});
