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
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';

import {
  OutcomeSchema,
  RuntimeRequestSchema,
  RunIdSchema,
} from '@texra-ai/harness/schemas';
import {
  CommitOrdinalSchema,
  ExistenceReconciliationSchema,
  EventInputSchema,
  LocalRuntimeStateSchema,
  TextChunkSchema,
  TranscriptSubscriptionSchema,
  type SessionViewInput,
  type TranscriptSubscription,
} from '@texra-ai/harness/transcript';
import { HostRequestSchema } from './hostRequest';
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

/** One frame of a subscription's rows and text, down the wire. */
export const EventsFrameSchema = Schema.Struct({
  kind: Schema.Literal('events'),
  session: SessionKeySchema,
  generation: GenerationSchema,
  cursor: CommitOrdinalSchema,
  events: Schema.Array(EventInputSchema),
  chunks: Schema.Array(TextChunkSchema),
  local: Schema.NullOr(LocalRuntimeStateSchema),
  host: Schema.NullOr(HostSnapshotSchema),
  /** Fold policy sampled by the process reader for this replay. */
  debug: Schema.NullOr(Schema.Boolean),
  /** True on the frame that ends the reads this `Subscribe` started. */
  replayComplete: Schema.Boolean,
  /** Only the final frame of a finite read carries its checked claims. */
  existence: Schema.NullOr(ExistenceReconciliationSchema),
});
export type EventsFrame = typeof EventsFrameSchema.Type;

/** The request errors `SessionRequests` answers, on the wire, plus the
 *  bridge's own `Invalid` for a message it could not parse. `Internal` is a
 *  handler defect: the message stays in the host log under `ref`, the
 *  request id, and never crosses to a renderer. */
export const RequestErrorWireSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('NotOwner'), runId: RunIdSchema }),
  Schema.Struct({
    _tag: Schema.Literal('Unavailable'),
    runId: RunIdSchema,
    reason: Schema.String,
  }),
  Schema.Struct({ _tag: Schema.Literal('Cancelled') }),
  Schema.Struct({
    _tag: Schema.Literal('Rejected'),
    reason: Schema.String,
    docsPage: Schema.optional(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.Literal('Invalid'), reason: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal('Internal'), ref: RequestIdSchema }),
]);
export type RequestErrorWire = typeof RequestErrorWireSchema.Type;

/** What the host answers a `host.request` with (PRD 8.3): the pickers and
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
    Schema.Struct({ ok: Schema.Literal(false), error: RequestErrorWireSchema }),
  ]),
});
export type Response = typeof ResponseSchema.Type;

/** The host-initiated surface actions (PRD 8.5), and only these. */
const SurfaceActionMessageSchema = Schema.Struct({
  kind: Schema.Literal('surface.action'),
  session: SessionKeySchema,
  action: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('selectNew') }),
    Schema.Struct({ kind: Schema.Literal('select'), runId: RunIdSchema }),
    /** Show Sessions (`texra.showProgressView`): a surface on the New-task
     *  state opens `runId`, the newest session; one already showing a
     *  session keeps it. The surface decides, since only it knows. */
    Schema.Struct({ kind: Schema.Literal('showSessions'), runId: RunIdSchema }),
    /** The run accelerator: the composer's Send for the surface's resolved
     *  selection, a follow-up to the selected stream or a launch (PRD 12.4). */
    Schema.Struct({ kind: Schema.Literal('submit') }),
    /** A fork's composer holds the message "Fork from here" cut before,
     *  with the files it attached as the composer's images. */
    Schema.Struct({
      kind: Schema.Literal('draft'),
      runId: RunIdSchema,
      text: Schema.String,
      images: Schema.Array(
        Schema.Struct({ fileName: Schema.String, path: Schema.String }),
      ),
    }),
    /** A workflow run of this session left running for finished or
     *  cancelled: the host decides the transition once and sends it to one
     *  port, which plays the completion chime (PRD 12.4). */
    Schema.Struct({ kind: Schema.Literal('chime') }),
    /** The setup agent selected by the onboarding funnel. */
    Schema.Struct({ kind: Schema.Literal('launch'), patch: LaunchPatchSchema }),
  ]),
});
export type SurfaceActionMessage = typeof SurfaceActionMessageSchema.Type;

const RuntimeRequestMessageSchema = Schema.Struct({
  kind: Schema.Literal('runtime.request'),
  session: SessionKeySchema,
  requestId: RequestIdSchema,
  request: RuntimeRequestSchema,
});

const HostRequestMessageSchema = Schema.Struct({
  kind: Schema.Literal('host.request'),
  session: SessionKeySchema,
  requestId: RequestIdSchema,
  request: HostRequestSchema,
});

export const UpMessageSchema = Schema.Union([
  SubscribeSchema,
  RuntimeRequestMessageSchema,
  HostRequestMessageSchema,
]);
export type UpMessage = typeof UpMessageSchema.Type;

export const DownMessageSchema = Schema.Union([
  EventsFrameSchema,
  ResponseSchema,
  SurfaceActionMessageSchema,
]);
export type DownMessage = typeof DownMessageSchema.Type;

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
      previousDebug: boolean,
    ) => Stream.Stream<readonly SessionViewInput[]>;
    readonly host: SubscriptionRef.SubscriptionRef<HostSnapshot | null>;
    readonly begin: (generation: number) => Effect.Effect<void>;
    /** Deliver one frame; the caller feeds them in arrival order. */
    readonly feed: (frame: EventsFrame) => Effect.Effect<void>;
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
        inputs: (aggregates, previousDebug) =>
          Stream.unwrap(
            Effect.map(SubscriptionRef.get(current), ({ queue }) =>
              Stream.fromQueue(queue).pipe(
                Stream.mapAccum(
                  (): {
                    debug?: boolean;
                    pending: SessionViewInput[];
                    complete: boolean;
                  } => ({ pending: [], complete: false }),
                  (state, frame) => {
                    if (!state.complete && frame.debug !== null)
                      state.debug = frame.debug;
                    state.pending.push(...frame.events, ...frame.chunks);
                    if (frame.local)
                      state.pending.push({ _tag: 'local', local: frame.local });
                    if (frame.existence !== null) {
                      const marker: SessionViewInput = frame.replayComplete
                        ? {
                            _tag: 'replay.complete',
                            existence: frame.existence,
                          }
                        : {
                            _tag: 'drained',
                            cursor: frame.cursor,
                            existence: frame.existence,
                          };
                      state.pending.push(marker);
                    }
                    if (!state.complete) {
                      if (!frame.replayComplete || state.debug === undefined)
                        return [state, []] as const;
                      const reset = state.debug !== previousDebug;
                      const prefix: SessionViewInput[] = [
                        { _tag: 'debug', enabled: state.debug },
                        {
                          _tag: 'subscriptions',
                          set: aggregates.map((entry) => ({
                            ...entry,
                            fromSeq: reset ? 0 : entry.fromSeq,
                          })),
                        },
                      ];
                      return [
                        {
                          ...state,
                          pending: [] as SessionViewInput[],
                          complete: true,
                        },
                        [[...prefix, ...state.pending]],
                      ] as const;
                    }
                    if (frame.existence === null) return [state, []] as const;
                    return [
                      { ...state, pending: [] as SessionViewInput[] },
                      [state.pending],
                    ] as const;
                  },
                ),
              ),
            ),
          ),
        begin: (generation) =>
          Effect.gen(function* () {
            yield* SubscriptionRef.set(current, {
              generation,
              queue: yield* Queue.unbounded<EventsFrame, Cause.Done>(),
            });
          }),
        feed: (frame) =>
          Effect.gen(function* () {
            const read = yield* SubscriptionRef.get(current);
            if (frame.generation !== read.generation) return;
            if (frame.host) yield* SubscriptionRef.set(host, frame.host);
            yield* Queue.offer(read.queue, frame);
          }),
      };
    }),
  );
}
