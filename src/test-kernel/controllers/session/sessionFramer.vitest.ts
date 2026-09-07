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
import { describe, expect, vi } from 'vitest';

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
  type InflightTextChunk,
} from '@controllers/session/sessionSources';
import { SessionViewService } from '@controllers/session/SessionView';
import { sessionInputsLayer } from '@controllers/session/sessionInputs';
import { WebviewSessions } from '@controllers/session/webviewSessionLayer';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { SessionBridge } from '@controllers/session/SessionBridge';
import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  FoldEventSchema,
  STREAM_PHASE,
  type ExecutionId,
  type SessionEventDraft,
  type StreamTabId,
} from '@shared/schemas';
import { SessionInputs } from '@shared/session/sessionInputs';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type {
  DownMessage,
  EventsFrame,
  Subscribe,
} from '@shared/session/sessionFrames';
import {
  SESSION_FRAME_BYTES,
  sessionMessageBytes,
} from '@shared/session/sessionReadBudget';
import type { SessionView } from '@shared/session/sessionView';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { createTestSession } from '@test/support/sessionTestUtils';
import { StreamLogStore } from '@transcript/StreamLogStore';

function textTail(
  text: string,
  previous?: InflightTextChunk,
): InflightTextChunk {
  return { previous, text, length: (previous?.length ?? 0) + text.length };
}

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
  it('rejects a stream event carried by an inquiry aggregate at the wire boundary', () => {
    const input = {
      _tag: 'event',
      read: 'listing',
      event: {
        ...runStart,
        aggregateId: qualifyAggregateId('inquiry', STREAM),
        seq: 1,
        commit: 1,
        ownerId: SELF,
        at: 0,
      },
    };
    expect(FoldEventSchema.safeParse(input).success).toBe(false);
    expect(
      FoldEventSchema.safeParse({
        ...input,
        event: { ...input.event, aggregateId: runStart.aggregateId },
      }).success,
    ).toBe(true);
  });
  it('preserves stream and execution subscription keys across the webview bridge', async () => {
    const session = createTestSession();
    const bridge = new SessionBridge({
      session,
      onPortClosed: () => {},
      handleHostRequest: async () => {
        throw new Error('No host request is expected.');
      },
    });
    const keys = [
      qualifyAggregateId('stream', STREAM),
      qualifyAggregateId('execution', EXECUTION),
    ];
    try {
      bridge.attach({ id: PORT, send: async () => {} }).receive({
        ...subscribe,
        session: session.roots.storage,
        aggregates: keys.map((id) => ({ id, fromSeq: 0 })),
      });
      await vi.waitFor(() => {
        expect(
          [...SubscriptionRef.getUnsafe(session.view).folded.keys()].toSorted(),
        ).toEqual(keys.toSorted());
      });
    } finally {
      bridge.dispose();
      session.dispose();
    }
  });
  it('gates each port on receiver progress and releases a stopped reader independently', async () => {
    const session = createTestSession();
    const set = session.subscriptions.set;
    vi.spyOn(session.subscriptions, 'set').mockImplementation(
      (port, interests) =>
        (interests.length === 0 ? Effect.sleep('25 millis') : Effect.void).pipe(
          Effect.andThen(set(port, interests)),
        ),
    );
    const replay = Array.from({ length: 700 }, (_, index) => ({
      _tag: 'event' as const,
      read: 'aggregate' as const,
      event: {
        ...waiting,
        seq: index + 1,
        commit: index + 1,
        ownerId: SELF,
        at: 0,
      },
    }));
    // A source replay remains available even when one consumer stalls.
    vi.spyOn(session, 'inputs').mockImplementation(() =>
      Stream.concat(
        Stream.make([...replay, { _tag: 'replay.complete' as const }]),
        Stream.never,
      ),
    );
    const bridge = new SessionBridge({
      session,
      onPortClosed: () => {},
      handleHostRequest: async () => ({ kind: 'done' }),
    });
    const slow: DownMessage[] = [];
    const healthy: EventsFrame[] = [];
    const slowPort = bridge.attach({
      id: 'slow',
      send: async (message) => {
        slow.push(message);
      },
    });
    const fastPort = bridge.attach({
      id: 'healthy',
      send: async (message) => {
        if (message.kind !== 'events') return;
        healthy.push(message);
        fastPort.receive({
          kind: 'reader.progress',
          session: session.roots.storage,
          generation: message.generation,
          sequence: message.sequence,
        });
      },
    });
    try {
      const request = { ...subscribe, session: session.roots.storage };
      const slowOnly = qualifyAggregateId('execution', EXECUTION);
      const slowRequest = {
        ...request,
        aggregates: [...request.aggregates, { id: slowOnly, fromSeq: 0 }],
      };
      slowPort.receive(slowRequest);
      fastPort.receive(request);
      await vi.waitFor(() =>
        expect(healthy.some((frame) => frame.replayComplete)).toBe(true),
      );
      expect(slow).toHaveLength(1);
      expect(healthy.flatMap((frame) => frame.events)).toEqual(replay);
      expect(
        healthy.every((frame, index) => frame.sequence === index + 1),
      ).toBe(true);
      slowPort.receive({
        kind: 'reader.progress',
        session: session.roots.storage,
        generation: 1,
        sequence: 99,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(slow).toHaveLength(1);
      slowPort.receive({
        kind: 'reader.stop',
        session: session.roots.storage,
        generation: 1,
      });
      // Restart the same framer while its old cleanup is still delayed.
      slowPort.receive({ ...slowRequest, generation: 2 });
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      expect(SubscriptionRef.getUnsafe(session.view).folded.has(slowOnly)).toBe(
        true,
      );
      slowPort.receive({
        kind: 'reader.stop',
        session: session.roots.storage,
        generation: 2,
      });
      await vi.waitFor(() =>
        expect(
          SubscriptionRef.getUnsafe(session.view).folded.has(slowOnly),
        ).toBe(false),
      );
      expect(
        SubscriptionRef.getUnsafe(session.view).folded.has(
          runStart.aggregateId,
        ),
      ).toBe(true);
      fastPort.receive({
        kind: 'reader.stop',
        session: session.roots.storage,
        generation: 1,
      });
      // Reused public ids get independent attachment interests.
      const replacement = bridge.attach({
        id: 'healthy',
        send: async () => {},
      });
      replacement.receive({ ...request, generation: 2 });
      await vi.waitFor(() =>
        expect(
          SubscriptionRef.getUnsafe(session.view).folded.has(
            runStart.aggregateId,
          ),
        ).toBe(true),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      expect(
        SubscriptionRef.getUnsafe(session.view).folded.has(
          runStart.aggregateId,
        ),
      ).toBe(true);
      replacement.close();
      const reopened = bridge.attach({ id: 'healthy', send: async () => {} });
      reopened.receive({ ...request, generation: 3 });
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      expect(
        SubscriptionRef.getUnsafe(session.view).folded.has(
          runStart.aggregateId,
        ),
      ).toBe(true);
      reopened.receive({
        kind: 'reader.stop',
        session: session.roots.storage,
        generation: 3,
      });
      await vi.waitFor(() =>
        expect(SubscriptionRef.getUnsafe(session.view).folded.size).toBe(0),
      );
    } finally {
      bridge.dispose();
      session.dispose();
    }
  });

  it.effect(
    'delivers a retained 4 MiB row intact within its independent frame envelope',
    () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(ticking);
        const source = yield* framerSource;
        const host = yield* SubscriptionRef.make<HostSnapshot | null>(null);
        const event = {
          ...waiting,
          seq: 1,
          commit: 1,
          ownerId: SELF,
          at: 0,
          cause: 'x'.repeat(4 * 1024 * 1024),
        };
        const frames = yield* frameSubscription(
          {
            ...source,
            inputs: () =>
              Stream.make([
                { _tag: 'event', read: 'aggregate', event },
                { _tag: 'replay.complete' },
              ]),
          },
          PORT,
          host,
          subscribe,
        ).pipe(
          Stream.takeUntil((frame) => frame.replayComplete),
          Stream.runCollect,
        );
        expect(
          frames.flatMap((frame) => frame.events).map((row) => row.event),
        ).toEqual([event]);
        expect(
          frames.every(
            (frame) => sessionMessageBytes(frame) <= SESSION_FRAME_BYTES,
          ),
        ).toBe(true);
      }).pipe(Effect.provide(runtimeGraph([]))),
  );

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
        expect(
          replay.findLast((frame) => frame.local !== null)?.local?.self,
        ).toEqual([SELF]);
        // The tail: a commit after the replay is framed as an `all` row and
        // the frame's cursor is the commit the framer drained; two appends
        // to one row in one window merge into one chunk, never two; a chunk
        // of an aggregate the Subscribe did not name is left out.
        yield* events.publish([running]);
        const first = textTail('Hel');
        yield* SubscriptionRef.set(
          chunks.ref,
          new Map([[`${STREAM}/row-1`, first]]),
        );
        yield* SubscriptionRef.set(
          chunks.ref,
          new Map([
            [`${STREAM}/row-1`, textTail('lo', first)],
            ['stream:unnamed/row-1', textTail('hidden')],
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
          new Map([[`${STREAM}/row-1`, textTail('Hello')]]),
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
            (frame) => frames.feed(frame, () => {}),
          ),
        );
        // A frame of a superseded generation is dropped: nothing of it
        // reaches the fold.
        yield* frames.feed(
          {
            kind: 'events',
            sequence: 1,
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
          },
          () => {},
        );
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
          new Map([[`${STREAM}/row-1`, textTail('Hello again')]]),
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
          (held) => new Map([...held, [`${child}/row-2`, textTail('First')]]),
        );
        yield* settle(
          view.ref,
          (v) => v.inflight.get(`${child}/row-2`) === 'First',
        );
        yield* SubscriptionRef.update(
          chunks.ref,
          (held) =>
            new Map([
              ...held,
              [
                `${child}/row-2`,
                textTail(' suffix', held.get(`${child}/row-2`)),
              ],
            ]),
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
        yield* frames.feed(
          {
            kind: 'events',
            sequence: 1,
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
          },
          () => {},
        );
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
            (frame) => frames.feed(frame, () => {}),
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
