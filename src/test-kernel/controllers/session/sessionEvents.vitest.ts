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
import { it } from '@effect/vitest';
import { Effect, Fiber, Layer, Stream, SubscriptionRef } from 'effect';
import { describe, expect } from 'vitest';

import {
  SessionEventLog,
  sessionEventsLayer,
} from '@agent/runtime/SessionEvents';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from '@controllers/session/sessionSources';
import { SessionViewService } from '@controllers/session/SessionView';
import { sessionInputsLayer } from '@controllers/session/sessionInputs';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import {
  AgentCategory,
  STREAM_PHASE,
  type ExecutionId,
  type SessionEventDraft,
  type StreamTabId,
} from '@shared/schemas';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import { DownMessageSchema } from '@shared/session/sessionFrames';
import type { SessionView } from '@shared/session/sessionView';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { StreamLogStore } from '@transcript/StreamLogStore';

const SELF = '4242:self-start';
const OTHER = '4343:other-start';
const STREAM = 'stream:framing' as StreamTabId;
const EXECUTION = 'ab12cd' as ExecutionId;
const OLDER = 'stream:older' as StreamTabId;
const NEWER = 'stream:newer' as StreamTabId;

/** A store holding two finished streams' summaries, as a reopened
 *  workspace does before any graph is built over it. */
function storeWithHistory(): StreamLogStore {
  const store = StreamLogStore.ephemeral('session events history');
  store.recordSummaryMeta(OLDER, {
    executionId: 'a1b2c3' as ExecutionId,
    agentCategory: AgentCategory.ToolUse,
  });
  store.recordSummaryMeta(NEWER, {
    executionId: 'b2c3d4' as ExecutionId,
    agentCategory: AgentCategory.Workflow,
    description: 'the newer run',
  });
  return store;
}

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
  aggregateId: STREAM,
  executionId: EXECUTION,
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'unsupported',
  category: AgentCategory.ToolUse,
  isRemote: false,
};

const waiting: SessionEventDraft = {
  type: 'status',
  aggregateId: STREAM,
  phase: STREAM_PHASE.WAITING,
  cause: 'wait',
};

const requested: SessionEventDraft = {
  type: 'approval.requested',
  aggregateId: STREAM,
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
const graph = (
  history: readonly SessionEventDraft[],
  transcripts = StreamLogStore.ephemeral('session events test'),
) => {
  const roots = createFakeWorkspaceRoots({ storagePath: '/workspace/framing' });
  const seeded = Layer.effectDiscard(
    Effect.gen(function* () {
      const log = yield* SessionEventLog;
      yield* log.appendAll(history);
    }),
  );
  return SessionViewService.layer.pipe(
    Layer.provideMerge(sessionInputsLayer),
    Layer.provideMerge(
      sessionEventsLayer.pipe(
        Layer.provideMerge(
          seeded.pipe(
            Layer.provideMerge(SessionEventLog.memoryLayer(transcripts, roots)),
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
    'publishes nothing before the marker, then every commit in order',
    () =>
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
            aggregateId: STREAM,
            requestId: 'req-1',
          },
        ]);
        yield* events.publish([
          {
            type: 'status',
            aggregateId: STREAM,
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
          { cursor: 3, status: STREAM_PHASE.WAITING, approvals: ['req-1'] },
          { cursor: 4, status: STREAM_PHASE.WAITING, approvals: [] },
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
          heldBy: [],
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
          heldBy: [SELF],
          unreadable: [],
        });
        yield* settle(
          view.ref,
          (v) => v.streams.get(STREAM)?.readOnly === true,
        );
        const held = yield* SubscriptionRef.get(view.ref);
        expect(held.streams.get(STREAM)?.group).toBe('waiting');
        expect(held.streams.get(STREAM)?.readOnly).toBe(true);
      }).pipe(Effect.provide(graph([runStart, waiting, requested]))),
  );
  it.effect(
    'lists the streams the store held at build below the log, in order and on the wire',
    () =>
      Effect.gen(function* () {
        const events = yield* SessionEvents;
        const log = yield* SessionEventLog;
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
        const rows = yield* Stream.runCollect(log.readListing());
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
        });
        expect(
          frame.success,
          frame.success ? '' : JSON.stringify(frame.error.issues, null, 1),
        ).toBe(true);
        // A stream born after the build enters through its own row alone,
        // above the reserved space, so a renderer attached at open sees it
        // as new.
        yield* events.publish([{ ...runStart, aggregateId: STREAM }]);
        yield* settle(view.ref, (v) => v.streams.has(STREAM));
        const live = yield* SubscriptionRef.get(view.ref);
        expect(live.streams.get(STREAM)?.createdAt).toBeGreaterThan(
          newer?.createdAt ?? 0,
        );
        expect(live.streams.size).toBe(3);
      }).pipe(Effect.provide(graph([], storeWithHistory()))),
  );
});
