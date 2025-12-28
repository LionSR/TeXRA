/**
 * Zod schemas for webview message types.
 * Types are derived from schemas using z.infer<> for single source of truth.
 */
import { z } from 'zod';

import { ProgressViewApprovalActions } from '@tools/approval/toolEditApproval';

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
 * Polish instruction text message from webview
 */
export const PolishInstructionMessageSchema = BaseMessageSchema.extend({
  text: z.string(),
  agent: z.string().optional(),
  inputFile: z.string().optional(),
  referenceFile: z.string().optional(),
  auxiliaryFile: z.string().optional(),
  mediaFile: z.string().optional(),
  inputFiles: z.array(z.string()).optional(),
  referenceFiles: z.array(z.string()).optional(),
  auxiliaryFiles: z.array(z.string()).optional(),
  mediaFiles: z.array(z.string()).optional(),
  outputFiles: z.array(z.string()).optional(),
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
  action: z.enum(ProgressViewApprovalActions),
  note: z.string().optional(),
});

export type ApprovalActionMessage = z.infer<typeof ApprovalActionMessageSchema>;

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
