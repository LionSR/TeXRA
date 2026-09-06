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
 * `SessionFrames` supplies one ordered queue for the current generation.
 * It collects a replay through its completion marker before releasing it
 * to the fold, then delivers each frame's events before its text chunks.
 * A new generation discards the superseded queue and incomplete replay.
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
  StreamTabIdSchema,
  TextChunkSchema,
  TranscriptSubscriptionSchema,
  type FoldInput,
  type TranscriptSubscription,
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
  z.object({ _tag: z.literal('Cancelled') }),
  z.object({
    _tag: z.literal('Rejected'),
    reason: z.string(),
    docsCommand: z.string().optional(),
  }),
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
    /** The run accelerator: the composer's Send for the surface's resolved
     *  selection, a follow-up to the selected stream or a launch (PRD 12.4). */
    z.object({ kind: z.literal('submit') }),
    /** A workflow run of this session left running for finished or
     *  cancelled: the host decides the transition once and sends it to one
     *  port, which plays the completion chime (PRD 12.4). */
    z.object({ kind: z.literal('chime') }),
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

/** One generation's ordered frames; replay is collected before publication. */
interface FrameRead {
  readonly generation: number;
  readonly queue: Queue.Queue<EventsFrame, Cause.Done>;
}

export class SessionFrames extends Context.Service<
  SessionFrames,
  {
    readonly inputs: (
      aggregates: readonly TranscriptSubscription[],
    ) => Stream.Stream<readonly FoldInput[]>;
    readonly host: SubscriptionRef.SubscriptionRef<HostSnapshot | null>;
    readonly begin: (generation: number) => Effect.Effect<void>;
    /** Feed a frame synchronously, preserving arrival order. */
    readonly feed: (frame: EventsFrame) => Effect.Effect<void>;
  }
>()('@texra/session/SessionFrames') {
  static readonly layer = Layer.effect(
    SessionFrames,
    Effect.gen(function* () {
      const host = yield* SubscriptionRef.make<HostSnapshot | null>(null);
      let current: FrameRead = {
        generation: 0,
        queue: yield* Queue.unbounded<EventsFrame, Cause.Done>(),
      };
      return {
        host,
        inputs: (aggregates) =>
          Stream.suspend(() =>
            Stream.fromQueue(current.queue).pipe(
              Stream.mapAccum(
                () => ({
                  replay: [
                    { _tag: 'subscriptions', set: [...aggregates] },
                  ] as FoldInput[],
                  complete: false,
                }),
                (state, frame) => {
                  const history = frame.events.filter(
                    (row) => row.read !== 'all',
                  );
                  const tail = frame.events.filter((row) => row.read === 'all');
                  const local: FoldInput[] = frame.local
                    ? [{ _tag: 'local', local: frame.local }]
                    : [];
                  const live: FoldInput[] = [
                    ...tail,
                    ...frame.chunks,
                    ...local,
                    { _tag: 'drained', cursor: frame.cursor },
                  ];
                  if (state.complete) return [state, [live]] as const;
                  state.replay.push(...history, ...local);
                  if (!frame.replayComplete) return [state, []] as const;
                  const batch: FoldInput[] = [
                    ...state.replay,
                    { _tag: 'replay.complete' },
                    ...live,
                  ];
                  return [
                    { replay: [] as FoldInput[], complete: true },
                    [batch],
                  ] as const;
                },
              ),
            ),
          ),
        begin: (generation) =>
          Effect.gen(function* () {
            current = {
              generation,
              queue: yield* Queue.unbounded<EventsFrame, Cause.Done>(),
            };
          }),
        feed: (frame) =>
          Effect.gen(function* () {
            if (frame.generation !== current.generation) return;
            yield* Queue.offer(current.queue, frame);
            if (frame.host) yield* SubscriptionRef.set(host, frame.host);
          }),
      };
    }),
  );
}
