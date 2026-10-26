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
import { Effect, Fiber, Layer, Stream, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vitest';

import { sessionEventsLayer } from '@agent/runtime/SessionEvents';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
  type InflightTextChunk,
} from '@controllers/session/sessionSources';
import { databaseLayer } from '@controllers/session/Database';
import { SessionViewService } from '@controllers/session/SessionView';
import { sessionInputsLayer } from '@controllers/session/sessionInputs';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { runStateAppend } from '@shared/session/runHistory';
import {
  qualifyAggregateId,
  MESSAGE_TYPES,
  RUN_PHASE,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import { Database } from '@shared/session/database';
import { SessionInputs } from '@shared/session/sessionInputs';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import type { SessionView } from '@shared/session/readonlyViews';
import {
  createFakeWorkspaceRoots,
  fakeConfig,
} from '@test/support/FakePlatform';
import { storePluginsLayer } from '@test/support/setupPlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import type {
  EventsFrame,
  Subscribe,
} from '@texra/shared/session/sessionFrames';
import {
  emptyHostSnapshot,
  type HostSnapshot,
} from '@texra/shared/session/hostSnapshot';
import {
  frameSubscription,
  type FramerSource,
} from '@texra/controllers/session/SessionFramer';
import { WebviewSessions } from '@texra/controllers/session/webviewSessionLayer';

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
const HOST: HostSnapshot = emptyHostSnapshot({
  key: KEY,
  name: 'Framing',
  initials: 'FR',
  subtitle: KEY,
});

const runStart: SessionEventDraft = {
  type: 'run.start',
  aggregateId: qualifyAggregateId('run', RUN),
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'unsupported',
  parent: null,
  provenance: null,
};

/** The loop parked on a request: the fold reads the phase off this row. */
const waiting: SessionEventDraft = {
  type: 'run.position',
  aggregateId: qualifyAggregateId('run', RUN),
  payload: { family: 'toolUse', at: 'waiting' },
};

/** The loop moving again, which is what makes the run running. */
const running: SessionEventDraft = {
  type: 'run.position',
  aggregateId: qualifyAggregateId('run', RUN),
  payload: { family: 'toolUse', at: 'turn.begin', turn: 1 },
};

/** A running model reply with no text of its own: the row the live text for
 *  `rowId` paints into once its entry folds. */
function streamingRow(
  runId: RunId,
  rowId: string,
): Extract<SessionEventDraft, { type: 'stream.start' }> {
  return {
    type: 'stream.start',
    aggregateId: qualifyAggregateId('run', runId),
    id: rowId,
    kind: MESSAGE_TYPES.MODEL_RESPONSE,
  };
}

/** The runtime graph, as `sessionLayer` composes it without the host bits. */
const runtimeGraph = (
  history: readonly SessionEventDraft[],
  config = fakeConfig(),
) => {
  const roots = createFakeWorkspaceRoots({ storagePath: KEY }, { config });
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
            Layer.provideMerge(
              databaseLayer('ephemeral').pipe(
                Layer.orDie,
                Layer.provide(storePluginsLayer),
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
    Layer.provide(nodePlatformLayer),
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
  changes: Stream.Stream<SessionView>,
  ready: (view: SessionView) => boolean,
) => changes.pipe(Stream.takeUntil(ready), Stream.runDrain);

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
  debug: false,
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
    view: {
      current: () => SubscriptionRef.getUnsafe(view.ref),
      watch: (set, from) =>
        Stream.unwrap(
          Effect.acquireRelease(subscriptions.set(PORT, set), () =>
            subscriptions.set(PORT, []),
          ).pipe(Effect.as(inputs.read(set, from.cursor, from.debug))),
        ),
    },
  };
  return source;
});

describe('session framer', () => {
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
        const host = yield* SubscriptionRef.make<HostSnapshot | null>(HOST);
        const webview = yield* WebviewSessions.open(KEY);
        const { frames, view } = webview;
        // The shell: begin the generation and set its transcript set, then
        // post the Subscribe; the decoder feeds every frame that answers it.
        yield* frames.begin(subscribe.generation);
        yield* view.subscribe('shell', subscribe.aggregates);
        const parentDecoder = yield* Effect.forkScoped(
          Stream.runForEach(
            frameSubscription(source, host, subscribe),
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
                origin: SELF,
                at: 0,
              },
            },
          ],
          chunks: [],
          local: null,
          host: null,
          debug: null,
          replayComplete: false,
          existence: null,
        });
        const ticker = yield* Effect.forkScoped(ticking);
        yield* settle(
          view.changes,
          (v) => rowText(v, RUN, 'row-1') === 'Hello',
        );
        yield* settle(
          runtimeView.changes,
          (v) => rowText(v, RUN, 'row-1') === 'Hello',
        );
        expect(drawn(view.current())).toEqual(
          drawn(yield* SubscriptionRef.get(runtimeView.ref)),
        );
        // A tail commit reaches both folds.
        yield* events.transact((append) => runStateAppend(append)([running]));
        yield* SubscriptionRef.set(
          chunks.ref,
          new Map([[`${RUN}/row-1`, textTail('Hello again')]]),
        );
        yield* settle(
          view.changes,
          (v) =>
            v.runs.get(RUN)?.status === RUN_PHASE.RUNNING &&
            rowText(v, RUN, 'row-1') === 'Hello again',
        );
        yield* settle(
          runtimeView.changes,
          (v) => v.runs.get(RUN)?.status === RUN_PHASE.RUNNING,
        );
        const folded = view.current();
        expect(folded.debug).toBe(false);
        expect(drawn(folded)).toEqual(
          drawn(yield* SubscriptionRef.get(runtimeView.ref)),
        );
        expect(folded.cursor).toBe(4);

        // A new run: its run.start is a listing fact, framed to a shell
        // that has not named it. The shell names a run only once its view
        // holds it (`transcriptAggregates`), and live text is framed only for
        // the aggregates a Subscribe names, so it resubscribes naming it.
        yield* events.transact((append) =>
          append([
            { ...runStart, aggregateId: qualifyAggregateId('run', SECOND) },
          ]),
        );
        yield* settle(view.changes, (v) => v.runs.has(SECOND));
        yield* settle(runtimeView.changes, (v) => v.runs.has(SECOND));
        yield* Fiber.interrupt(parentDecoder);
        const named: Subscribe = {
          ...subscribe,
          generation: 2,
          cursor: view.current().cursor,
          aggregates: [
            ...subscribe.aggregates,
            { id: qualifyAggregateId('run', SECOND), fromSeq: 0 },
          ],
        };
        yield* frames.begin(named.generation);
        yield* view.subscribe('shell', named.aggregates);
        const decoder = yield* Effect.forkScoped(
          Stream.runForEach(frameSubscription(source, host, named), (frame) =>
            frames.feed(frame),
          ),
        );
        // The named run's streaming row and the row's first prefix can
        // become ready in one turn.
        yield* events.transact((append) =>
          append([streamingRow(SECOND, 'row-2')]),
        );
        yield* SubscriptionRef.update(
          chunks.ref,
          (held) => new Map([...held, [`${SECOND}/row-2`, textTail('First')]]),
        );
        yield* settle(
          view.changes,
          (v) => rowText(v, SECOND, 'row-2') === 'First',
        );
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
          view.changes,
          (v) => rowText(v, SECOND, 'row-2') === 'First suffix',
        );
        yield* settle(
          runtimeView.changes,
          (v) => rowText(v, SECOND, 'row-2') === 'First suffix',
        );

        // Neither a partial replay nor its superseded generation may mutate
        // the previously published view, whose indexes are shared by the fold.
        yield* Fiber.interrupt(decoder);
        const beforeLive = view.current();
        const sameCursorFrame: EventsFrame = {
          kind: 'events',
          session: KEY,
          generation: named.generation,
          cursor: beforeLive.cursor,
          events: [],
          chunks: [],
          local: null,
          host: null,
          debug: null,
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
        expect(view.current()).toBe(beforeLive);
        yield* frames.feed({
          ...sameCursorFrame,
          existence: {
            checkedAggregateIds: [qualifyAggregateId('run', RUN)],
            claims: [
              {
                aggregateId: qualifyAggregateId('run', RUN),
                ownerId: null,
              },
            ],
          },
        });
        yield* settle(view.changes, (v) => v.runs.get(RUN)?.ownerId === null);
        const afterLive = view.current();
        expect(afterLive.cursor).toBe(beforeLive.cursor);
        expect(rowText(afterLive, RUN, 'row-1')).toBe('Hello again!');
        const beforeReplay = view.current();
        yield* frames.begin(3);
        yield* view.subscribe('shell', named.aggregates);
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
                origin: SELF,
                at: 0,
              },
            },
          ],
          chunks: [],
          local: null,
          host: null,
          debug: null,
          replayComplete: false,
          existence: null,
        });
        yield* TestClock.adjust('16 millis');
        expect(view.current()).toBe(beforeReplay);
        expect(beforeReplay.runs.get(RUN)?.status).toBe(RUN_PHASE.RUNNING);
        yield* frames.begin(4);
        yield* view.subscribe('shell', named.aggregates);
        const resumed = yield* Effect.forkScoped(
          Stream.runForEach(
            frameSubscription(source, host, {
              ...named,
              generation: 4,
              cursor: beforeReplay.cursor,
            }),
            (frame) => frames.feed(frame),
          ),
        );
        yield* settle(view.changes, (v) => v !== beforeReplay);
        expect(view.current().runs.get(RUN)?.status).toBe(RUN_PHASE.RUNNING);
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
                by: 'model',
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
