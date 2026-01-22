/**
 * Zod schemas for webview message types.
 * Types are derived from schemas using z.infer<> for single source of truth.
 */
import { z } from 'zod';

import { PROGRESS_VIEW_APPROVAL_ACTIONS } from '@tools/approval/toolEditApproval';

// --- Base Schemas (composable building blocks) ---

/** Base for all messages - command field */
const BaseMessageSchema = z.object({
  command: z.string(),
});

/** Common pattern: single file path */
const WithFilePath = z.object({
  filePath: z.string(),
});

/** Common pattern: notify when empty option */
const WithNotifyWhenEmpty = z.object({
  notifyWhenEmpty: z.boolean().optional(),
});

/** Common pattern: files array */
const WithFiles = z.object({
  files: z.array(z.string()).optional(),
});

/** Common pattern: file active flags */
const WithFileActiveFlags = z.object({
  inputFilesActive: z.boolean().optional(),
  referenceFilesActive: z.boolean().optional(),
  auxiliaryFilesActive: z.boolean().optional(),
  mediaFilesActive: z.boolean().optional(),
  outputFilesActive: z.boolean().optional(),
});

// --- Message Schemas ---

/**
 * File fields as optional for message schemas.
 * Uses plain optional strings (not nullable) for message compatibility.
 */
const OptionalFileFields = z.object({
  inputFile: z.string().optional(),
  inputFiles: z.array(z.string()).optional(),
  referenceFile: z.string().optional(),
  referenceFiles: z.array(z.string()).optional(),
  auxiliaryFile: z.string().optional(),
  auxiliaryFiles: z.array(z.string()).optional(),
  mediaFile: z.string().optional(),
  mediaFiles: z.array(z.string()).optional(),
  outputFiles: z.array(z.string()).optional(),
});

/**
 * Polish instruction text message from webview
 */
export const PolishInstructionMessageSchema = BaseMessageSchema.extend({
  text: z.string(),
  agent: z.string().optional(),
  ...OptionalFileFields.shape,
}).extend(WithFileActiveFlags.shape);

export type PolishInstructionMessage = z.infer<
  typeof PolishInstructionMessageSchema
>;

/**
 * Clipboard image message from webview
 */
export const ClipboardImageMessageSchema = BaseMessageSchema.extend({
  base64: z.string(),
  mediaType: z.string(),
  fileName: z.string(),
});

export type ClipboardImageMessage = z.infer<typeof ClipboardImageMessageSchema>;

/**
 * File selection message from webview
 */
export const FileSelectionMessageSchema = BaseMessageSchema;

export type FileSelectionMessage = z.infer<typeof FileSelectionMessageSchema>;

/**
 * Base schema for file selected messages.
 * Shared structure for InputFileSelected and GenericFileSelected.
 */
export const FileSelectedMessageSchema = BaseMessageSchema.extend(
  WithFilePath.shape,
);

export type FileSelectedMessage = z.infer<typeof FileSelectedMessageSchema>;

/**
 * Request input file message from webview
 */
export const RequestInputFileMessageSchema = BaseMessageSchema.extend(
  WithNotifyWhenEmpty.shape,
);

export type RequestInputFileMessage = z.infer<
  typeof RequestInputFileMessageSchema
>;

/**
 * Request file message from webview
 */
export const RequestFileMessageSchema = BaseMessageSchema.extend(
  WithNotifyWhenEmpty.shape,
);

export type RequestFileMessage = z.infer<typeof RequestFileMessageSchema>;

/**
 * Request edited file message from webview
 */
export const RequestEditedFileMessageSchema = BaseMessageSchema.extend(
  WithNotifyWhenEmpty.shape,
).extend({
  baseFile: z.string().optional(),
});

export type RequestEditedFileMessage = z.infer<
  typeof RequestEditedFileMessageSchema
>;

/**
 * Request base file message from webview
 */
export const RequestBaseFileMessageSchema = BaseMessageSchema.extend(
  WithNotifyWhenEmpty.shape,
).extend({
  preserveBaseFile: z.boolean().optional(),
});

export type RequestBaseFileMessage = z.infer<
  typeof RequestBaseFileMessageSchema
>;

/**
 * Request default output files message from webview
 */
export const RequestDefaultOutputFilesMessageSchema = BaseMessageSchema.extend({
  agent: z.string().optional(),
});

export type RequestDefaultOutputFilesMessage = z.infer<
  typeof RequestDefaultOutputFilesMessageSchema
>;

/**
 * Set multiple files message from webview
 */
export const SetMultipleFilesMessageSchema = BaseMessageSchema.extend(
  WithFiles.shape,
);

export type SetMultipleFilesMessage = z.infer<
  typeof SetMultipleFilesMessageSchema
>;

/**
 * Select multiple files message from webview
 */
export const SelectMultipleFilesMessageSchema = BaseMessageSchema.extend({
  fileType: z.string(),
  currentFile: z.string().optional(),
});

export type SelectMultipleFilesMessage = z.infer<
  typeof SelectMultipleFilesMessageSchema
>;

/**
 * Get current file message from webview
 */
export const GetCurrentFileMessageSchema = BaseMessageSchema.extend({
  fileType: z.string().optional(),
  baseFile: z.string().optional(),
});

export type GetCurrentFileMessage = z.infer<typeof GetCurrentFileMessageSchema>;

/**
 * Update files message from webview
 */
export const UpdateFilesMessageSchema = BaseMessageSchema.extend(
  WithFiles.shape,
);

export type UpdateFilesMessage = z.infer<typeof UpdateFilesMessageSchema>;

/**
 * Batch update all single file selects message from extension.
 * Used by REFRESH_ALL_FILES to prevent race conditions during file watcher updates.
 */
export const SetAllSingleFilesMessageSchema = BaseMessageSchema.extend(
  OptionalFileFields.pick({
    inputFiles: true,
    referenceFiles: true,
    auxiliaryFiles: true,
    mediaFiles: true,
  }).shape,
);

export type SetAllSingleFilesMessage = z.infer<
  typeof SetAllSingleFilesMessageSchema
>;

// --- Common Utilities ---

/** Trims whitespace and requires non-empty result */
export const TrimmedStringSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1));

// --- Progress View Schemas ---

/** Polish follow-up message from progress view */
export const PolishFollowUpMessageSchema = z.object({
  stream: z.string().min(1),
  text: TrimmedStringSchema,
});

export type PolishFollowUpMessage = z.infer<typeof PolishFollowUpMessageSchema>;

/** Info message with text content */
export const InfoMessageSchema = z.object({ text: TrimmedStringSchema });

export type InfoMessage = z.infer<typeof InfoMessageSchema>;

/** Approval action message from progress view */
export const ApprovalActionMessageSchema = z.object({
  requestId: z.string().min(1),
  action: z.enum(PROGRESS_VIEW_APPROVAL_ACTIONS),
  feedback: z.string().optional(),
});

export type ApprovalActionMessage = z.infer<typeof ApprovalActionMessageSchema>;

/** Followup task message from progress view */
export const FollowupTaskMessageSchema = z.object({
  stream: z.string().min(1),
  mode: z.enum(['chat', 'workflow', 'merge']),
  agent: z.string().min(1),
  model: z.string().min(1),
  includeInstruction: z.boolean().optional(),
  initialQuestion: z.string().optional(),
  attachAgentOutputs: z.boolean().optional(),
  // Note: workflowContext is computed in backend (ProgressViewMessageHandler)
  // from originalConfig, not passed from frontend
});

export type FollowupTaskMessage = z.infer<typeof FollowupTaskMessageSchema>;

/** Stream-only message */
export const StreamMessageSchema = z.object({
  stream: z.string().min(1),
});

export type StreamMessage = z.infer<typeof StreamMessageSchema>;

/** Retry message with optional feedback */
export const RetryStreamMessageSchema = StreamMessageSchema.extend({
  feedback: z.string().optional(),
});

export type RetryStreamMessage = z.infer<typeof RetryStreamMessageSchema>;

/** Send follow-up message */
export const SendFollowUpMessageSchema = StreamMessageSchema.extend({
  text: TrimmedStringSchema,
});

export type SendFollowUpMessage = z.infer<typeof SendFollowUpMessageSchema>;

/** Sort streams message */
export const SortStreamsMessageSchema = z.object({
  sortBy: z.enum(['time', 'inputFile', 'agent']).optional(),
});

export type SortStreamsMessage = z.infer<typeof SortStreamsMessageSchema>;

/** Filter streams message */
export const FilterStreamsMessageSchema = z.object({
  filter: z.enum(['all', 'workflow', 'toolUse']),
});

export type FilterStreamsMessage = z.infer<typeof FilterStreamsMessageSchema>;

/** File command message for progress view */
export const FileCommandMessageSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().nonnegative().optional(),
});

export type FileCommandMessage = z.infer<typeof FileCommandMessageSchema>;

/** File command message requiring a base file */
export const BaseFileCommandMessageSchema = FileCommandMessageSchema.extend({
  base: z.string().min(1).optional(),
});

export type BaseFileCommandMessage = z.infer<
  typeof BaseFileCommandMessageSchema
>;

/** File compare message with optional previous file */
export const CompareMessageSchema = BaseFileCommandMessageSchema.extend({
  prev: z.string().min(1).optional(),
});

export type CompareMessage = z.infer<typeof CompareMessageSchema>;

/** Open label message */
export const OpenLabelMessageSchema = z.object({
  label: z.string().min(1),
});

export type OpenLabelMessage = z.infer<typeof OpenLabelMessageSchema>;

// --- History View Schemas ---

/** History ID message for history operations */
export const HistoryIdMessageSchema = z.object({
  historyId: z.string().min(1),
});

export type HistoryIdMessage = z.infer<typeof HistoryIdMessageSchema>;

// --- Profile View Schemas ---

/** Agent selection message */
export const SelectAgentMessageSchema = z.object({
  agentName: z.string().min(1),
});

export type SelectAgentMessage = z.infer<typeof SelectAgentMessageSchema>;

/** API access mode message */
export const SetApiAccessModeMessageSchema = z.object({
  mode: z.enum(['included', 'personal']),
});

export type SetApiAccessModeMessage = z.infer<
  typeof SetApiAccessModeMessageSchema
>;

// --- Memory View Schemas ---

/** Memory path message for file operations */
export const MemoryPathMessageSchema = z.object({
  storagePath: z.string().min(1),
});

export type MemoryPathMessage = z.infer<typeof MemoryPathMessageSchema>;

/** Memory delete message with display path for confirmation */
export const MemoryDeleteMessageSchema = MemoryPathMessageSchema.extend({
  displayPath: z.string().min(1),
});

export type MemoryDeleteMessage = z.infer<typeof MemoryDeleteMessageSchema>;

/** Memory enabled toggle message */
export const MemoryEnabledMessageSchema = z.object({
  enabled: z.boolean(),
});

export type MemoryEnabledMessage = z.infer<typeof MemoryEnabledMessageSchema>;
