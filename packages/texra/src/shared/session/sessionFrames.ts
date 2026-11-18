/**
 * The channel between a host and the frontend that shows one of its
 * sessions (the extension's webviews, the desktop renderer, the trace
 * viewer's page): `effect/rpc` over the channel's `postMessage`, one
 * connection per session.
 *
 * `SessionRpcs` are the procedures a host's bridge serves per port
 * (`SessionBridge`) and a frontend calls (`sessionTransport.ts`):
 *
 * - `session.frames`: the session's view inputs from a cursor, with the
 *   transcripts named, as the runtime's reader orders them
 *   (`Session.view.watch`): a replay whole, then each tail read, each batch
 *   one `EventsFrame`. A new transcript set is a new call; the frontend's
 *   view interrupts the old one.
 * - `session.host`: what the host renders but does not own, each time its
 *   producers write it.
 * - `session.actions`: the host acting on state the surface owns (the
 *   composer's Send, a selection, the chime), the ones it sent before the
 *   surface listened first.
 * - `session.request` and `host.request`: one runtime or host command,
 *   answered with its outcome or the error it failed with, as the class.
 *
 * Every message on the channel is a {@link SessionEnvelope}: the session it
 * belongs to, the frontend instance that sent or is answered, and one of
 * `rpc`'s own messages.
 */
import { Schema } from 'effect';
import { Rpc, RpcGroup, type RpcMessage } from 'effect/rpc';

import {
  OutcomeSchema,
  RuntimeCommandSchema,
  RunIdSchema,
  StoredMediaSchema,
} from '@texra-ai/harness/schemas';
import {
  CommitOrdinalSchema,
  SessionViewInputSchema,
  TranscriptSubscriptionSchema,
} from '@texra-ai/harness/transcript';
import { BridgeErrorSchema } from './bridgeErrors';
import { HostCommandSchema } from './hostRequest';
import { HostSnapshotSchema } from './hostSnapshot';
import { LaunchPatchSchema } from './surface';

/** What a frontend asks frames for: from where its view stands. */
export const SubscribeSchema = Schema.Struct({
  /** The policy of the frontend's currently published view. */
  debug: Schema.Boolean,
  /** 0 on a cold mount; the view's cursor on a resubscribe. */
  cursor: CommitOrdinalSchema,
  /** The transcripts asked for: each `fromSeq` is the view's
   *  `transcriptSeq` entry, 0 when it holds none, never the cursor. */
  aggregates: Schema.Array(TranscriptSubscriptionSchema),
});
export type Subscribe = typeof SubscribeSchema.Type;

/** One batch of a subscription's view inputs. */
export const EventsFrameSchema = Schema.Struct({
  /** The commit the reader had drained when it cut this batch. */
  cursor: CommitOrdinalSchema,
  inputs: Schema.Array(SessionViewInputSchema),
});
export type EventsFrame = typeof EventsFrameSchema.Type;

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

/** The host-initiated surface actions, and only these. */
const HostSurfaceActionSchema = Schema.Union([
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
  /** A document task run of this session left running for finished or
   *  cancelled: the host decides the transition once and sends it to one
   *  port, which plays the completion chime. */
  Schema.Struct({ kind: Schema.Literal('chime') }),
  /** The setup agent selected by the onboarding funnel. */
  Schema.Struct({ kind: Schema.Literal('launch'), patch: LaunchPatchSchema }),
]);
export type HostSurfaceAction = typeof HostSurfaceActionSchema.Type;

/** The procedures of one session's connection, served by the host. */
export const SessionRpcs = RpcGroup.make(
  Rpc.make('session.frames', {
    payload: SubscribeSchema,
    success: EventsFrameSchema,
    stream: true,
  }),
  Rpc.make('session.host', { success: HostSnapshotSchema, stream: true }),
  Rpc.make('session.actions', {
    success: HostSurfaceActionSchema,
    stream: true,
  }),
  Rpc.make('session.request', {
    payload: { request: RuntimeCommandSchema },
    success: OutcomeSchema,
    error: BridgeErrorSchema,
  }),
  Rpc.make('host.request', {
    payload: { request: HostCommandSchema },
    success: HostOutcomeSchema,
    error: BridgeErrorSchema,
  }),
);

/**
 * One message on a session channel. `client` names the frontend instance:
 * a webview that reloads on the same port starts again with a new one, so
 * the host drops what is still in flight for the old instance instead of
 * answering the new one with it. `message` is an `rpc` message, which
 * `rpc` itself decodes.
 */
export const SessionEnvelopeSchema = Schema.Struct({
  session: Schema.NonEmptyString,
  client: Schema.NonEmptyString,
  message: Schema.Record(Schema.String, Schema.Unknown),
});
export type SessionEnvelope = typeof SessionEnvelopeSchema.Type;

/** A message as one end posts it: up, a client's; down, a server's. */
export interface SessionWire {
  readonly session: string;
  readonly client: string;
  readonly message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded;
}
