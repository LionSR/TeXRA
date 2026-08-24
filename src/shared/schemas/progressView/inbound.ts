/**
 * ProgressView inbound message schemas (frontend -> backend): SWITCH_STREAM,
 * SEND_FOLLOW_UP, approval actions, file diff actions, and the discriminated
 * union + dispatcher they compose into.
 */
import { z } from 'zod';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

import {
  SwitchViewMessageSchema,
  ThemeSchema,
  WebviewReadyMessageSchema,
} from '../commonViewMessages';
import { commandOnly } from '../messageFactories';
import {
  ExternalInquiryThreadIdSchema,
  InquiryDraftSchema,
  InquiryDropActionSchema,
  InquirySubmitActionSchema,
} from '../inquiry';
import { AgentProposalSchema, UserQuestionAnswersSchema } from '../prompts';
import { StreamScopedBaseSchema } from './data';
import { GettingStartedActionSchema } from '../mainView/state';
import { ExhaustionReasonSchema } from '../errors';
import {
  FollowUpImageSchema,
  MAX_FOLLOW_UP_ID_LENGTH,
  MAX_FOLLOW_UP_IMAGE_BASE64_BYTES,
  MAX_FOLLOW_UP_IMAGES,
  MAX_FOLLOW_UP_PAYLOAD_BYTES,
  MAX_FOLLOW_UP_TEXT_LENGTH,
  serializedFollowUpPayloadBytes,
} from './followUpPolicy';
import type { ProgressViewOutboundMessage } from './outbound';

const TrimmedStringSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1));

/** StreamScopedBaseSchema plus a `command` literal, with no extra fields. */
function streamScopedCommand<T extends string>(command: T) {
  return StreamScopedBaseSchema.extend({ command: z.literal(command) });
}

/** File action carrying the output file and an optional diff base. */
function fileWithBaseCommand<T extends string>(command: T) {
  return z.object({
    command: z.literal(command),
    file: z.string().min(1),
    base: z.string().min(1).optional(),
  });
}

const ThemeSetMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.THEME_SET),
  theme: ThemeSchema,
});

const DebugModeSetMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DEBUG_MODE_SET),
  debugMode: z.boolean(),
});

const FollowupConfigSchema = StreamScopedBaseSchema.extend({
  agent: TrimmedStringSchema,
  model: TrimmedStringSchema,
  initialQuestion: z.string().optional(),
});

const SetupFollowupMessageSchema = FollowupConfigSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP),
});

const RunFollowupMessageSchema = FollowupConfigSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP),
});

const UseOwnApiKeyMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY),
  requestId: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  exhaustionReason: ExhaustionReasonSchema.optional(),
  /** True when the failing request went through the TeXRA relay. When
   *  false, relay wasn't in the path (direct-key call) and the handler
   *  must not globally disable relay access — other providers may still
   *  be served successfully by relay. */
  viaRelay: z.boolean().optional(),
});

/** Set-on (idempotent) delegated-work approval. */
const EnableDelegatedWorkApprovalMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.ENABLE_SUPER_YOLO_BYPASS),
  /**
   * The proposal whose ordinary approval message follows this command. It is
   * excluded from the pending-request sweep because that message may carry
   * model or agent overrides.
   */
  initiatingProposalId: z.string().min(1),
});

/**
 * Set-on (idempotent) bypass enable, distinct from the shield's toggle: the
 * inline "approve always" prompt button means "enable", never "flip".
 */
const EnableApprovalBypassMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS),
  /**
   * Prompt that granted the bypass. A grant is per-kind: approving always from
   * an edit prompt leaves shell commands gated and vice versa.
   */
  kind: z.enum([PERMISSION_KIND.TOOL_EDIT, PERMISSION_KIND.BASH]),
});

const SendFollowUpMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP),
  stream: z.string().min(1).max(MAX_FOLLOW_UP_ID_LENGTH),
  text: TrimmedStringSchema.pipe(z.string().max(MAX_FOLLOW_UP_TEXT_LENGTH)),
  deliveryId: z.string().min(1).max(MAX_FOLLOW_UP_ID_LENGTH),
  /** Pasted images (base64) to attach to this follow-up turn. */
  images: z.array(FollowUpImageSchema).max(MAX_FOLLOW_UP_IMAGES).optional(),
}).refine(
  (message) =>
    serializedFollowUpPayloadBytes(message) <= MAX_FOLLOW_UP_PAYLOAD_BYTES,
  { message: 'Follow-up payload exceeds the 4 MiB limit.' },
);

const FollowUpSubmissionIdentitySchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP),
  stream: z.string().min(1).max(MAX_FOLLOW_UP_ID_LENGTH),
  deliveryId: z.string().min(1).max(MAX_FOLLOW_UP_ID_LENGTH),
});

export type RejectedFollowUpSubmissionResult = Extract<
  ProgressViewOutboundMessage,
  {
    command: typeof PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT;
    accepted: false;
  }
>;

function rejectedFollowUp(
  identity: z.infer<typeof FollowUpSubmissionIdentitySchema>,
  error: string,
): RejectedFollowUpSubmissionResult {
  return {
    command: PROGRESS_VIEW_COMMANDS.FOLLOW_UP_SUBMISSION_RESULT,
    stream: identity.stream,
    deliveryId: identity.deliveryId,
    accepted: false,
    error,
  };
}

/** Build a safe retryable rejection for an invalid renderer submission. */
export function rejectedInvalidFollowUpSubmission(
  message: unknown,
): RejectedFollowUpSubmissionResult | undefined {
  const identity = FollowUpSubmissionIdentitySchema.safeParse(message);
  if (
    !identity.success ||
    SendFollowUpMessageSchema.safeParse(message).success
  ) {
    return undefined;
  }
  const candidate = message as Record<string, unknown>;
  if (typeof candidate.text === 'string' && !candidate.text.trim()) {
    return rejectedFollowUp(identity.data, 'Enter a message before sending.');
  }
  if (typeof candidate.text !== 'string') {
    return rejectedFollowUp(
      identity.data,
      'The message details are invalid. Refresh the run and try again.',
    );
  }
  if (candidate.text.length > MAX_FOLLOW_UP_TEXT_LENGTH) {
    return rejectedFollowUp(
      identity.data,
      'The message is too long. Shorten it and try again.',
    );
  }
  if (Array.isArray(candidate.images)) {
    const exceedsAttachmentLimits =
      candidate.images.length > MAX_FOLLOW_UP_IMAGES ||
      candidate.images.some(
        (image) =>
          typeof image === 'object' &&
          image !== null &&
          typeof (image as Record<string, unknown>).base64 === 'string' &&
          ((image as Record<string, unknown>).base64 as string).length >
            MAX_FOLLOW_UP_IMAGE_BASE64_BYTES,
      ) ||
      serializedFollowUpPayloadBytes(message) > MAX_FOLLOW_UP_PAYLOAD_BYTES;
    if (exceedsAttachmentLimits) {
      return rejectedFollowUp(
        identity.data,
        'Attachment limits are 8 images, 3 MiB per image, and 4 MiB total. Remove an image and try again.',
      );
    }
    if (!z.array(FollowUpImageSchema).safeParse(candidate.images).success) {
      return rejectedFollowUp(
        identity.data,
        'One or more images are invalid. Remove and paste them again, then try again.',
      );
    }
  }
  return rejectedFollowUp(
    identity.data,
    'The message details are invalid. Refresh the run and try again.',
  );
}

const PolishFollowUpMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP),
  text: TrimmedStringSchema,
});

const RetryStreamRequestMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST),
  requestId: z.string(),
  feedback: z.string().optional(),
});

const CancelRetryRequestMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST),
  requestId: z.string(),
});

const ShowInformationMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE),
  text: TrimmedStringSchema,
});

const ToolEditActionMessageBase = {
  command: z.literal(PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION),
  requestId: z.string().min(1),
};
const ToolEditApprovalActionMessageSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...ToolEditActionMessageBase,
    action: z.enum(['approve', 'openDiff', 'showLatexdiff', 'previewProposed']),
  }),
  z.strictObject({
    ...ToolEditActionMessageBase,
    action: z.literal('reject'),
    feedback: z.string().optional(),
  }),
]);

const BashActionMessageBase = {
  command: z.literal(PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION),
  requestId: z.string().min(1),
};
const BashApprovalActionMessageSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...BashActionMessageBase,
    action: z.literal('approve'),
  }),
  z.strictObject({
    ...BashActionMessageBase,
    action: z.literal('reject'),
    feedback: z.string().optional(),
  }),
]);

const ProposalActionMessageBase = {
  command: z.literal(PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION),
  proposalId: z.string().min(1),
};
const AgentProposalActionMessageSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...ProposalActionMessageBase,
    action: z.literal('approve'),
    model: z.string().optional(),
    agent: z.string().optional(),
  }),
  z.strictObject({
    ...ProposalActionMessageBase,
    action: z.literal('reject'),
    feedback: z.string().optional(),
  }),
  z.strictObject({
    ...ProposalActionMessageBase,
    action: z.literal('setup'),
  }),
]);
export type ProgressAgentProposalActionMessage = z.infer<
  typeof AgentProposalActionMessageSchema
>;

const PlanActionMessageBase = {
  command: z.literal(PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION),
  approvalId: z.string().min(1),
};
const PlanApprovalActionMessageSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...PlanActionMessageBase,
    action: z.enum(['approve', 'approve_and_goal']),
  }),
  z.strictObject({
    ...PlanActionMessageBase,
    action: z.literal('reject'),
    feedback: z.string().optional(),
  }),
]);

const ExternalInquiryActionMessageSchema = z.discriminatedUnion('action', [
  InquirySubmitActionSchema.extend({
    command: z.literal(PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION),
  }),
  InquiryDropActionSchema.extend({
    command: z.literal(PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION),
  }),
  z.object({
    command: z.literal(PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION),
    action: z.literal('draft'),
    threadId: ExternalInquiryThreadIdSchema,
    draft: InquiryDraftSchema.nullable(),
  }),
]);

const UserQuestionActionMessageBase = {
  command: z.literal(PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION),
  requestId: z.string().min(1),
};

const UserQuestionActionMessageSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...UserQuestionActionMessageBase,
    action: z.literal('submit'),
    answers: UserQuestionAnswersSchema,
  }),
  z.strictObject({
    ...UserQuestionActionMessageBase,
    action: z.literal('reject'),
    feedback: z.string().optional(),
  }),
  z.strictObject({
    ...UserQuestionActionMessageBase,
    action: z.literal('skip'),
    feedback: z.string().optional(),
  }),
]);

const RestoreProposalConfigMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESTORE_PROPOSAL_CONFIG),
  proposal: AgentProposalSchema,
});

const OpenFileMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_FILE),
  file: z.string().min(1),
  line: z.int().nonnegative().optional(),
});

const OpenFileCompileMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE),
  file: z.string().min(1),
});

const ComparePreviousMessageSchema = fileWithBaseCommand(
  PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS,
).extend({
  prev: z.string().min(1).optional(),
});

const OpenLabelMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_LABEL),
  label: z.string().min(1),
});

const GettingStartedActionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.GETTING_STARTED_ACTION),
  action: GettingStartedActionSchema,
});

export const ProgressViewInboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    WebviewReadyMessageSchema,
    SwitchViewMessageSchema,
    ThemeSetMessageSchema,
    DebugModeSetMessageSchema,
    streamScopedCommand(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM),
    streamScopedCommand(PROGRESS_VIEW_COMMANDS.DELETE_STREAM),
    commandOnly(PROGRESS_VIEW_COMMANDS.DELETE_ALL),
    streamScopedCommand(PROGRESS_VIEW_COMMANDS.STOP_STREAM),
    streamScopedCommand(PROGRESS_VIEW_COMMANDS.COMPACT_RESPONSE),
    streamScopedCommand(PROGRESS_VIEW_COMMANDS.RESUME),
    streamScopedCommand(PROGRESS_VIEW_COMMANDS.RUN_NEW),
    streamScopedCommand(PROGRESS_VIEW_COMMANDS.DIFF_STREAM),
    streamScopedCommand(PROGRESS_VIEW_COMMANDS.PACK_STREAM),
    streamScopedCommand(PROGRESS_VIEW_COMMANDS.CLEAN_STREAM),
    streamScopedCommand(PROGRESS_VIEW_COMMANDS.RESTORE_STATE),
    streamScopedCommand(PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE),
    streamScopedCommand(PROGRESS_VIEW_COMMANDS.RUN_COMPILE_FIXER),
    SendFollowUpMessageSchema,
    PolishFollowUpMessageSchema,
    RetryStreamRequestMessageSchema,
    CancelRetryRequestMessageSchema,
    UseOwnApiKeyMessageSchema,
    commandOnly(PROGRESS_VIEW_COMMANDS.START_RECORDING),
    commandOnly(PROGRESS_VIEW_COMMANDS.STOP_RECORDING),
    commandOnly(PROGRESS_VIEW_COMMANDS.POP_OUT),
    commandOnly(PROGRESS_VIEW_COMMANDS.POP_BACK),
    ToolEditApprovalActionMessageSchema,
    streamScopedCommand(
      PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS,
    ),
    streamScopedCommand(PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS),
    EnableDelegatedWorkApprovalMessageSchema,
    EnableApprovalBypassMessageSchema,
    BashApprovalActionMessageSchema,
    AgentProposalActionMessageSchema,
    PlanApprovalActionMessageSchema,
    ExternalInquiryActionMessageSchema,
    UserQuestionActionMessageSchema,
    RestoreProposalConfigMessageSchema,
    ShowInformationMessageSchema,
    commandOnly(PROGRESS_VIEW_COMMANDS.OPEN_PROFILE),
    commandOnly(PROGRESS_VIEW_COMMANDS.OPEN_MEMORY_VIEW),
    OpenFileMessageSchema,
    OpenFileCompileMessageSchema,
    fileWithBaseCommand(PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL),
    ComparePreviousMessageSchema,
    fileWithBaseCommand(PROGRESS_VIEW_COMMANDS.ACCEPT_FILE),
    fileWithBaseCommand(PROGRESS_VIEW_COMMANDS.MERGE_FILE),
    fileWithBaseCommand(PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE),
    OpenLabelMessageSchema,
    streamScopedCommand(PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS),
    SetupFollowupMessageSchema,
    RunFollowupMessageSchema,
    GettingStartedActionMessageSchema,
  ],
);

export type ProgressViewInboundMessage = z.infer<
  typeof ProgressViewInboundMessageSchema
>;

export type ProgressViewInboundHandlerRegistry =
  HandlerRegistry<ProgressViewInboundMessage>;

export const dispatchProgressViewInbound = createDispatcher(
  ProgressViewInboundMessageSchema,
);
