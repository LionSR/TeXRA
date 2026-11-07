/**
 * The bridge between a session runtime and a renderer process: the wire
 * schemas, up and down, and `SessionFrames`, the webview's source of
 * session events.
 *
 * Down: an `EventsFrame` carries one batch of the session's view inputs,
 * as the runtime's reader orders them (`Session.view.watch`): a replay
 * whole, then each tail read; `cursor` is the commit the reader had
 * drained when it cut the batch and `generation` echoes the `Subscribe`
 * that started it. A `HostFrame` carries what the host renders but does
 * not own. A `Response` answers one request under its id, and a
 * `SurfaceAction` is the host acting on state the surface owns. Up:
 * `Subscribe`, `runtime.request`, and `host.request`.
 *
 * `SessionFrames` supplies one ordered queue of batches for the current
 * generation; a new generation discards the superseded queue.
 */
import {
  Cause,
  Context,
  Effect,
  Layer,
  Queue,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';

import {
  OutcomeSchema,
  RequestErrorSchema,
  RuntimeCommandSchema,
  RunIdSchema,
  StoredMediaSchema,
} from '@texra-ai/harness/schemas';
import {
  CommitOrdinalSchema,
  EventInputSchema,
  SessionViewInputSchema,
  TranscriptSubscriptionSchema,
  type SessionViewInput,
} from '@texra-ai/harness/transcript';
import { HostCommandSchema } from './hostRequest';
import { HostSnapshotSchema, type HostSnapshot } from './hostSnapshot';
import { LaunchPatchSchema } from './surface';

/** The workspace root that keys the layer maps, on every message. */
const SessionKeySchema = Schema.String.check(Schema.isMinLength(1));
const GenerationSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const RequestIdSchema = Schema.String.check(Schema.isMinLength(1));

export type EventInput = typeof EventInputSchema.Type;

/** A surface's request for one session's frames, up the wire. */
export const SubscribeSchema = Schema.Struct({
  kind: Schema.Literal('subscribe'),
  session: SessionKeySchema,
  /** Chosen by the surface, monotone per view instance. */
  generation: GenerationSchema,
  /** The policy of the surface's currently published view. */
  debug: Schema.Boolean,
  /** 0 on a cold mount; the view's cursor on a resubscribe. */
  cursor: CommitOrdinalSchema,
  /** The transcripts asked for: each `fromSeq` is the view's
   *  `transcriptSeq` entry, 0 when it holds none, never the cursor. */
  aggregates: Schema.Array(TranscriptSubscriptionSchema),
});
export type Subscribe = typeof SubscribeSchema.Type;

/** One batch of a subscription's view inputs, down the wire. */
export const EventsFrameSchema = Schema.Struct({
  kind: Schema.Literal('events'),
  session: SessionKeySchema,
  generation: GenerationSchema,
  /** The commit the reader had drained when it cut this batch. */
  cursor: CommitOrdinalSchema,
  inputs: Schema.Array(SessionViewInputSchema),
});
export type EventsFrame = typeof EventsFrameSchema.Type;

/** What the host renders but does not own, as its producers write it. */
export const HostFrameSchema = Schema.Struct({
  kind: Schema.Literal('host'),
  session: SessionKeySchema,
  host: HostSnapshotSchema,
});
export type HostFrame = typeof HostFrameSchema.Type;

/** What the host answers a `host.request` with: the pickers and
 *  the drop return the paths they accepted, a polish returns its text, a
 *  stored image its file name, the editor's file I/O a listing, a file's
 *  contents, or a write refused because the file changed since it was
 *  read; everything else is done. */
const HostOutcomeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('done') }),
  Schema.Struct({
    kind: Schema.Literal('files'),
    paths: Schema.Array(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal('text'), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('savedImage'),
    fileName: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('entries'),
    entries: Schema.Array(
      Schema.Struct({ path: Schema.String, isDirectory: Schema.Boolean }),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal('contents'), contents: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('changedOnDisk') }),
]);
export type HostOutcome = typeof HostOutcomeSchema.Type;

const ResponseSchema = Schema.Struct({
  kind: Schema.Literal('response'),
  session: SessionKeySchema,
  requestId: RequestIdSchema,
  result: Schema.Union([
    Schema.Struct({
      ok: Schema.Literal(true),
      outcome: Schema.Union([OutcomeSchema, HostOutcomeSchema]),
    }),
    /** The request error the session answered with, as its fields: a
     *  `postMessage` keeps no Error prototype, so the surface decodes the
     *  class back with `RequestErrorSchema`. `Internal` is a handler defect
     *  whose cause stays in the host log under `ref`, the request id. */
    Schema.Struct({
      ok: Schema.Literal(false),
      error: Schema.toEncoded(RequestErrorSchema),
    }),
  ]),
});
export type Response = typeof ResponseSchema.Type;

/** The host-initiated surface actions, and only these. */
const SurfaceActionMessageSchema = Schema.Struct({
  kind: Schema.Literal('surface.action'),
  session: SessionKeySchema,
  action: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('selectNew') }),
    Schema.Struct({ kind: Schema.Literal('select'), runId: RunIdSchema }),
    /** A run the window started, in the host's view as of commit `cursor`:
     *  the surface's view, framed after the host's, selects it on arrival. */
    Schema.Struct({
      kind: Schema.Literal('selectOnArrival'),
      runId: RunIdSchema,
      cursor: CommitOrdinalSchema,
    }),
    /** Show Sessions (`texra.showProgressView`): a surface on the New-task
     *  state opens `runId`, the newest session; one already showing a
     *  session keeps it. The surface decides, since only it knows. */
    Schema.Struct({ kind: Schema.Literal('showSessions'), runId: RunIdSchema }),
    /** The run accelerator: the composer's Send for the surface's resolved
     *  selection, a follow-up to the selected stream or a launch. */
    Schema.Struct({ kind: Schema.Literal('submit') }),
    /** A fork's composer holds the message "Fork from here" cut before,
     *  with the media it attached as the composer's images. */
    Schema.Struct({
      kind: Schema.Literal('draft'),
      runId: RunIdSchema,
      text: Schema.String,
      images: Schema.Array(
        Schema.Struct({ fileName: Schema.String, media: StoredMediaSchema }),
      ),
    }),
    /** A workflow run of this session left running for finished or
     *  cancelled: the host decides the transition once and sends it to one
     *  port, which plays the completion chime. */
    Schema.Struct({ kind: Schema.Literal('chime') }),
    /** The setup agent selected by the onboarding funnel. */
    Schema.Struct({ kind: Schema.Literal('launch'), patch: LaunchPatchSchema }),
  ]),
});
export type SurfaceActionMessage = typeof SurfaceActionMessageSchema.Type;

const RuntimeCommandMessageSchema = Schema.Struct({
  kind: Schema.Literal('runtime.request'),
  session: SessionKeySchema,
  requestId: RequestIdSchema,
  request: RuntimeCommandSchema,
});

const HostCommandMessageSchema = Schema.Struct({
  kind: Schema.Literal('host.request'),
  session: SessionKeySchema,
  requestId: RequestIdSchema,
  request: HostCommandSchema,
});

export const UpMessageSchema = Schema.Union([
  SubscribeSchema,
  RuntimeCommandMessageSchema,
  HostCommandMessageSchema,
]);
export type UpMessage = typeof UpMessageSchema.Type;

export const DownMessageSchema = Schema.Union([
  EventsFrameSchema,
  HostFrameSchema,
  ResponseSchema,
  SurfaceActionMessageSchema,
]);
export type DownMessage = typeof DownMessageSchema.Type;

/** One generation's ordered frames. */
interface FrameRead {
  readonly generation: number;
  readonly queue: Queue.Queue<EventsFrame, Cause.Done>;
}

export class SessionFrames extends Context.Service<
  SessionFrames,
  {
    /** The current generation's batches, in arrival order, each whole. */
    readonly inputs: () => Stream.Stream<readonly SessionViewInput[]>;
    readonly host: SubscriptionRef.SubscriptionRef<HostSnapshot | null>;
    readonly begin: (generation: number) => Effect.Effect<void>;
    /** Deliver one frame; the caller feeds them in arrival order. A frame
     *  of another generation is dropped. */
    readonly feed: (frame: EventsFrame | HostFrame) => Effect.Effect<void>;
  }
>()('@texra/session/SessionFrames') {
  static readonly layer = Layer.effect(
    SessionFrames,
    Effect.gen(function* () {
      const host = yield* SubscriptionRef.make<HostSnapshot | null>(null);
      const current = yield* SubscriptionRef.make<FrameRead>({
        generation: 0,
        queue: yield* Queue.unbounded<EventsFrame, Cause.Done>(),
      });
      return {
        host,
        inputs: () =>
          Stream.unwrap(
            Effect.map(SubscriptionRef.get(current), ({ queue }) =>
              Stream.fromQueue(queue).pipe(Stream.map((frame) => frame.inputs)),
            ),
          ),
        begin: Effect.fn('sessionFrames.begin')(function* (generation) {
          yield* SubscriptionRef.set(current, {
            generation,
            queue: yield* Queue.unbounded<EventsFrame, Cause.Done>(),
          });
        }),
        feed: Effect.fn('sessionFrames.feed')(function* (frame) {
          if (frame.kind === 'host')
            return yield* SubscriptionRef.set(host, frame.host);
          const read = yield* SubscriptionRef.get(current);
          if (frame.generation !== read.generation) return;
          yield* Queue.offer(read.queue, frame);
        }),
      };
    }),
  );
}
