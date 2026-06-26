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

import { SwitchViewMessageSchema } from '../commonViewMessages';
import {
  ExternalInquirySessionLinksSchema,
  ExternalInquiryThreadIdSchema,
  InquiryDraftSchema,
} from '../inquiry';
import {
  AgentProposalSchema,
  BASH_APPROVAL_ACTIONS,
  PLAN_APPROVAL_ACTIONS,
  TOOL_EDIT_APPROVAL_ACTIONS,
  USER_QUESTION_ACTIONS,
  UserQuestionAnswersSchema,
} from '../prompts';
import { AgentCategoryFilterSchema, StreamScopedBaseSchema } from './data';
import { GettingStartedActionSchema } from '../mainView/state';

const TrimmedStringSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1));

const WebviewReadyMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.WEBVIEW_READY),
});

const InboundDeleteAllMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DELETE_ALL),
});

const OpenProfileMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_PROFILE),
});

const OpenMemoryViewMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_MEMORY_VIEW),
});

const StartRecordingMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.START_RECORDING),
});

const StopRecordingMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.STOP_RECORDING),
});

const PopOutMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.POP_OUT),
});

const PopBackMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.POP_BACK),
});

const ThemeSetMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.THEME_SET),
  theme: z.enum(['dark', 'light']),
});

const DebugModeSetMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DEBUG_MODE_SET),
  debugMode: z.boolean(),
});

const SwitchStreamMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM),
});

const InboundDeleteStreamMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DELETE_STREAM),
});

const StopStreamMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.STOP_STREAM),
});

const CompactResponseMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.COMPACT_RESPONSE),
});

const ResumeMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESUME),
});

const RunNewMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RUN_NEW),
});

const DiffStreamMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DIFF_STREAM),
});

const PackStreamMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.PACK_STREAM),
});

const CleanStreamMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.CLEAN_STREAM),
});

const RestoreStateMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESTORE_STATE),
});

const OpenTaskStorageMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE),
});

const RunCompileFixerMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RUN_COMPILE_FIXER),
});

const GetFollowupOptionsMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS),
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

const CancelRetryRequestMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST),
});

const UseOwnApiKeyMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY),
  provider: z.string().optional(),
  /** True when the underlying cause is an upstream provider credit
   *  depletion (Anthropic 400 "credit balance is too low"), meaning the
   *  stored key IS the depleted credential. The handler requires a new
   *  key for these rather than reusing the stored one. */
  upstreamCreditDepleted: z.boolean().optional(),
  /** True when the failing request went through the TeXRA relay. When
   *  false, relay wasn't in the path (direct-key call) and the handler
   *  must not globally disable relay access — other providers may still
   *  be served successfully by relay. */
  viaRelay: z.boolean().optional(),
});

const ToggleToolEditApprovalBypassMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS),
});

const ToggleSuperYoloBypassMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS),
});

const SendFollowUpMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP),
  text: TrimmedStringSchema,
  /** Pasted images (base64) to attach to this follow-up turn. */
  images: z
    .array(
      z.object({
        base64: z.string(),
        mediaType: z.string(),
        fileName: z.string(),
      }),
    )
    .optional(),
});

const PolishFollowUpMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP),
  text: TrimmedStringSchema,
});

const RetryStreamRequestMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST),
  feedback: z.string().optional(),
});

const FilterStreamsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.FILTER_STREAMS),
  filter: AgentCategoryFilterSchema,
});

const ShowInformationMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE),
  text: TrimmedStringSchema,
});

const ToolEditApprovalActionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION),
  requestId: z.string().min(1),
  action: z.enum(TOOL_EDIT_APPROVAL_ACTIONS),
  feedback: z.string().optional(),
});

const BashApprovalActionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION),
  requestId: z.string().min(1),
  action: z.enum(BASH_APPROVAL_ACTIONS),
  feedback: z.string().optional(),
});

const AgentProposalActionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION),
  proposalId: z.string().min(1),
  action: z.enum(['approve', 'reject', 'setup']),
  feedback: z.string().optional(),
  model: z.string().optional(),
  agent: z.string().optional(),
});
export type ProgressAgentProposalActionMessage = z.infer<
  typeof AgentProposalActionMessageSchema
>;

const PlanApprovalActionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION),
  approvalId: z.string().min(1),
  action: z.enum(PLAN_APPROVAL_ACTIONS),
  feedback: z.string().optional(),
});

const ExternalInquiryActionMessageSchema = z
  .object({
    command: z.literal(PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION),
    action: z.enum(['submit', 'drop', 'draft']),
    threadId: ExternalInquiryThreadIdSchema,
    answer: z.string().min(1).optional(),
    sessionLinks: ExternalInquirySessionLinksSchema.nullish(),
    feedback: z.string().optional(),
    draft: InquiryDraftSchema.nullable().optional(),
  })
  .superRefine((message, ctx) => {
    if (message.action === 'submit' && !message.answer) {
      ctx.addIssue({
        code: 'custom',
        path: ['answer'],
        message: 'Submit actions require an answer.',
      });
    }
    if (message.action === 'draft' && message.draft === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['draft'],
        message: 'Draft actions require a draft value.',
      });
    }
  });

const UserQuestionActionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION),
  requestId: z.string().min(1),
  action: z.enum([...USER_QUESTION_ACTIONS, 'skip'] as const),
  answers: UserQuestionAnswersSchema.optional(),
  feedback: z.string().optional(),
});

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

const CompareOriginalMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL),
  file: z.string().min(1),
  base: z.string().min(1).optional(),
});

const ComparePreviousMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS),
  file: z.string().min(1),
  base: z.string().min(1).optional(),
  prev: z.string().min(1).optional(),
});

const AcceptFileMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.ACCEPT_FILE),
  file: z.string().min(1),
  base: z.string().min(1).optional(),
});

const MergeFileMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.MERGE_FILE),
  file: z.string().min(1),
  base: z.string().min(1).optional(),
});

const LatexdiffFileMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE),
  file: z.string().min(1),
  base: z.string().min(1).optional(),
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
    SwitchStreamMessageSchema,
    InboundDeleteStreamMessageSchema,
    InboundDeleteAllMessageSchema,
    StopStreamMessageSchema,
    CompactResponseMessageSchema,
    ResumeMessageSchema,
    RunNewMessageSchema,
    DiffStreamMessageSchema,
    PackStreamMessageSchema,
    CleanStreamMessageSchema,
    RestoreStateMessageSchema,
    OpenTaskStorageMessageSchema,
    RunCompileFixerMessageSchema,
    FilterStreamsMessageSchema,
    SendFollowUpMessageSchema,
    PolishFollowUpMessageSchema,
    RetryStreamRequestMessageSchema,
    CancelRetryRequestMessageSchema,
    UseOwnApiKeyMessageSchema,
    StartRecordingMessageSchema,
    StopRecordingMessageSchema,
    PopOutMessageSchema,
    PopBackMessageSchema,
    ToolEditApprovalActionMessageSchema,
    ToggleToolEditApprovalBypassMessageSchema,
    ToggleSuperYoloBypassMessageSchema,
    BashApprovalActionMessageSchema,
    AgentProposalActionMessageSchema,
    PlanApprovalActionMessageSchema,
    ExternalInquiryActionMessageSchema,
    UserQuestionActionMessageSchema,
    RestoreProposalConfigMessageSchema,
    ShowInformationMessageSchema,
    OpenProfileMessageSchema,
    OpenMemoryViewMessageSchema,
    OpenFileMessageSchema,
    OpenFileCompileMessageSchema,
    CompareOriginalMessageSchema,
    ComparePreviousMessageSchema,
    AcceptFileMessageSchema,
    MergeFileMessageSchema,
    LatexdiffFileMessageSchema,
    OpenLabelMessageSchema,
    GetFollowupOptionsMessageSchema,
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
