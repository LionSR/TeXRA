/**
 * What the service asks of a window: the host capabilities a run uses while
 * it runs in the service (a file's diagnostics, an inline criticism, a PDF
 * to open, a notice to show). The window serves them (`WindowRpcs`) and the
 * service calls them, over the service's own protocol turned around: a
 * window offers the capabilities it has when it attaches (`host.attach`),
 * the service's `rpc` messages reach it as frames of that stream, and the
 * window's replies go back with `host.answer`. A call's result enters the
 * run's history only through the tool result that used it.
 */
import { type Duration, Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

import {
  FileLocationSchema,
  LaunchNoticeSchema,
  RequestShowErrorPayloadSchema,
  type OpenFilePayload,
} from '@texra-ai/harness/schemas';
import { RpcClientMessageSchema } from '@texra/shared/rpcOverMessages';
import { ManualCriticismEntrySchema } from '@texra/tools/editorHost';
import { GenericDiagnosticSchema } from '@texra/utils/diagnostics/diagnosticFormatting';

/** The runtime's notices, by event, as a window presents them: the two a
 *  refused launch carries among them. */
const NoticeSchema = Schema.Union([
  Schema.Struct({
    event: Schema.Literal('openFile'),
    payload: Schema.Struct({
      location: FileLocationSchema,
      preserveFocus: Schema.Boolean,
    }) satisfies Schema.Codec<OpenFilePayload, unknown>,
  }),
  ...LaunchNoticeSchema.members,
  Schema.Struct({
    event: Schema.Literal('requestShowError'),
    payload: RequestShowErrorPayloadSchema,
  }),
]);
export type Notice = typeof NoticeSchema.Type;

/** Why a window could not carry out a call, in the window's words; the
 *  service reports it as the capability's own failure. */
export class HostCallFailed extends Schema.TaggedError<HostCallFailed>()(
  'HostCallFailed',
  { message: Schema.String },
) {}

/**
 * The calls a window serves its project's tasks, one procedure per
 * capability. A run waits on the first three, each for as long as
 * {@link ASKED_WITHIN} says; `notices` and `filesWritten` are told: the
 * service waits only until the window has them, and the window says itself
 * when it could not carry one out.
 */
export const WindowRpcs = RpcGroup.make(
  Rpc.make('readDiagnostics', {
    payload: { path: Schema.String },
    success: Schema.Array(GenericDiagnosticSchema),
    error: HostCallFailed,
  }),
  Rpc.make('addCriticism', {
    payload: { entry: ManualCriticismEntrySchema },
    success: Schema.Boolean,
    error: HostCallFailed,
  }),
  Rpc.make('openPdf', {
    payload: { location: FileLocationSchema, preserveFocus: Schema.Boolean },
    error: HostCallFailed,
  }),
  // The runtime's notices and its approval-policy denials, which a window
  // with `emit` presents.
  Rpc.make('notices', { payload: { notice: NoticeSchema } }),
  // Files a task of the project wrote past the editor's own write path, as
  // the service's announcer heard them from the task's rows.
  Rpc.make('filesWritten', {
    payload: { absolutePaths: Schema.Array(Schema.String) },
  }),
);

/** What a window can do for a run: each capability is the procedure a
 *  window offers to be called with. */
export const HostCapabilitySchema = Schema.Literals([
  'readDiagnostics',
  'addCriticism',
  'openPdf',
  'notices',
  'filesWritten',
] satisfies ReadonlyArray<RpcGroup.Rpcs<typeof WindowRpcs>['_tag']>);
export type HostCapability = typeof HostCapabilitySchema.Type;

/** How long a run waits for each call it waits on. A diagnostics read may
 *  build the document first, so it waits longest. */
export const ASKED_WITHIN = Object.freeze({
  readDiagnostics: '2 minutes',
  addCriticism: '10 seconds',
  openPdf: '30 seconds',
} as const satisfies Partial<Record<HostCapability, Duration.Input>>);

/** A frame of `host.attach`: the attachment's id first, then the service's
 *  calls on the window, each one of `rpc`'s messages to the window's
 *  `WindowRpcs` server. */
export const HostAttachFrameSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('attached'),
    attachment: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('call'),
    message: RpcClientMessageSchema,
  }),
]);
export type HostAttachFrame = typeof HostAttachFrameSchema.Type;
