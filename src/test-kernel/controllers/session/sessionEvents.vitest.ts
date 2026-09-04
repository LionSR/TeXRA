/**
 * The session graph's durable boundary (PRD one-fold-three-renderers, 7.1
 * and 7.2, acceptance for lane 2): framing order and the live-owner waiting
 * rule.
 *
 * Framing: the fold publishes nothing before the replay marker, and a
 * mounting reader sees the listing, the aggregate history, and the local
 * snapshot folded before the first value; the tail then publishes every
 * commit in order. The waiting rule: a pending approval on a run whose owner
 * this process holds (`self`) or whose owner is alive (`heldBy`) folds to
 * `waiting`; the same log with the owner gone folds to `interrupted`.
 */
import { it } from '@effect/vitest';
import { Effect, Fiber, Layer, Stream, SubscriptionRef } from 'effect';
import { describe, expect } from 'vitest';

import { ProcessIdentity, SessionEvents } from '@agent/runtime/SessionEvents';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from '@controllers/session/sessionSources';
import { SessionViewService } from '@controllers/session/SessionView';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import {
  AgentCategory,
  STREAM_PHASE,
  type ExecutionId,
  type SessionEventDraft,
  type StreamTabId,
} from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';

const SELF = '4242:self-start';
const OTHER = '4343:other-start';
const STREAM = 'stream:framing' as StreamTabId;
const EXECUTION = 'ab12cd' as ExecutionId;

/** Wait on the fold's level until it holds a view `ready` accepts: the ref
 *  replays its current value on subscribe, so a view already there ends the
 *  wait at once and a later one ends it when the fold publishes it. */
const settle = (
  view: SubscriptionRef.SubscriptionRef<SessionView>,
  ready: (view: SessionView) => boolean,
) =>
  SubscriptionRef.changes(view).pipe(Stream.takeUntil(ready), Stream.runDrain);

/** The graph under test: the memory plane, the fold, and the three local
 *  sources, as `sessionLayer` composes them, without the runtime bits. */
const graph = Layer.mergeAll(SessionViewService.layer).pipe(
  Layer.provideMerge(SessionEvents.memoryLayer),
  Layer.provideMerge(
    Layer.mergeAll(
      LocalRuntimeSource.layer,
      TextChunkSource.layer,
      TranscriptSubscriptions.layer,
    ),
  ),
  Layer.provide(
    Layer.succeed(WorkspaceRoots)(
      createFakeWorkspaceRoots({ storagePath: '/workspace/framing' }),
    ),
  ),
  Layer.provide(ProcessIdentity.layer(SELF)),
);

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

describe('session events and view', () => {
  it.effect(
    'publishes nothing before the marker, then every commit in order',
    () =>
      Effect.gen(function* () {
        const events = yield* SessionEvents;
        const view = yield* SessionViewService;
        // Published before the fold fiber has drained anything: the cold
        // reads see them, the tail does not repeat them.
        yield* events.publish([runStart, waiting, requested]);
        yield* settle(view.ref, (v) => v.cursor >= 3);
        const first = yield* SubscriptionRef.get(view.ref);
        expect(first.cursor).toBe(3);
        expect(first.streams.get(STREAM)?.status).toBe(STREAM_PHASE.WAITING);
        expect(first.approvals.map((a) => a.requestId)).toEqual(['req-1']);
        // Every state the tail publishes after the marker, in commit order;
        // `changes` is a level and replays the state it holds on subscribe.
        const tail = yield* Effect.forkScoped(
          view.changes.pipe(
            Stream.takeUntil((next) => next.cursor >= 5),
            Stream.runCollect,
          ),
        );
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
        const seen = (yield* Fiber.join(tail)).map((next) => next.cursor);
        const last = yield* SubscriptionRef.get(view.ref);
        expect(seen).toEqual([3, 4, 5]);
        expect(last.cursor).toBe(5);
        expect(last.approvals).toEqual([]);
        expect(last.streams.get(STREAM)?.status).toBe(STREAM_PHASE.RUNNING);
      }).pipe(Effect.provide(graph)),
  );

  it.effect(
    'folds a pending approval to waiting only while its owner is live',
    () =>
      Effect.gen(function* () {
        const events = yield* SessionEvents;
        const view = yield* SessionViewService;
        const local = yield* LocalRuntimeSource;
        yield* events.publish([runStart, waiting, requested]);
        yield* settle(view.ref, (v) => v.cursor >= 3);
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
      }).pipe(Effect.provide(graph)),
  );
});
