/**
 * What the service asks of a window: the host capabilities a run uses while
 * it runs in the service (a file's diagnostics, an inline criticism, a PDF
 * to open, a notice to show). A window
 * offers the capabilities it has when it attaches (`host.attach`); each call
 * reaches it as a frame of that stream, and it answers with `host.answer`.
 * A call's result enters the run's history only through the tool result
 * that used it.
 */
import { type Duration, Schema } from 'effect';

import {
  ApprovalPolicySchema,
  FileLocationSchema,
  LaunchNoticeSchema,
  RequestShowErrorPayloadSchema,
  RunIdSchema,
  type OpenFilePayload,
} from '@texra-ai/harness/schemas';
import type { ManualCriticismEntry } from '@texra/tools/editorHost';
import type { GenericDiagnostic } from '@texra/utils/diagnostics/diagnosticFormatting';

const position = Schema.Struct({ line: Schema.Int, character: Schema.Int });
const GenericDiagnosticSchema = Schema.Struct({
  severity: Schema.Union([
    Schema.Literal(0),
    Schema.Literal(1),
    Schema.Literal(2),
    Schema.Literal(3),
  ]),
  message: Schema.String,
  range: Schema.Struct({ start: position, end: position }),
}) satisfies Schema.Codec<GenericDiagnostic, unknown>;

const ManualCriticismEntrySchema = Schema.Struct({
  absolutePath: Schema.String,
  line: Schema.Int,
  message: Schema.String,
  severity: Schema.Int,
  confidence: Schema.Int,
}) satisfies Schema.Codec<ManualCriticismEntry, unknown>;

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

/** One call of the service on a window, by kind. */
const HostCallSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('readDiagnostics'),
    path: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('addCriticism'),
    entry: ManualCriticismEntrySchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('openPdf'),
    location: FileLocationSchema,
    preserveFocus: Schema.Boolean,
  }),
  // The runtime's notices and its approval-policy denials, which a window
  // with `emit` presents.
  Schema.Struct({ kind: Schema.Literal('notices'), notice: NoticeSchema }),
  // Files a task of the project wrote past the editor's own write path, as
  // the service's announcer heard them from the task's rows.
  Schema.Struct({
    kind: Schema.Literal('filesWritten'),
    absolutePaths: Schema.Array(Schema.String),
  }),
]);
export type HostCall = typeof HostCallSchema.Type;

/** What a window can do for a run: each kind of call is the capability a
 *  window offers to be sent it. */
export const HostCapabilitySchema = Schema.Literals(
  HostCallSchema.members.map((member) => member.fields.kind.literal),
);
export type HostCapability = HostCall['kind'];

/** The calls a run waits on: what each answers with, and how long a run
 *  waits for it. A diagnostics read may build the document first, so it
 *  waits longest. Every other call is told and not answered. */
export const ANSWERED = {
  readDiagnostics: {
    result: Schema.Array(GenericDiagnosticSchema),
    within: '2 minutes',
  },
  addCriticism: { result: Schema.Boolean, within: '10 seconds' },
  openPdf: { result: Schema.Null, within: '30 seconds' },
} as const satisfies Partial<
  Record<
    HostCall['kind'],
    {
      readonly result: Schema.Codec<unknown, unknown>;
      readonly within: Duration.Input;
    }
  >
>;

/** A frame of `host.attach`: the attachment's id first, then the calls. */
export const HostAttachFrameSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('attached'),
    attachment: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('call'),
    id: Schema.String,
    call: HostCallSchema,
    /** Whether a run waits for the answer: a notice or a file notification
     *  is told and not answered. */
    awaited: Schema.Boolean,
  }),
]);
export type HostAttachFrame = typeof HostAttachFrameSchema.Type;

/** A window's answer to one call. A failure says why in the window's
 *  words; the service reports it as the capability's own failure. */
export const HostAnswerSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Json,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    message: Schema.String,
  }),
]);
export type HostAnswer = typeof HostAnswerSchema.Type;
