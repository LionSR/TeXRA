/**
 * What the service asks of a window: the host capabilities a run uses while
 * it runs in the service (a file's diagnostics, an inline criticism, a PDF
 * to open, a tool edit's preview to stage, a notice to show, the editor's
 * language models). A window
 * offers the capabilities it has when it attaches (`host.attach`); each call
 * reaches it as a frame of that stream, and it answers with `host.answer`.
 * A call's result enters the run's history only through the tool result
 * that used it.
 */
import { Schema, Struct } from 'effect';

import {
  ModelErrorFieldsSchema,
  ResolvedTurnSchema,
  TurnEventSchema,
  TurnRequestSchema,
  VscodeLanguageModelConfigurationSchema,
} from '@texra-ai/llm';

import {
  ApprovalPolicySchema,
  ToolEditContentSchema,
  type ApprovalPolicyDenial,
  FileLocationSchema,
  INSTRUCTION_ACTION,
  RunIdSchema,
  ToolEditPermissionSchema,
  type RequestEnsureProgressViewPayload,
  type RequestOpenFilePayload,
  type RequestShowErrorPayload,
  type RequestShowInstructionPayload,
  type ShowAgentConfigBannerPayload,
} from '@texra-ai/harness/schemas';
import type { ManualCriticismEntry } from '@texra/tools/editorHost';
import type { GenericDiagnostic } from '@texra/utils/diagnostics/diagnosticFormatting';
import type { LanguageModelInfo } from '@texra-ai/harness';

/** What a window can do for a run. `notices` covers the runtime's notices
 *  and its approval-policy denials. */
const HOST_CAPABILITIES = [
  'readDiagnostics',
  'addCriticism',
  'openPdf',
  'toolEdits',
  'notices',
  'languageModel',
] as const;
export const HostCapabilitySchema = Schema.Enum(HOST_CAPABILITIES);
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
}) satisfies Schema.Codec<GenericDiagnostic>;

const ManualCriticismEntrySchema = Schema.Struct({
  absolutePath: Schema.String,
  line: Schema.Int,
  message: Schema.String,
  severity: Schema.Int,
  confidence: Schema.Int,
}) satisfies Schema.Codec<ManualCriticismEntry>;

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
]) satisfies Schema.Codec<ApprovalPolicyDenial>;

/** The runtime's notices, by event, as a window presents them. */
const NoticeSchema = Schema.Union([
  Schema.Struct({
    event: Schema.Literal('requestOpenFile'),
    payload: Schema.Struct({
      location: FileLocationSchema,
      preserveFocus: Schema.Boolean,
    }) satisfies Schema.Codec<RequestOpenFilePayload>,
  }),
  Schema.Struct({
    event: Schema.Literal('requestShowInstruction'),
    payload: Schema.Struct({
      key: Schema.String,
      message: Schema.String,
      actions: Schema.optional(
        Schema.Array(Schema.Enum(Object.values(INSTRUCTION_ACTION))),
      ),
      showSuppress: Schema.optional(Schema.Boolean),
    }) satisfies Schema.Codec<RequestShowInstructionPayload>,
  }),
  Schema.Struct({
    event: Schema.Literal('showAgentConfigBanner'),
    payload: Schema.Struct({
      agentName: Schema.String,
    }) satisfies Schema.Codec<ShowAgentConfigBannerPayload>,
  }),
  Schema.Struct({
    event: Schema.Literal('requestShowError'),
    payload: Schema.Struct({
      message: Schema.String,
      docsPage: Schema.optional(Schema.String),
    }) satisfies Schema.Codec<RequestShowErrorPayload>,
  }),
  Schema.Struct({
    event: Schema.Literal('requestEnsureProgressView'),
    payload: Schema.Struct({
      fallbackNotification: Schema.optional(
        Schema.Struct({
          agentName: Schema.String,
          modelName: Schema.String,
          inputName: Schema.String,
          outputInfo: Schema.String,
        }),
      ),
    }) satisfies Schema.Codec<RequestEnsureProgressViewPayload>,
  }),
]);
export type Notice = typeof NoticeSchema.Type;

/** A tool edit's preview as a window stages it: the request without the
 *  service's workspace roots, which the window supplies itself. */
const ToolEditStagingSchema = ToolEditContentSchema.mapFields(
  Struct.assign({
    path: Schema.String,
    sourceTool: Schema.String,
    runId: Schema.NullOr(RunIdSchema),
    permission: ToolEditPermissionSchema,
  }),
);

const LanguageModelInfoSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.String,
  vendor: Schema.String,
  version: Schema.String,
  maxInputTokens: Schema.Number,
  access: Schema.Literals(['allowed', 'consent-required', 'unavailable']),
}) satisfies Schema.Codec<LanguageModelInfo>;

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
  Schema.Struct({
    kind: Schema.Literal('presentToolEdit'),
    request: ToolEditStagingSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('releaseToolEdit'),
    requestId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('approveToolEdit'),
    requestId: Schema.String,
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
  // The editor's language models: list them, prepare a turn, and stream
  // one (answered item by item, `more`), which `cancel` stops.
  Schema.Struct({
    kind: Schema.Literal('lmModels'),
    vendor: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('lmPrepare'),
    configuration: VscodeLanguageModelConfigurationSchema,
    request: TurnRequestSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('lmStream'),
    configuration: VscodeLanguageModelConfigurationSchema,
    turn: ResolvedTurnSchema,
  }),
  Schema.Struct({ kind: Schema.Literal('cancel'), call: Schema.String }),
]);
export type HostCall = typeof HostCallSchema.Type;

/** The capability each call needs of the window it goes to. */
export const CALL_CAPABILITY: Readonly<
  Record<HostCall['kind'], HostCapability>
> = {
  readDiagnostics: 'readDiagnostics',
  addCriticism: 'addCriticism',
  openPdf: 'openPdf',
  presentToolEdit: 'toolEdits',
  releaseToolEdit: 'toolEdits',
  approveToolEdit: 'toolEdits',
  notice: 'notices',
  filesWritten: 'notices',
  approvalDenied: 'notices',
  lmModels: 'languageModel',
  lmPrepare: 'languageModel',
  lmStream: 'languageModel',
  cancel: 'languageModel',
};

/** What each call answers with, when it answers with a value. */
export const CallResultSchemas = {
  readDiagnostics: Schema.Array(GenericDiagnosticSchema),
  addCriticism: Schema.Boolean,
  approveToolEdit: Schema.Boolean,
  lmModels: Schema.Array(LanguageModelInfoSchema),
  lmPrepare: ResolvedTurnSchema,
  /** Each item of a streamed `lmStream`. */
  lmStream: TurnEventSchema,
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
 *  words (a model's failure as its fields, rebuilt in the service); the
 *  service reports it as the capability's own failure. A streamed call
 *  answers each item with `more`, then once without. */
export const HostAnswerSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Json,
    more: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    message: Schema.String,
    model: Schema.optional(ModelErrorFieldsSchema),
  }),
]);
export type HostAnswer = typeof HostAnswerSchema.Type;
