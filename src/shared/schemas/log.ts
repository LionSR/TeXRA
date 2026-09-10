import { z } from 'zod';

export const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
} as const;

export const LogLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const MESSAGE_TYPES = {
  THINKING: 'thinking',
  SCRATCHPAD: 'scratchpad',
  FILE_LIST: 'fileList',
  MISSING_OUTPUTS: 'missingOutputs',
  LATEXDIFF: 'latexdiff',
  STATISTICS: 'statistics',
  TOOL_USE: 'toolUse',
  WEB_SEARCH: 'webSearch',
  WEB_FETCH: 'webFetch',
  MODEL_RESPONSE: 'modelResponse',
  USER_MESSAGE: 'userMessage',
  PROGRESS_STATUS: 'progressStatus',
  CONTEXT_COMPACTION_ACTIVITY: 'contextCompactionActivity',
  ERROR: 'error',
  INTERNAL: 'internal',
  CONTEXT_MANAGEMENT: 'contextManagement',
  CONTEXT_STATE: 'contextState',
  ACTIVE_SKILLS: 'activeSkills',
  // Legacy protocol spelling retained for stored histories and consumers.
  WORKFLOW_TASK: 'workflowTask',
  DEFAULT: 'default',
} as const;

export const MessageTypeSchema = z.enum(MESSAGE_TYPES);

export type MessageType = z.infer<typeof MessageTypeSchema>;

/**
 * Message types whose text runs in incrementally (`data.status: 'running'`)
 * before finalizing. Single source of truth for both the frontend banner
 * formatters (skip markdown parsing while running) and the backend orphan
 * sweep (finalize entries stuck at `running` after cancel/crash/reload).
 */
export const STREAMING_TEXT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  MESSAGE_TYPES.THINKING,
  MESSAGE_TYPES.SCRATCHPAD,
  MESSAGE_TYPES.MODEL_RESPONSE,
]);

export const STREAM_LOG_ENTRY_TYPES = {
  LOG: 'log',
  GROUP_START: 'group-start',
  GROUP_END: 'group-end',
} as const;

const LoadedMediaMetadataSchema = z.discriminatedUnion('kind', [
  z.object({
    /**
     * Visual model input, including PDFs handled natively or rendered into
     * pages. The TUI's `[image]` label describes this model-facing category,
     * not merely an `image/*` filesystem MIME type.
     */
    kind: z.literal('image'),
    mimeType: z.string().min(1),
    sizeBytes: z.int().nonnegative(),
  }),
  z.object({
    kind: z.literal('audio'),
    mimeType: z.string().min(1),
    sizeBytes: z.int().nonnegative(),
  }),
]);
export type LoadedMediaMetadata = z.infer<typeof LoadedMediaMetadataSchema>;

export const FileListEntrySchema = z.object({
  path: z.string(),
  ok: z.boolean(),
  source: z.string().optional(),
  sourceDisplay: z.string().optional(),
  varName: z.string().optional(),
  /** Present only when this file was loaded through the media pipeline. */
  media: LoadedMediaMetadataSchema.optional(),
});

export type FileListEntry = z.infer<typeof FileListEntrySchema>;
