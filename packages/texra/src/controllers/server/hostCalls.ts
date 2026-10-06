/**
 * What the service asks of a window: the host capabilities a run uses while
 * it runs in the service (a file's diagnostics, an inline criticism, a PDF
 * to open, a tool edit's preview to stage, a notice to show). A window
 * offers the capabilities it has when it attaches (`host.attach`); each call
 * reaches it as a frame of that stream, and it answers with `host.answer`.
 * A call's result enters the run's history only through the tool result
 * that used it.
 */
import { z } from 'zod';

import type { ManualCriticismEntry } from '@agent/runtime/HostInteractions';
import type { ApprovalPolicyDenial } from '@shared/approvalPolicy';
import {
  FileLocationSchema,
  INSTRUCTION_ACTION,
  RunIdSchema,
  ToolEditPermissionSchema,
  type RequestEnsureProgressViewPayload,
  type RequestOpenFilePayload,
  type RequestShowErrorPayload,
  type RequestShowInstructionPayload,
  type ShowAgentConfigBannerPayload,
} from '@shared/schemas';
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';

/** What a window can do for a run. `notices` covers the runtime's notices
 *  and its approval-policy denials. */
const HOST_CAPABILITIES = [
  'readDiagnostics',
  'addCriticism',
  'openPdf',
  'toolEdits',
  'notices',
] as const;
export const HostCapabilitySchema = z.enum(HOST_CAPABILITIES);
export type HostCapability = z.infer<typeof HostCapabilitySchema>;

const position = z.object({ line: z.int(), character: z.int() });
const GenericDiagnosticSchema = z.object({
  severity: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  message: z.string(),
  range: z.object({ start: position, end: position }),
}) satisfies z.ZodType<GenericDiagnostic>;

const ManualCriticismEntrySchema = z.object({
  absolutePath: z.string(),
  line: z.int(),
  message: z.string(),
  severity: z.int(),
  confidence: z.int(),
}) satisfies z.ZodType<ManualCriticismEntry>;

const ApprovalPolicyDenialSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('executable') }),
  z.object({ kind: z.literal('plan') }),
  z.object({ kind: z.literal('proposal') }),
  z.object({
    kind: z.literal('withheldTools'),
    tools: z.array(z.string()).readonly(),
  }),
  z.object({
    kind: z.literal('retry'),
    deny: z.enum(['yolo-retry', 'credential', 'policy', 'unpresentable']),
  }),
  z.object({
    kind: z.literal('humanInput'),
    deny: z.enum(['yolo-no-human', 'policy', 'unpresentable']),
  }),
]) satisfies z.ZodType<ApprovalPolicyDenial>;

/** The runtime's notices, by event, as a window presents them. */
const NoticeSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('requestOpenFile'),
    payload: z.object({
      location: FileLocationSchema,
      preserveFocus: z.boolean(),
    }) satisfies z.ZodType<RequestOpenFilePayload>,
  }),
  z.object({
    event: z.literal('requestShowInstruction'),
    payload: z.object({
      key: z.string(),
      message: z.string(),
      actions: z.array(z.enum(Object.values(INSTRUCTION_ACTION))).optional(),
      showSuppress: z.boolean().optional(),
    }) satisfies z.ZodType<RequestShowInstructionPayload>,
  }),
  z.object({
    event: z.literal('showAgentConfigBanner'),
    payload: z.object({
      agentName: z.string(),
    }) satisfies z.ZodType<ShowAgentConfigBannerPayload>,
  }),
  z.object({
    event: z.literal('requestShowError'),
    payload: z.object({
      message: z.string(),
      docsCommand: z.string().optional(),
    }) satisfies z.ZodType<RequestShowErrorPayload>,
  }),
  z.object({
    event: z.literal('requestEnsureProgressView'),
    payload: z.object({
      fallbackNotification: z
        .object({
          agentName: z.string(),
          modelName: z.string(),
          inputName: z.string(),
          outputInfo: z.string(),
        })
        .optional(),
    }) satisfies z.ZodType<RequestEnsureProgressViewPayload>,
  }),
  z.object({
    event: z.literal('workspaceFilesWritten'),
    payload: z.object({ absolutePaths: z.array(z.string()) }),
  }),
]);
export type Notice = z.infer<typeof NoticeSchema>;

/** A tool edit's preview as a window stages it: the request without the
 *  service's workspace roots, which the window supplies itself. */
const ToolEditStagingSchema = z.object({
  path: z.string(),
  originalContent: z.string(),
  proposedContent: z.string(),
  sourceTool: z.string(),
  runId: RunIdSchema.nullable(),
  permission: ToolEditPermissionSchema,
});
export type ToolEditStaging = z.infer<typeof ToolEditStagingSchema>;

/** One call of the service on a window. */
const HostCallSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('readDiagnostics'), path: z.string() }),
  z.object({
    kind: z.literal('addCriticism'),
    entry: ManualCriticismEntrySchema,
  }),
  z.object({
    kind: z.literal('openPdf'),
    location: FileLocationSchema,
    preserveFocus: z.boolean(),
  }),
  z.object({
    kind: z.literal('presentToolEdit'),
    request: ToolEditStagingSchema,
  }),
  z.object({ kind: z.literal('releaseToolEdit'), requestId: z.string() }),
  z.object({ kind: z.literal('approveToolEdit'), requestId: z.string() }),
  z.object({ kind: z.literal('notice'), notice: NoticeSchema }),
  z.object({
    kind: z.literal('approvalDenied'),
    denial: ApprovalPolicyDenialSchema,
    runId: RunIdSchema,
  }),
]);
export type HostCall = z.infer<typeof HostCallSchema>;

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
  approvalDenied: 'notices',
};

/** What each call answers with, when it answers with a value. */
export const CallResultSchemas = {
  readDiagnostics: z.array(GenericDiagnosticSchema),
  addCriticism: z.boolean(),
  approveToolEdit: z.boolean(),
} as const;

/** A frame of `host.attach`: the attachment's id first, then the calls. */
export const HostFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('attached'), attachment: z.string() }),
  z.object({ kind: z.literal('call'), id: z.string(), call: HostCallSchema }),
]);
export type HostFrame = z.infer<typeof HostFrameSchema>;

/** A window's answer to one call. A failure says why in the window's
 *  words; the service reports it as the capability's own failure. */
export const HostAnswerSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.json() }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
export type HostAnswer = z.infer<typeof HostAnswerSchema>;
