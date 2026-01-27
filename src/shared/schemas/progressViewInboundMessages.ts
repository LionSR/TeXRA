/**
 * Schema-driven inbound message definitions for ProgressView.
 *
 * These are messages sent FROM the frontend TO the backend.
 * Uses discriminated union for single-parse validation at dispatch.
 *
 * IMPORTANT: This file is shared between frontend and backend.
 * Do NOT import from @agent, @tools, @logger, or other backend-only modules.
 */
import { z } from 'zod';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

import { StreamTabIdSchema } from './identifiers';

// ============================================================
// Shared constants (must match backend definitions)
// Defined inline to avoid backend module dependencies.
// ============================================================

/** Agent category values - must match AgentCategory enum in AgentDataclass.ts */
const AGENT_CATEGORY_VALUES = ['workflow', 'toolUse'] as const;

/** Tool edit approval actions - must match TOOL_EDIT_APPROVAL_ACTIONS in toolEditApproval.ts */
const TOOL_EDIT_APPROVAL_ACTIONS = [
  'approve',
  'reject',
  'approveAll',
  'rejectAll',
] as const;

/** Bash approval actions - must match BASH_APPROVAL_ACTIONS in bashApproval.ts */
const BASH_APPROVAL_ACTIONS = ['approve', 'reject'] as const;

// ============================================================
// Shared field schemas
// ============================================================

/** Trims whitespace and requires non-empty result */
const TrimmedStringSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1));

// ============================================================
// Common message schemas (no payload beyond command)
// ============================================================

const WebviewReadyMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.WEBVIEW_READY),
});

const DeleteAllMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DELETE_ALL),
});

const OpenProfileMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_PROFILE),
});

const OpenMemoryViewMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_MEMORY_VIEW),
});

const GetFollowupOptionsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS),
});

const StartRecordingMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.START_RECORDING),
});

const StopRecordingMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.STOP_RECORDING),
});

// ============================================================
// Theme/debug message schemas
// ============================================================

const ThemeSetMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.THEME_SET),
  theme: z.enum(['dark', 'light']),
});

const DebugModeSetMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DEBUG_MODE_SET),
  debugMode: z.boolean(),
});

// ============================================================
// Stream-based message schemas (stream ID only)
// ============================================================

const SwitchStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM),
  stream: StreamTabIdSchema,
});

const DeleteStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DELETE_STREAM),
  stream: StreamTabIdSchema,
});

const StopStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.STOP_STREAM),
  stream: StreamTabIdSchema,
});

const ResumeMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESUME),
  stream: StreamTabIdSchema,
});

const RunNewMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RUN_NEW),
  stream: StreamTabIdSchema,
});

const DiffStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DIFF_STREAM),
  stream: StreamTabIdSchema,
});

const PackStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.PACK_STREAM),
  stream: StreamTabIdSchema,
});

const CleanStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.CLEAN_STREAM),
  stream: StreamTabIdSchema,
});

const RestoreStateMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESTORE_STATE),
  stream: StreamTabIdSchema,
});

const OpenTaskStorageMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE),
  stream: StreamTabIdSchema,
});

const CancelRetryRequestMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST),
  stream: StreamTabIdSchema,
});

const ToggleToolEditApprovalBypassMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS),
  stream: StreamTabIdSchema,
});

// ============================================================
// Stream + text message schemas
// ============================================================

const SendFollowUpMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP),
  stream: StreamTabIdSchema,
  text: TrimmedStringSchema,
});

const PolishFollowUpMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP),
  stream: StreamTabIdSchema,
  text: TrimmedStringSchema,
});

const RetryStreamRequestMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST),
  stream: StreamTabIdSchema,
  feedback: z.string().optional(),
});

// ============================================================
// Sort/filter message schemas
// ============================================================

const SortStreamsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SORT_STREAMS),
  sortBy: z.enum(['time', 'inputFile', 'agent']).default('time'),
});

const FilterStreamsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.FILTER_STREAMS),
  filter: z.union([z.literal('all'), z.enum(AGENT_CATEGORY_VALUES)]),
});

// ============================================================
// Info message schema
// ============================================================

const ShowInformationMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE),
  text: TrimmedStringSchema,
});

// ============================================================
// Approval action message schemas
// ============================================================

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
});

// ============================================================
// File operation message schemas
// ============================================================

const OpenFileMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_FILE),
  file: z.string().min(1),
  line: z.number().int().nonnegative().optional(),
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

// ============================================================
// Followup task message schemas
// ============================================================

const SetupFollowupMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP),
  stream: StreamTabIdSchema,
  mode: z.enum(['chat', 'workflow', 'merge']),
  agent: z.string().min(1),
  model: z.string().min(1),
  includeInstruction: z.boolean().optional(),
  initialQuestion: z.string().optional(),
  attachAgentOutputs: z.boolean().optional(),
});

const RunFollowupMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP),
  stream: StreamTabIdSchema,
  mode: z.enum(['chat', 'workflow', 'merge']),
  agent: z.string().min(1),
  model: z.string().min(1),
  includeInstruction: z.boolean().optional(),
  initialQuestion: z.string().optional(),
  attachAgentOutputs: z.boolean().optional(),
});

// ============================================================
// Discriminated union of all inbound messages
// ============================================================

export const ProgressViewInboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    // Common
    WebviewReadyMessageSchema,
    ThemeSetMessageSchema,
    DebugModeSetMessageSchema,

    // Stream management
    SwitchStreamMessageSchema,
    DeleteStreamMessageSchema,
    DeleteAllMessageSchema,
    StopStreamMessageSchema,

    // Stream actions
    ResumeMessageSchema,
    RunNewMessageSchema,
    DiffStreamMessageSchema,
    PackStreamMessageSchema,
    CleanStreamMessageSchema,
    RestoreStateMessageSchema,
    OpenTaskStorageMessageSchema,

    // Sort/filter
    SortStreamsMessageSchema,
    FilterStreamsMessageSchema,

    // Follow-up and retry
    SendFollowUpMessageSchema,
    PolishFollowUpMessageSchema,
    RetryStreamRequestMessageSchema,
    CancelRetryRequestMessageSchema,

    // Recording
    StartRecordingMessageSchema,
    StopRecordingMessageSchema,

    // Approval actions
    ToolEditApprovalActionMessageSchema,
    ToggleToolEditApprovalBypassMessageSchema,
    BashApprovalActionMessageSchema,
    AgentProposalActionMessageSchema,

    // Info
    ShowInformationMessageSchema,

    // Navigation
    OpenProfileMessageSchema,
    OpenMemoryViewMessageSchema,

    // File operations
    OpenFileMessageSchema,
    OpenFileCompileMessageSchema,
    CompareOriginalMessageSchema,
    ComparePreviousMessageSchema,
    AcceptFileMessageSchema,
    MergeFileMessageSchema,
    LatexdiffFileMessageSchema,
    OpenLabelMessageSchema,

    // Followup task
    GetFollowupOptionsMessageSchema,
    SetupFollowupMessageSchema,
    RunFollowupMessageSchema,
  ],
);

export type ProgressViewInboundMessage = z.infer<
  typeof ProgressViewInboundMessageSchema
>;

// ============================================================
// Type-safe handler registry types
// ============================================================

/**
 * Handler function type - receives typed message data (already validated).
 */
type TypedInboundHandler<T extends ProgressViewInboundMessage> = (
  data: T,
) => Promise<void> | void;

/**
 * Handler registry mapping command to typed handler.
 * TypeScript ensures handlers receive the correct message type.
 */
export type ProgressViewInboundHandlerRegistry = {
  [K in ProgressViewInboundMessage['command']]?: TypedInboundHandler<
    Extract<ProgressViewInboundMessage, { command: K }>
  >;
};

// ============================================================
// Dispatcher function
// ============================================================

/**
 * Dispatch an inbound message to its handler using schema-driven validation.
 *
 * Parses the raw message once with the discriminated union schema,
 * then routes to the appropriate typed handler.
 *
 * @param raw - Raw message from webview postMessage
 * @param handlers - Typed handler registry
 * @param onError - Optional error callback for validation failures
 * @returns true if message was handled, false otherwise
 */
export function dispatchProgressViewInbound(
  raw: unknown,
  handlers: ProgressViewInboundHandlerRegistry,
  onError?: (error: unknown) => void,
): boolean {
  const result = ProgressViewInboundMessageSchema.safeParse(raw);
  if (!result.success) {
    onError?.(result.error);
    return false;
  }

  const message = result.data;
  const handler = handlers[message.command] as
    | TypedInboundHandler<typeof message>
    | undefined;

  if (handler) {
    // Handle both sync and async handlers
    const maybePromise = handler(message);
    if (maybePromise instanceof Promise) {
      maybePromise.catch((error) => onError?.(error));
    }
    return true;
  }

  return false;
}
