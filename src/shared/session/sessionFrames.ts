/**
 * The bridge between a session runtime and a renderer process (PRD
 * one-fold-three-renderers, 7.4, 8.1, 8.4, 8.5): the Zod wire, up and down,
 * and `SessionFrames`, the webview's source of session events.
 *
 * Down: an `EventsFrame` carries the rows one `Subscribe` asked for, tagged
 * by the read that delivered them, then the tail; `cursor` is the commit
 * ordinal the framer had drained when it cut the frame and `generation`
 * echoes the `Subscribe` that started it. A `Response` answers one request
 * under its id, and a `SurfaceAction` is the host acting on state the
 * surface owns. Up: `Subscribe`, `runtime.request`, and `host.request`.
 *
 * `SessionFrames` is what `SessionEvents.transportLayer` reads: the decoder
 * feeds each frame's rows to the queue of its read, ends the listing and
 * aggregate queues at the frame that carries `replayComplete`, and drops a
 * frame whose generation is not the current one. The fold fiber over these
 * queues is the unchanged `SessionViewService`.
 */
import {
  Cause,
  Context,
  Effect,
  Layer,
  Queue,
  Stream,
  SubscriptionRef,
} from 'effect';
import { z } from 'zod';

import {
  CommitOrdinalSchema,
  FoldEventSchema,
  LocalRuntimeStateSchema,
  SessionEventSchema,
  StreamTabIdSchema,
  TextChunkSchema,
  TranscriptSubscriptionSchema,
  type AggregateId,
  type LocalRuntimeState,
  type SessionEvent,
  type TextChunk,
} from '@shared/schemas';
import { HostRequestSchema } from './hostRequest';
import { HostSnapshotSchema, type HostSnapshot } from './hostSnapshot';
import { OutcomeSchema, RuntimeRequestSchema } from './runtimeRequest';
import { LaunchPatchSchema } from './surface';

/** The workspace root that keys the layer maps, on every message. */
const SessionKeySchema = z.string().min(1);
const GenerationSchema = z.int().nonnegative();
const RequestIdSchema = z.string().min(1);

export type FoldEvent = z.infer<typeof FoldEventSchema>;

const SubscribeSchema = z.object({
  kind: z.literal('subscribe'),
  session: SessionKeySchema,
  /** Chosen by the surface, monotone per view instance. */
  generation: GenerationSchema,
  /** 0 on a cold mount; the view's cursor on a resubscribe. */
  cursor: CommitOrdinalSchema,
  /** The transcript tier: each `fromSeq` is `view.folded[id]`, 0 when the
   *  view holds no entry, never the cursor. */
  aggregates: z.array(TranscriptSubscriptionSchema),
});
export type Subscribe = z.infer<typeof SubscribeSchema>;

const EventsFrameSchema = z.object({
  kind: z.literal('events'),
  session: SessionKeySchema,
  generation: GenerationSchema,
  cursor: CommitOrdinalSchema,
  events: z.array(FoldEventSchema),
  chunks: z.array(TextChunkSchema),
  local: LocalRuntimeStateSchema.nullable(),
  host: HostSnapshotSchema.nullable(),
  /** True on the frame that ends the reads this `Subscribe` started. */
  replayComplete: z.boolean(),
});
export type EventsFrame = z.infer<typeof EventsFrameSchema>;

/** The request errors of 7.6 on the wire, plus the bridge's own `Invalid`
 *  for a message it could not parse. `Internal` is a handler defect: the
 *  message stays in the host log under `ref`, the request id, and never
 *  crosses to a renderer (C3). */
const RequestErrorWireSchema = z.discriminatedUnion('_tag', [
  z.object({ _tag: z.literal('NotOwner'), streamId: StreamTabIdSchema }),
  z.object({
    _tag: z.literal('Unavailable'),
    streamId: StreamTabIdSchema,
    reason: z.string(),
  }),
  z.object({ _tag: z.literal('Rejected'), reason: z.string() }),
  z.object({ _tag: z.literal('Invalid'), reason: z.string() }),
  z.object({ _tag: z.literal('Internal'), ref: RequestIdSchema }),
]);
export type RequestErrorWire = z.infer<typeof RequestErrorWireSchema>;

/** What the host answers a `host.request` with (PRD 8.3): the pickers and
 *  the drop return the paths they accepted, a polish returns its text, a
 *  stored image its file name; everything else is done. */
const HostOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done') }),
  z.object({ kind: z.literal('files'), paths: z.array(z.string()) }),
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('savedImage'), fileName: z.string() }),
]);
export type HostOutcome = z.infer<typeof HostOutcomeSchema>;

const ResponseSchema = z.object({
  kind: z.literal('response'),
  session: SessionKeySchema,
  requestId: RequestIdSchema,
  result: z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      outcome: z.union([OutcomeSchema, HostOutcomeSchema]),
    }),
    z.object({ ok: z.literal(false), error: RequestErrorWireSchema }),
  ]),
});
export type Response = z.infer<typeof ResponseSchema>;

/** The host-initiated surface actions (PRD 8.5), and only these. */
const SurfaceActionMessageSchema = z.object({
  kind: z.literal('surface.action'),
  session: SessionKeySchema,
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('selectNew') }),
    z.object({ kind: z.literal('select'), streamId: StreamTabIdSchema }),
    z.object({ kind: z.literal('toggleDrawer') }),
    z.object({ kind: z.literal('submitLaunch') }),
    /** A run's setup restored into the launcher (`restoreIntoLauncher`,
     *  `restoreProposalConfig`), or the setup agent selected by the
     *  onboarding funnel. */
    z.object({ kind: z.literal('launch'), patch: LaunchPatchSchema }),
  ]),
});
export type SurfaceActionMessage = z.infer<typeof SurfaceActionMessageSchema>;

const RuntimeRequestMessageSchema = z.object({
  kind: z.literal('runtime.request'),
  session: SessionKeySchema,
  requestId: RequestIdSchema,
  request: RuntimeRequestSchema,
});

const HostRequestMessageSchema = z.object({
  kind: z.literal('host.request'),
  session: SessionKeySchema,
  requestId: RequestIdSchema,
  request: HostRequestSchema,
});

export const UpMessageSchema = z.discriminatedUnion('kind', [
  SubscribeSchema,
  RuntimeRequestMessageSchema,
  HostRequestMessageSchema,
]);
export type UpMessage = z.infer<typeof UpMessageSchema>;

export const DownMessageSchema = z.discriminatedUnion('kind', [
  EventsFrameSchema,
  ResponseSchema,
  SurfaceActionMessageSchema,
]);
export type DownMessage = z.infer<typeof DownMessageSchema>;

/** `${streamId}/${rowId}`: the in-flight text of one streaming row. */
type InflightText = ReadonlyMap<string, string>;

type EventQueue = Queue.Queue<SessionEvent, Cause.Done>;

/** One `Subscribe`'s replay queues: the listing and one per aggregate,
 *  ended together at the `replayComplete` frame. */
interface Replay {
  readonly generation: number;
  readonly listing: EventQueue;
  readonly aggregates: Map<AggregateId, EventQueue>;
  ended: boolean;
}

/** The row's text after a chunk (PRD 5.2): truncate at `from`, append. */
function applyChunk(held: string, chunk: TextChunk): string {
  return held.slice(0, chunk.from) + chunk.text;
}

export class SessionFrames extends Context.Service<
  SessionFrames,
  {
    /** The current `Subscribe`'s listing rows; ends at `replayComplete`. */
    readonly listing: () => Stream.Stream<SessionEvent>;
    /** The tail: every `all` row of a current-generation frame. */
    readonly events: () => Stream.Stream<SessionEvent>;
    /** One aggregate's history rows of the current `Subscribe`; ends at
     *  `replayComplete`. `fromSeq` is the runtime's to honor: it read the
     *  history the `Subscribe` named. */
    readonly aggregate: (
      aggregateId: AggregateId,
      fromSeq: number,
    ) => Stream.Stream<SessionEvent>;
    /** The runtime's local snapshot, as the last frame carried it. */
    readonly local: SubscriptionRef.SubscriptionRef<LocalRuntimeState>;
    /** The host snapshot (8.1), as the last frame carried it; null until
     *  one has. */
    readonly host: SubscriptionRef.SubscriptionRef<HostSnapshot | null>;
    /** Every chunk of a current-generation frame, in frame order. */
    readonly chunks: Stream.Stream<TextChunk>;
    /** The in-flight text level the chunks build, keyed `${streamId}/${rowId}`. */
    readonly inflight: SubscriptionRef.SubscriptionRef<InflightText>;
    /** A new `Subscribe` was issued under `generation`: fresh replay queues
     *  replace the current ones; frames of any other generation are dropped
     *  from here on. */
    readonly begin: (generation: number) => Effect.Effect<void>;
    /** Route one frame's rows, chunks, and the two snapshots it carries;
     *  synchronous, so a decoder feeds frames in arrival order with
     *  `runSync` and no two frames ever interleave. */
    readonly feed: (frame: EventsFrame) => Effect.Effect<void>;
  }
>()('@texra/session/SessionFrames') {
  static readonly layer = Layer.effect(
    SessionFrames,
    Effect.gen(function* () {
      const tail = yield* Queue.unbounded<SessionEvent, Cause.Done>();
      const chunks = yield* Queue.unbounded<TextChunk, Cause.Done>();
      const local = yield* SubscriptionRef.make<LocalRuntimeState>({
        self: [],
        heldBy: [],
        unreadable: [],
      });
      const host = yield* SubscriptionRef.make<HostSnapshot | null>(null);
      const inflight = yield* SubscriptionRef.make<InflightText>(new Map());
      const newQueue = Queue.unbounded<SessionEvent, Cause.Done>();
      const newReplay = (generation: number): Effect.Effect<Replay> =>
        Effect.map(newQueue, (listing) => ({
          generation,
          listing,
          aggregates: new Map(),
          ended: false,
        }));
      // A frames service always has a current generation: the fold opens
      // its reads at build, before the shell's first `Subscribe`, on
      // generation 0, whose queues end when a frame of it says so and are
      // otherwise superseded by the first `begin`.
      let replay = yield* newReplay(0);
      const aggregateQueue = (
        current: Replay,
        aggregateId: AggregateId,
      ): Effect.Effect<EventQueue> =>
        Effect.gen(function* () {
          const held = current.aggregates.get(aggregateId);
          if (held) return held;
          const queue = yield* newQueue;
          current.aggregates.set(aggregateId, queue);
          // Asked for after the replay ended: an aggregate the runtime had
          // no rows for; its history is empty and complete.
          if (current.ended) yield* Queue.end(queue);
          return queue;
        });
      return {
        listing: () => Stream.suspend(() => Stream.fromQueue(replay.listing)),
        events: () => Stream.fromQueue(tail),
        aggregate: (aggregateId) =>
          Stream.unwrap(
            Effect.suspend(() => aggregateQueue(replay, aggregateId)).pipe(
              Effect.map((queue) => Stream.fromQueue(queue)),
            ),
          ),
        local,
        host,
        chunks: Stream.fromQueue(chunks),
        inflight,
        begin: (generation) =>
          Effect.gen(function* () {
            replay = yield* newReplay(generation);
          }),
        feed: (frame) =>
          Effect.gen(function* () {
            const current = replay;
            if (current.generation !== frame.generation) return;
            for (const row of frame.events) {
              switch (row.read) {
                case 'listing':
                  yield* Queue.offer(current.listing, row.event);
                  break;
                case 'aggregate':
                  yield* Queue.offer(
                    yield* aggregateQueue(current, row.event.aggregateId),
                    row.event,
                  );
                  break;
                case 'all':
                  yield* Queue.offer(tail, row.event);
                  break;
              }
            }
            if (frame.chunks.length > 0) {
              yield* SubscriptionRef.update(inflight, (held) => {
                const next = new Map(held);
                for (const chunk of frame.chunks) {
                  const key = `${chunk.streamId}/${chunk.rowId}`;
                  next.set(key, applyChunk(next.get(key) ?? '', chunk));
                }
                return next;
              });
              yield* Queue.offerAll(chunks, frame.chunks);
            }
            if (frame.local) yield* SubscriptionRef.set(local, frame.local);
            if (frame.host) yield* SubscriptionRef.set(host, frame.host);
            if (frame.replayComplete && !current.ended) {
              current.ended = true;
              yield* Queue.end(current.listing);
              for (const queue of current.aggregates.values()) {
                yield* Queue.end(queue);
              }
            }
          }),
      };
    }),
  );
}
