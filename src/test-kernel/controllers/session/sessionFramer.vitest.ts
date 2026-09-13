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

import { sessionEventsLayer } from '@agent/runtime/SessionEvents';
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
import { databaseLayer } from '@controllers/session/Database';
import { SessionViewService } from '@controllers/session/SessionView';
import { sessionInputsLayer } from '@controllers/session/sessionInputs';
import { WebviewSessions } from '@controllers/session/webviewSessionLayer';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { SessionBridge } from '@controllers/session/SessionBridge';
import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  FoldEventSchema,
  MESSAGE_TYPES,
  RUN_PHASE,
  STREAM_LOG_ENTRY_TYPES,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import { Database } from '@shared/session/database';
import { SessionInputs } from '@shared/session/sessionInputs';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { EventsFrame, Subscribe } from '@shared/session/sessionFrames';
import type { SessionView } from '@shared/session/sessionView';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { createTestSession } from '@test/support/sessionTestUtils';

function textTail(
  text: string,
  previous?: InflightTextChunk,
): InflightTextChunk {
  return { previous, text, length: (previous?.length ?? 0) + text.length };
}

const SELF = '["test-host",4242,"self-start"]';
const KEY = '/workspace/framing';
const RUN = 'ab12cd' as RunId;
const SECOND = 'dec0de' as RunId;
const PORT = 'sidebar';

const runStart: SessionEventDraft = {
  type: 'run.start',
  aggregateId: qualifyAggregateId('run', RUN),
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'unsupported',
  category: AgentCategory.ToolUse,
  isRemote: false,
  parent: null,
};

/** The loop parked on a request: the fold reads the phase off this row. */
const waiting: SessionEventDraft = {
  type: 'flow.step',
  aggregateId: qualifyAggregateId('run', RUN),
  payload: { family: 'toolUse', step: 'waiting' },
};

/** The loop moving again, which is what makes the run running. */
const running: SessionEventDraft = {
  type: 'flow.step',
  aggregateId: qualifyAggregateId('run', RUN),
  payload: { family: 'toolUse', step: 'turn.begin', round: 1, turn: 1 },
};

/** A running model reply with no text of its own: the row the live text for
 *  `rowId` paints into once its entry folds. */
function streamingRow(runId: RunId, rowId: string): SessionEventDraft {
  return {
    type: 'stream.start',
    aggregateId: qualifyAggregateId('run', runId),
    id: rowId,
    kind: MESSAGE_TYPES.MODEL_RESPONSE,
  };
}

/** The runtime graph, as `sessionLayer` composes it without the host bits. */
const runtimeGraph = (history: readonly SessionEventDraft[]) => {
  const roots = createFakeWorkspaceRoots({ storagePath: KEY });
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

/** The text a row paints: its durable text joined with the live text the
 *  fold holds for it, once the row's entry has folded. */
function rowText(view: SessionView, runId: RunId, rowId: string) {
  const row = view.runs
    .get(runId)
    ?.transcript.rows.find((each) => each.id === rowId);
  return row?.kind === 'assistant' ? row.text.full : undefined;
}

/** What a renderer draws of a view: the same for both hosts of one log. */
function drawn(view: SessionView) {
  const run = view.runs.get(RUN);
  return {
    order: view.order,
    status: run?.status ?? null,
    group: run?.group ?? null,
    requests: view.requests.map((request) => request.requestId),
    rows:
      run?.transcript.rows.map((row) => [row.id, rowText(view, RUN, row.id)]) ??
      [],
  };
}

const subscribe: Subscribe = {
  kind: 'subscribe',
  session: KEY,
  generation: 1,
  cursor: 0,
  aggregates: [{ id: qualifyAggregateId('run', RUN), fromSeq: 0 }],
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
  it('rejects a run event carried by an inquiry aggregate at the wire boundary', () => {
    const input = {
      _tag: 'event',
      read: 'listing',
      event: {
        ...runStart,
        aggregateId: qualifyAggregateId('inquiry', 'ei_012345abcdef'),
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

  it.live('preserves run subscription keys across the webview bridge', () =>
    Effect.gen(function* () {
      const session = createTestSession();
      // Registered first, so it runs last: the bridge's ports release their
      // transcript sets through the session before it goes.
      yield* Effect.addFinalizer(() => Effect.sync(() => session.dispose()));
      const setSubscriptions = vi.spyOn(session.subscriptions, 'set');
      const bridge = yield* SessionBridge.make({
        session,
        onPortClosed: () => {},
        handleHostRequest: async () => {
          throw new Error('No host request is expected.');
        },
      });
      const keys = [
        qualifyAggregateId('run', RUN),
        qualifyAggregateId('run', SECOND),
      ];
      const port = yield* bridge.attach({ id: PORT, send: () => {} });
      yield* port.receive({
        ...subscribe,
        session: session.roots.storage,
        aggregates: keys.map((id) => ({ id, fromSeq: 0 })),
      });
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(setSubscriptions).toHaveBeenCalledWith(
            PORT,
            keys.map((id) => ({ id, fromSeq: 0 })),
          );
        }),
      );
    }),
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
          ['listing', 'flow.step'],
          ['aggregate', 'run.start'],
          ['aggregate', 'flow.step'],
        ]);
        expect(replay.at(-1)?.local?.self).toEqual([SELF]);
        // The tail: a commit after the replay is framed as an `all` row and
        // the frame's cursor is the commit the framer drained; two appends
        // to one row in one window merge into one chunk, never two; a chunk
        // of an aggregate the Subscribe did not name is left out.
        yield* events.publish([running]);
        const first = textTail('Hel');
        yield* SubscriptionRef.set(
          chunks.ref,
          new Map([[`${RUN}/row-1`, first]]),
        );
        yield* SubscriptionRef.set(
          chunks.ref,
          new Map([
            [`${RUN}/row-1`, textTail('lo', first)],
            ['0ff1ce/row-1', textTail('hidden')],
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
        expect(merged.every((chunk) => chunk.runId === RUN)).toBe(true);
        expect(merged.map((chunk) => chunk.text).join('')).toBe('Hello');
        expect(merged[0]).toMatchObject({
          runId: RUN,
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
          new Map([[`${RUN}/row-1`, textTail('Hello')]]),
        );
        const host = yield* SubscriptionRef.make<HostSnapshot | null>(null);
        const webview = yield* WebviewSessions.open(KEY);
        const { frames, view } = webview;
        const shell = webview.subscriptions;
        // The shell: begin the generation and set its transcript set, then
        // post the Subscribe; the decoder feeds every frame that answers it.
        yield* frames.begin(subscribe.generation);
        yield* shell.set('shell', subscribe.aggregates);
        const parentDecoder = yield* Effect.forkScoped(
          Stream.runForEach(
            frameSubscription(source, PORT, host, subscribe),
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
                type: 'run.removed',
                runIds: [RUN],
                aggregateId: qualifyAggregateId('run', RUN),
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
          existence: null,
        });
        const ticker = yield* Effect.forkScoped(ticking);
        yield* settle(view.ref, (v) => rowText(v, RUN, 'row-1') === 'Hello');
        yield* settle(
          runtimeView.ref,
          (v) => rowText(v, RUN, 'row-1') === 'Hello',
        );
        expect(drawn(yield* SubscriptionRef.get(view.ref))).toEqual(
          drawn(yield* SubscriptionRef.get(runtimeView.ref)),
        );
        // A tail commit reaches both folds.
        yield* events.publish([running]);
        yield* SubscriptionRef.set(
          chunks.ref,
          new Map([[`${RUN}/row-1`, textTail('Hello again')]]),
        );
        yield* settle(
          view.ref,
          (v) =>
            v.runs.get(RUN)?.status === RUN_PHASE.RUNNING &&
            rowText(v, RUN, 'row-1') === 'Hello again',
        );
        yield* settle(
          runtimeView.ref,
          (v) => v.runs.get(RUN)?.status === RUN_PHASE.RUNNING,
        );
        const folded = yield* SubscriptionRef.get(view.ref);
        expect(drawn(folded)).toEqual(
          drawn(yield* SubscriptionRef.get(runtimeView.ref)),
        );
        expect(folded.cursor).toBe(4);

        // A new run: its run.start is a listing fact, framed to a shell
        // that has not named it. The shell names a run only once its view
        // holds it (`transcriptAggregates`), and live text is framed only for
        // the aggregates a Subscribe names, so it resubscribes naming it.
        yield* events.publish([
          { ...runStart, aggregateId: qualifyAggregateId('run', SECOND) },
        ]);
        yield* settle(view.ref, (v) => v.runs.has(SECOND));
        yield* settle(runtimeView.ref, (v) => v.runs.has(SECOND));
        yield* Fiber.interrupt(parentDecoder);
        const named: Subscribe = {
          ...subscribe,
          generation: 2,
          cursor: (yield* SubscriptionRef.get(view.ref)).cursor,
          aggregates: [
            ...subscribe.aggregates,
            { id: qualifyAggregateId('run', SECOND), fromSeq: 0 },
          ],
        };
        yield* frames.begin(named.generation);
        yield* shell.set('shell', named.aggregates);
        const decoder = yield* Effect.forkScoped(
          Stream.runForEach(
            frameSubscription(source, PORT, host, named),
            (frame) => frames.feed(frame),
          ),
        );
        // The named run's streaming row and the row's first prefix can
        // become ready in one turn.
        yield* events.publish([streamingRow(SECOND, 'row-2')]);
        yield* SubscriptionRef.update(
          chunks.ref,
          (held) => new Map([...held, [`${SECOND}/row-2`, textTail('First')]]),
        );
        yield* settle(view.ref, (v) => rowText(v, SECOND, 'row-2') === 'First');
        yield* SubscriptionRef.update(
          chunks.ref,
          (held) =>
            new Map([
              ...held,
              [
                `${SECOND}/row-2`,
                textTail(' suffix', held.get(`${SECOND}/row-2`)),
              ],
            ]),
        );
        yield* settle(
          view.ref,
          (v) => rowText(v, SECOND, 'row-2') === 'First suffix',
        );
        yield* settle(
          runtimeView.ref,
          (v) => rowText(v, SECOND, 'row-2') === 'First suffix',
        );

        // Neither a partial replay nor its superseded generation may mutate
        // the previously published view, whose indexes are shared by the fold.
        yield* Fiber.interrupt(decoder);
        const beforeLive = yield* SubscriptionRef.get(view.ref);
        const sameCursorFrame: EventsFrame = {
          kind: 'events',
          session: KEY,
          generation: named.generation,
          cursor: beforeLive.cursor,
          events: [],
          chunks: [],
          local: null,
          host: null,
          replayComplete: false,
          existence: null,
        };
        yield* frames.feed({
          ...sameCursorFrame,
          chunks: [
            {
              _tag: 'chunk',
              runId: RUN,
              rowId: 'row-1',
              from: 11,
              to: 12,
              text: '!',
            },
          ],
        });
        yield* TestClock.adjust('16 millis');
        expect(yield* SubscriptionRef.get(view.ref)).toBe(beforeLive);
        yield* frames.feed({
          ...sameCursorFrame,
          existence: {
            checkedAggregateIds: [qualifyAggregateId('run', RUN)],
            removedAggregateIds: [],
            claims: [
              {
                aggregateId: qualifyAggregateId('run', RUN),
                ownerId: null,
              },
            ],
          },
        });
        yield* settle(view.ref, (v) => v.runs.get(RUN)?.ownerId === null);
        const afterLive = yield* SubscriptionRef.get(view.ref);
        expect(afterLive.cursor).toBe(beforeLive.cursor);
        expect(rowText(afterLive, RUN, 'row-1')).toBe('Hello again!');
        const beforeReplay = yield* SubscriptionRef.get(view.ref);
        yield* frames.begin(3);
        yield* shell.set('shell', named.aggregates);
        yield* frames.feed({
          kind: 'events',
          session: KEY,
          generation: 3,
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
          existence: null,
        });
        yield* TestClock.adjust('16 millis');
        expect(yield* SubscriptionRef.get(view.ref)).toBe(beforeReplay);
        expect(beforeReplay.runs.get(RUN)?.status).toBe(RUN_PHASE.RUNNING);
        yield* frames.begin(4);
        yield* shell.set('shell', named.aggregates);
        const resumed = yield* Effect.forkScoped(
          Stream.runForEach(
            frameSubscription(source, PORT, host, {
              ...named,
              generation: 4,
              cursor: beforeReplay.cursor,
            }),
            (frame) => frames.feed(frame),
          ),
        );
        yield* settle(view.ref, (v) => v !== beforeReplay);
        expect(
          (yield* SubscriptionRef.get(view.ref)).runs.get(RUN)?.status,
        ).toBe(RUN_PHASE.RUNNING);
        yield* Fiber.interrupt(ticker);
        yield* Fiber.interrupt(resumed);
      }).pipe(
        Effect.provide(
          Layer.merge(
            // The row opens while the loop is still between steps: a parked
            // loop closes the transcript boundary, and a closed boundary
            // opens no streaming row for the live text to paint into.
            runtimeGraph([
              runStart,
              {
                type: 'run.description',
                aggregateId: qualifyAggregateId('run', RUN),
                description: 'framing',
              },
              streamingRow(RUN, 'row-1'),
            ]),
            WebviewSessions.layerNoDeps,
          ),
        ),
      ),
  );
});
