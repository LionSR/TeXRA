/**
 * The transport framer and the webview graph over its frames (PRD
 * one-fold-three-renderers, 7.4, 8.1; acceptance for lane 4): a `Subscribe`
 * is answered with the listing, the named histories, the local snapshot,
 * and the marker, then the tail under 16 ms framing with one merged chunk
 * per row and the generation echoed; a frame of a superseded generation is
 * dropped by the decoder; and a webview graph over `transportLayer` folds
 * the frames to the view the runtime holds.
 */
import { it } from '@effect/vitest';
import { Effect, Fiber, Layer, Queue, Stream, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vitest';

import {
  SessionEventLog,
  sessionEventsLayer,
} from '@agent/runtime/SessionEvents';
import {
  frameSubscription,
  type FramerSource,
} from '@controllers/session/SessionFramer';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from '@controllers/session/sessionSources';
import { SessionViewService } from '@controllers/session/SessionView';
import { sessionInputsLayer } from '@controllers/session/sessionInputs';
import { WebviewSessions } from '@controllers/session/webviewSessionLayer';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  STREAM_PHASE,
  type ExecutionId,
  type SessionEventDraft,
  type StreamTabId,
} from '@shared/schemas';
import { SessionInputs } from '@shared/session/sessionInputs';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { EventsFrame, Subscribe } from '@shared/session/sessionFrames';
import type { SessionView } from '@shared/session/sessionView';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { StreamLogStore } from '@transcript/StreamLogStore';

const SELF = '["test-host",4242,"self-start"]';
const KEY = '/workspace/framing';
const STREAM = 'stream:framing' as StreamTabId;
const EXECUTION = 'ab12cd' as ExecutionId;
const PORT = 'sidebar';

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

const running: SessionEventDraft = {
  type: 'status',
  aggregateId: qualifyAggregateId('stream', STREAM),
  phase: STREAM_PHASE.RUNNING,
  previousPhase: STREAM_PHASE.WAITING,
  cause: 'resume',
};

/** The runtime graph, as `sessionLayer` composes it without the host bits. */
const runtimeGraph = (history: readonly SessionEventDraft[]) => {
  const roots = createFakeWorkspaceRoots({ storagePath: KEY });
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
            Layer.provideMerge(
              SessionEventLog.memoryLayer(
                StreamLogStore.ephemeral('session framer test'),
                roots,
              ),
            ),
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

/** Let the framer's real-async reads (the transcript store) settle, then
 *  move the test clock one framing window: forked beside a test, it cuts a
 *  frame per window while the test waits on a queue or a view level. */
const ticking = Effect.forever(
  Effect.promise(() => new Promise<void>((r) => setTimeout(r, 0))).pipe(
    Effect.andThen(TestClock.adjust('16 millis')),
  ),
);

const settle = (
  view: SubscriptionRef.SubscriptionRef<SessionView>,
  ready: (view: SessionView) => boolean,
) =>
  SubscriptionRef.changes(view).pipe(Stream.takeUntil(ready), Stream.runDrain);

/** What a renderer draws of a view: the same for both hosts of one log. */
function drawn(view: SessionView) {
  const stream = view.streams.get(STREAM);
  return {
    order: view.order,
    status: stream?.status ?? null,
    group: stream?.group ?? null,
    approvals: view.approvals.map((a) => a.requestId),
    inflight: [...view.inflight.entries()],
  };
}

const subscribe: Subscribe = {
  kind: 'subscribe',
  session: KEY,
  generation: 1,
  cursor: 0,
  aggregates: [{ id: qualifyAggregateId('stream', STREAM), fromSeq: 0 }],
};

/** A framer source over the runtime graph in context. */
const framerSource = Effect.gen(function* () {
  const inputs = yield* SessionInputs;
  const view = yield* SessionViewService;
  const subscriptions = yield* TranscriptSubscriptions;
  const source: FramerSource = {
    key: KEY,
    view: view.ref,
    inputs: inputs.read,
    setTranscriptSubscriptions: (port, set) => subscriptions.set(port, set),
  };
  return source;
});

describe('session framer', () => {
  it.effect(
    'answers a Subscribe with the replay, then frames the tail every 16 ms with one chunk per row',
    () =>
      Effect.gen(function* () {
        const source = yield* framerSource;
        const events = yield* SessionEvents;
        const chunks = yield* TextChunkSource;
        const host = yield* SubscriptionRef.make<HostSnapshot | null>(null);
        const frames = yield* Queue.unbounded<EventsFrame>();
        const framer = yield* Effect.forkScoped(
          Stream.runForEach(
            frameSubscription(source, PORT, host, subscribe),
            (frame) => Queue.offer(frames, frame),
          ),
        );
        const ticker = yield* Effect.forkScoped(ticking);
        // The replay, over as many windows as its reads take: the listing
        // rows first, the local snapshot with the marker last, every frame
        // echoing the generation.
        const replay: EventsFrame[] = [];
        while (!replay.at(-1)?.replayComplete) {
          replay.push(yield* Queue.take(frames));
        }
        expect(replay.every((frame) => frame.generation === 1)).toBe(true);
        expect(
          replay.flatMap((frame) =>
            frame.events.map((row) => [row.read, row.event.type]),
          ),
        ).toEqual([
          ['listing', 'run.start'],
          ['listing', 'status'],
        ]);
        expect(replay.at(-1)?.local?.self).toEqual([SELF]);
        // The tail: a commit after the replay is framed as an `all` row and
        // the frame's cursor is the commit the framer drained; two appends
        // to one row in one window merge into one chunk, never two; a chunk
        // of an aggregate the Subscribe did not name is left out.
        yield* events.publish([running]);
        yield* SubscriptionRef.set(
          chunks.ref,
          new Map([[`${STREAM}/row-1`, 'Hel']]),
        );
        yield* SubscriptionRef.set(
          chunks.ref,
          new Map([
            [`${STREAM}/row-1`, 'Hello'],
            ['stream:unnamed/row-1', 'hidden'],
          ]),
        );
        const tail: EventsFrame[] = [];
        while (
          !tail.some((frame) => frame.events.length > 0) ||
          (tail.at(-1)?.chunks.at(-1)?.to ?? 0) < 5
        ) {
          tail.push(yield* Queue.take(frames));
        }
        expect(
          tail.flatMap((frame) =>
            frame.events.map((row) => [row.read, row.event.commit]),
          ),
        ).toEqual([['all', 3]]);
        expect(tail.at(-1)?.cursor).toBe(3);
        expect(tail.every((frame) => frame.chunks.length <= 1)).toBe(true);
        const merged = tail.flatMap((frame) => frame.chunks);
        expect(merged.every((chunk) => chunk.streamId === STREAM)).toBe(true);
        expect(merged.map((chunk) => chunk.text).join('')).toBe('Hello');
        expect(merged[0]).toMatchObject({
          streamId: STREAM,
          rowId: 'row-1',
          from: 0,
        });
        expect(merged.at(-1)?.to).toBe(5);
        yield* Fiber.interrupt(ticker);
        yield* Fiber.interrupt(framer);
      }).pipe(Effect.provide(runtimeGraph([runStart, waiting]))),
  );

  it.effect(
    'a webview graph over the frames folds to the view the runtime holds',
    () =>
      Effect.gen(function* () {
        const source = yield* framerSource;
        const events = yield* SessionEvents;
        const runtimeView = yield* SessionViewService;
        const chunks = yield* TextChunkSource;
        yield* SubscriptionRef.set(
          chunks.ref,
          new Map([[`${STREAM}/row-1`, 'Hello']]),
        );
        const host = yield* SubscriptionRef.make<HostSnapshot | null>(null);
        const webview = yield* WebviewSessions.open(KEY);
        const { frames, view } = webview;
        const shell = webview.subscriptions;
        // The shell names the second stream ahead of its run.start: live
        // text is framed only for the aggregates a Subscribe names.
        const child = 'stream:second';
        const named: Subscribe = {
          ...subscribe,
          aggregates: [
            ...subscribe.aggregates,
            { id: qualifyAggregateId('stream', child), fromSeq: 0 },
          ],
        };
        // The shell: begin the generation and set its transcript set, then
        // post the Subscribe; the decoder feeds every frame that answers it.
        yield* frames.begin(named.generation);
        yield* shell.set('shell', named.aggregates);
        const decoder = yield* Effect.forkScoped(
          Stream.runForEach(
            frameSubscription(source, PORT, host, named),
            (frame) => frames.feed(frame),
          ),
        );
        // A frame of a superseded generation is dropped: nothing of it
        // reaches the fold.
        yield* frames.feed({
          kind: 'events',
          session: KEY,
          generation: 0,
          cursor: 99,
          events: [
            {
              _tag: 'event',
              read: 'all',
              event: {
                type: 'stream.removed',
                aggregateId: qualifyAggregateId('stream', STREAM),
                seq: 9,
                commit: 99,
                ownerId: SELF,
                at: 0,
              },
            },
          ],
          chunks: [],
          local: null,
          host: null,
          replayComplete: false,
        });
        const ticker = yield* Effect.forkScoped(ticking);
        yield* settle(
          view.ref,
          (v) => v.inflight.get(`${STREAM}/row-1`) === 'Hello',
        );
        yield* settle(
          runtimeView.ref,
          (v) => v.inflight.get(`${STREAM}/row-1`) === 'Hello',
        );
        expect(drawn(yield* SubscriptionRef.get(view.ref))).toEqual(
          drawn(yield* SubscriptionRef.get(runtimeView.ref)),
        );
        // A tail commit reaches both folds.
        yield* events.publish([running]);
        yield* SubscriptionRef.set(
          chunks.ref,
          new Map([[`${STREAM}/row-1`, 'Hello again']]),
        );
        yield* settle(
          view.ref,
          (v) =>
            v.streams.get(STREAM)?.status === STREAM_PHASE.RUNNING &&
            v.inflight.get(`${STREAM}/row-1`) === 'Hello again',
        );
        yield* settle(
          runtimeView.ref,
          (v) => v.streams.get(STREAM)?.status === STREAM_PHASE.RUNNING,
        );
        const folded = yield* SubscriptionRef.get(view.ref);
        expect(drawn(folded)).toEqual(
          drawn(yield* SubscriptionRef.get(runtimeView.ref)),
        );
        expect(folded.cursor).toBe(3);

        // A new stream and its first prefix can become ready in one turn.
        yield* events.publish([
          {
            ...runStart,
            aggregateId: qualifyAggregateId('stream', child),
            executionId: 'second',
          },
        ]);
        yield* SubscriptionRef.update(
          chunks.ref,
          (held) => new Map([...held, [`${child}/row-2`, 'First']]),
        );
        yield* settle(
          view.ref,
          (v) => v.inflight.get(`${child}/row-2`) === 'First',
        );
        yield* SubscriptionRef.update(
          chunks.ref,
          (held) => new Map([...held, [`${child}/row-2`, 'First suffix']]),
        );
        yield* settle(
          view.ref,
          (v) => v.inflight.get(`${child}/row-2`) === 'First suffix',
        );
        yield* settle(
          runtimeView.ref,
          (v) => v.inflight.get(`${child}/row-2`) === 'First suffix',
        );

        // Neither a partial replay nor its superseded generation may mutate
        // the previously published view, whose indexes are shared by the fold.
        yield* Fiber.interrupt(decoder);
        const beforeReplay = yield* SubscriptionRef.get(view.ref);
        yield* frames.begin(2);
        yield* shell.set('shell', named.aggregates);
        yield* frames.feed({
          kind: 'events',
          session: KEY,
          generation: 2,
          cursor: 4,
          events: [
            {
              _tag: 'event',
              read: 'listing',
              event: {
                ...waiting,
                seq: 10,
                commit: 10,
                ownerId: SELF,
                at: 0,
              },
            },
          ],
          chunks: [],
          local: null,
          host: null,
          replayComplete: false,
        });
        yield* TestClock.adjust('16 millis');
        expect(yield* SubscriptionRef.get(view.ref)).toBe(beforeReplay);
        expect(beforeReplay.streams.get(STREAM)?.status).toBe(
          STREAM_PHASE.RUNNING,
        );
        yield* frames.begin(3);
        yield* shell.set('shell', named.aggregates);
        const resumed = yield* Effect.forkScoped(
          Stream.runForEach(
            frameSubscription(source, PORT, host, {
              ...named,
              generation: 3,
              cursor: beforeReplay.cursor,
            }),
            (frame) => frames.feed(frame),
          ),
        );
        yield* settle(view.ref, (v) => v !== beforeReplay);
        expect(
          (yield* SubscriptionRef.get(view.ref)).streams.get(STREAM)?.status,
        ).toBe(STREAM_PHASE.RUNNING);
        yield* Fiber.interrupt(ticker);
        yield* Fiber.interrupt(resumed);
      }).pipe(
        Effect.provide(
          Layer.merge(
            runtimeGraph([runStart, waiting]),
            WebviewSessions.layerNoDeps,
          ),
        ),
      ),
  );
});
