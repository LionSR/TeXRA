/**
 * What the service asks of a window: the host capabilities a run uses while
 * it runs in the service (a file's diagnostics, an inline criticism, a PDF
 * to open, a notice to show). A window
 * offers the capabilities it has when it attaches (`host.attach`); each call
 * reaches it as a frame of that stream, and it answers with `host.answer`.
 * A call's result enters the run's history only through the tool result
 * that used it.
 */
import { Schema } from 'effect';

import {
  ApprovalPolicySchema,
  type ApprovalPolicyDenial,
  FileLocationSchema,
  RunIdSchema,
  type AgentNotFoundPayload,
  type OpenFilePayload,
  type RequestShowErrorPayload,
  type RequestShowInstructionPayload,
} from '@texra-ai/harness/schemas';
import type { ManualCriticismEntry } from '@texra/tools/editorHost';
import type { GenericDiagnostic } from '@texra/utils/diagnostics/diagnosticFormatting';

/** What a window can do for a run. `notices` covers the runtime's notices
 *  and its approval-policy denials. */
const HOST_CAPABILITIES = [
  'readDiagnostics',
  'addCriticism',
  'openPdf',
  'notices',
] as const;
export const HostCapabilitySchema = Schema.Literals(HOST_CAPABILITIES);
export type HostCapability = typeof HostCapabilitySchema.Type;

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

/** The policy that closed a gate, as the window names it. */
const policy = ApprovalPolicySchema;
const ApprovalPolicyDenialSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('executable'), policy }),
  Schema.Struct({ kind: Schema.Literal('plan'), policy }),
  Schema.Struct({ kind: Schema.Literal('proposal'), policy }),
  Schema.Struct({
    kind: Schema.Literal('withheldTools'),
    tools: Schema.Array(Schema.String),
    policy,
  }),
  Schema.Struct({
    kind: Schema.Literal('retry'),
    deny: Schema.Literals([
      'yolo-retry',
      'credential',
      'policy',
      'unpresentable',
    ]),
    policy,
  }),
  Schema.Struct({
    kind: Schema.Literal('humanInput'),
    deny: Schema.Literals(['yolo-no-human', 'policy', 'unpresentable']),
    policy,
  }),
]) satisfies Schema.Codec<ApprovalPolicyDenial, unknown>;

/** The runtime's notices, by event, as a window presents them. */
const NoticeSchema = Schema.Union([
  Schema.Struct({
    event: Schema.Literal('openFile'),
    payload: Schema.Struct({
      location: FileLocationSchema,
      preserveFocus: Schema.Boolean,
    }) satisfies Schema.Codec<OpenFilePayload, unknown>,
  }),
  Schema.Struct({
    event: Schema.Literal('requestShowInstruction'),
    payload: Schema.Struct({
      key: Schema.String,
      message: Schema.String,
      showSuppress: Schema.optional(Schema.Boolean),
    }) satisfies Schema.Codec<RequestShowInstructionPayload, unknown>,
  }),
  Schema.Struct({
    event: Schema.Literal('agentNotFound'),
    payload: Schema.Struct({
      agentName: Schema.String,
    }) satisfies Schema.Codec<AgentNotFoundPayload, unknown>,
  }),
  Schema.Struct({
    event: Schema.Literal('requestShowError'),
    payload: Schema.Struct({
      message: Schema.String,
      docsPage: Schema.optional(Schema.String),
    }) satisfies Schema.Codec<RequestShowErrorPayload, unknown>,
  }),
]);
export type Notice = typeof NoticeSchema.Type;

/** One call of the service on a window. */
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
  Schema.Struct({ kind: Schema.Literal('notice'), notice: NoticeSchema }),
  // Files a task of the project wrote past the editor's own write path, as
  // the service's announcer heard them from the task's rows.
  Schema.Struct({
    kind: Schema.Literal('filesWritten'),
    absolutePaths: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('approvalDenied'),
    denial: ApprovalPolicyDenialSchema,
    runId: RunIdSchema,
  }),
]);
export type HostCall = typeof HostCallSchema.Type;

/** The capability each call needs of the window it goes to. */
export const CALL_CAPABILITY: Readonly<
  Record<HostCall['kind'], HostCapability>
> = {
  readDiagnostics: 'readDiagnostics',
  addCriticism: 'addCriticism',
  openPdf: 'openPdf',
  notice: 'notices',
  filesWritten: 'notices',
  approvalDenied: 'notices',
};

/** What each call answers with, when it answers with a value. */
export const CallResultSchemas = {
  readDiagnostics: Schema.Array(GenericDiagnosticSchema),
  addCriticism: Schema.Boolean,
} as const;

/** A frame of `host.attach`: the attachment's id first, then the calls. */
export const HostFrameSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('attached'),
    attachment: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('call'),
    id: Schema.String,
    call: HostCallSchema,
  }),
]);
export type HostFrame = typeof HostFrameSchema.Type;

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
