/**
 * Zod schemas for webview message types.
 * Types are derived from schemas using z.infer<> for single source of truth.
 */
import { z } from 'zod';

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
 * Input file selected message from webview.
 * Alias for FileSelectedMessageSchema for semantic clarity.
 */
export const InputFileSelectedMessageSchema = FileSelectedMessageSchema;
export type InputFileSelectedMessage = FileSelectedMessage;

/**
 * Generic file selected message from webview.
 * Alias for FileSelectedMessageSchema for semantic clarity.
 */
export const GenericFileSelectedMessageSchema = FileSelectedMessageSchema;
export type GenericFileSelectedMessage = FileSelectedMessage;

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

// --- Execution Manager Message Schemas ---

/** Tool configuration options */
const ToolConfigSchema = z.object({
  autoExtractFigure: z.boolean().optional(),
  autoExtractTikzFigure: z.boolean().optional(),
  attachTeXCount: z.boolean().optional(),
  attachDiagnostics: z.boolean().optional(),
  autoCompileInputPdf: z.boolean().optional(),
});

/**
 * Execute agent message from webview.
 * Contains all fields needed to run a workflow or tool-use agent.
 */
export const ExecuteMessageSchema = z.object({
  // Agent identification
  agent: z.string().optional(),
  model: z.string().optional(),
  instruction: z.string().optional(),
  isToolUseAgent: z.boolean().optional(),

  // File inputs
  inputFile: z.string().optional(),
  inputFiles: z.array(z.string()).optional(),
  referenceFile: z.string().nullable().optional(),
  referenceFiles: z.array(z.string()).optional(),
  auxiliaryFile: z.string().nullable().optional(),
  auxiliaryFiles: z.array(z.string()).optional(),
  mediaFile: z.string().nullable().optional(),
  mediaFiles: z.array(z.string()).optional(),

  // Output configuration
  outputFiles: z.array(z.string()).optional(),
  outputFilesActive: z.boolean().optional(),

  // Tool config
  ...ToolConfigSchema.shape,
});

export type ExecuteMessage = z.infer<typeof ExecuteMessageSchema>;

/**
 * File operation message for merge/compare/accept operations
 */
export const FileOperationMessageSchema = z.object({
  command: z.string(),
  inputFile: z.string().optional(),
  baseFile: z.string().optional(),
  editedFile: z.string().optional(),
});

export type FileOperationMessage = z.infer<typeof FileOperationMessageSchema>;

/**
 * Housekeeping command message (clean, indent, etc.)
 */
export const HousekeepingMessageSchema = z.object({
  command: z.string(),
});

export type HousekeepingMessage = z.infer<typeof HousekeepingMessageSchema>;

/**
 * Single file operation message (pack/clean single file)
 */
export const SingleOperationMessageSchema = z.object({
  command: z.string(),
  inputFile: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
});

export type SingleOperationMessage = z.infer<
  typeof SingleOperationMessageSchema
>;

/**
 * Multiple file operation message (pack/clean multiple files)
 */
export const MultipleOperationMessageSchema = z.object({
  command: z.string(),
  inputFile: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  outputFiles: z.array(z.string()).optional(),
});

export type MultipleOperationMessage = z.infer<
  typeof MultipleOperationMessageSchema
>;
