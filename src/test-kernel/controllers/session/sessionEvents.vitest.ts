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
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Third-party imports
import { it } from '@effect/vitest';
import { Clock, Effect, Fiber, Layer, Stream, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { afterAll, describe, expect, vi } from 'vitest';

import { TraceEmitter } from '@agent/trace';
import { sessionEventsLayer } from '@agent/runtime/SessionEvents';
import {
  forEachLiveSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { closeSession, openSession } from '@agent/runtime/sessionGraph';
import { databaseLayer } from '@controllers/session/Database';
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
          { ...runStart, aggregateId: qualifyAggregateId('stream', OLDER) },
          { ...runStart, aggregateId: qualifyAggregateId('stream', NEWER) },
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
        const stopAgentStream = vi.fn();
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
      transcripts: StreamLogStore.ephemeral('sessions owner test'),
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

  it('delivers committed runtime facts and never announces a rejected write', async () => {
    const session = open('/workspace/owner/committed-status');
    const handleStatus = vi.fn();
    const onResult = vi.fn();
    const detachResult = session.onResult(onResult);
    const detach = session.attachRunTrace(
      { trace: new TraceEmitter(), handleStatus },
      STREAM,
    );
    try {
      session.publish([
        runStart,
        { ...runStart, aggregateId: qualifyAggregateId('stream', OLDER) },
        {
          type: 'stream.removed',
          aggregateId: qualifyAggregateId('stream', STREAM),
        },
      ]);
      await vi.waitFor(() => expect(session.now()).toBe(3));
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
      await vi.waitFor(() => expect(handleStatus).toHaveBeenCalledOnce());
      expect(handleStatus.mock.calls[0][0]).toMatchObject({
        type: 'status',
        streamId: OLDER,
        phase: STREAM_PHASE.WAITING,
        seq: 2,
        commit: 4,
      });
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
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce());
      expect(onResult.mock.calls[0][0]).toMatchObject({
        type: 'result',
        streamId: OLDER,
        outcome: 'completed',
        agentName: 'chat',
        seq: 3,
        commit: 5,
      });
    } finally {
      detachResult();
      detach();
      session.dispose();
    }
  });

  it('close reports settled once the run ended, and releases the session', async () => {
    const session = open('/workspace/owner/settled');
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

    await expect(
      Effect.runPromise(closeSession('/workspace/owner/settled')),
    ).resolves.toEqual({
      settled: true,
      abandoned: [],
    });
    expect(interrupt).toHaveBeenCalledOnce();
    expect(isLive(session)).toBe(false);
  });

  it('close reports a run still live past the budget as abandoned, and releases the session at its settlement', async () => {
    const session = open('/workspace/owner/abandoned');
    // A run that ignores its interrupt: no handler, no driver to unwind it.
    track(session, 'exec:slow');
    vi.useFakeTimers();
    try {
      const closing = Effect.runPromise(
        closeSession('/workspace/owner/abandoned'),
      );
      await vi.advanceTimersByTimeAsync(SHUTDOWN_PHASE_DEADLINE_MS);
      await expect(closing).resolves.toEqual({
        settled: false,
        abandoned: ['exec:slow'],
      });
    } finally {
      vi.useRealTimers();
    }
    expect(isLive(session)).toBe(true);
    session.executions.untrack('exec:slow');
    await vi.waitFor(() => expect(isLive(session)).toBe(false));
  });
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
              executionId: EXECUTION,
              identity: runStart.identity,
              userFollowUpSupport: 'unsupported',
              category: AgentCategory.ToolUse,
              isRemote: false,
            }),
          },
        ]);
        // A sequence row per aggregate: an independent root, open (C9's
        // closure is stage 6), claimed by the same first-event transaction.
        expect(observed.sequences).toEqual([
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
        const initial = yield* first.appendAll([
          runStart,
          {
            type: 'inquiryThreadUpdated',
            aggregateId: inquiry,
            threadId: 'ei_012345abcdef',
            parentStreamId: STREAM,
            status: 'open',
            lastQuestionPreview: 'Which boundary condition applies?',
            lastActivityIso: '2026-09-06T12:00:00.000Z',
            turnCount: 1,
          },
        ]);
        // Seed the C9 ownership edge. Inquiry reparenting is a separate writer
        // operation; this regression exercises deletion of the resulting graph.
        yield* Effect.sync(() => {
          const raw = new DatabaseSync(join(storage, 'texra.db'));
          try {
            raw
              .prepare(
                'UPDATE event_sequence SET parent_id = ? WHERE aggregate_id = ?',
              )
              .run(root, inquiry);
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
          yield* second.releaseClaims([inquiry]);
        }).pipe(Effect.provide(substrate(storage, OTHER)));
        yield* first.acquireClaims([inquiry]);
        const committed = yield* first.appendAll([waiting, removal]);
        expect(committed.map((row) => [row.seq, row.commit])).toEqual([
          [2, 3],
          [3, 4],
        ]);
        expect(
          (yield* first.aggregateState([root, inquiry])).every(
            (row) => row.closed,
          ),
        ).toBe(true);
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
        }).pipe(Effect.provide(substrate(storage, OTHER)));
      }).pipe(Effect.provide(substrate(storage)));
    },
  );
});
