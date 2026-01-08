import { z } from 'zod';

import type { TaskGroupStatus } from '@common/constants/streamStatus';

/**
 * Log level constants - single source of truth for severity levels.
 * Ordered from most to least critical.
 */
export const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
} as const;

export const LogLevelSchema = z.enum([
  LOG_LEVELS.ERROR,
  LOG_LEVELS.WARN,
  LOG_LEVELS.INFO,
  LOG_LEVELS.DEBUG,
]);

/**
 * End group status - terminal states used when finalizing log groups.
 * Single source of truth for end status in AgentLogger, LogEventSink, and transports.
 * This is a strict subset of TaskGroupStatus (only terminal states).
 *
 * ## Status Semantics
 *
 * - **STOPPED**: Flow completed successfully (all rounds finished normally).
 *   Despite the name, this does NOT mean "user stopped" - it means "finished".
 *   This naming comes from the UI status indicator showing "Stopped" when done.
 *
 * - **ERROR**: Flow terminated due to an error OR was interrupted by user.
 *   Use this for any non-successful termination.
 */
export const END_GROUP_STATUS = {
  /** Flow terminated due to error or user interruption */
  ERROR: 'error',
  /** Flow completed successfully (all rounds finished) */
  STOPPED: 'stopped',
} as const;

export const EndGroupStatusSchema = z.enum([
  END_GROUP_STATUS.ERROR,
  END_GROUP_STATUS.STOPPED,
]);

export type EndGroupStatus = z.infer<typeof EndGroupStatusSchema>;

/**
 * Compile-time assertion: EndGroupStatus must be a subset of TaskGroupStatus.
 * This ensures type compatibility when assigning EndGroupStatus to TaskGroupStatus fields.
 */
type _AssertEndGroupStatusSubset = EndGroupStatus extends TaskGroupStatus
  ? true
  : never;
const _assertEndGroupStatusSubset: _AssertEndGroupStatusSubset = true;

/**
 * Message type constants - single source of truth for log message categories.
 */
export const MESSAGE_TYPES = {
  THINKING: 'thinking',
  SCRATCHPAD: 'scratchpad',
  FILE_LIST: 'fileList',
  MISSING_OUTPUTS: 'missingOutputs',
  LATEXDIFF: 'latexdiff',
  STATISTICS: 'statistics',
  TOOL_USE: 'toolUse',
  /** Web search results from native provider tools (Anthropic, OpenAI, Google) */
  WEB_SEARCH: 'webSearch',
  MODEL_RESPONSE: 'modelResponse',
  USER_MESSAGE: 'userMessage',
  PROGRESS_STATUS: 'progressStatus',
  /** Error messages displayed as foldable banners */
  ERROR: 'error',
  /** Internal/system messages used by the extension */
  INTERNAL: 'internal',
  /** Context management events (compaction, context clearing) */
  CONTEXT_MANAGEMENT: 'contextManagement',
  /** Context state updates (current context utilization) */
  CONTEXT_STATE: 'contextState',
  DEFAULT: 'default',
} as const;

export const MessageTypeSchema = z.enum([
  MESSAGE_TYPES.THINKING,
  MESSAGE_TYPES.SCRATCHPAD,
  MESSAGE_TYPES.FILE_LIST,
  MESSAGE_TYPES.MISSING_OUTPUTS,
  MESSAGE_TYPES.LATEXDIFF,
  MESSAGE_TYPES.STATISTICS,
  MESSAGE_TYPES.TOOL_USE,
  MESSAGE_TYPES.WEB_SEARCH,
  MESSAGE_TYPES.MODEL_RESPONSE,
  MESSAGE_TYPES.USER_MESSAGE,
  MESSAGE_TYPES.PROGRESS_STATUS,
  MESSAGE_TYPES.ERROR,
  MESSAGE_TYPES.INTERNAL,
  MESSAGE_TYPES.CONTEXT_MANAGEMENT,
  MESSAGE_TYPES.CONTEXT_STATE,
  MESSAGE_TYPES.DEFAULT,
]);

export type MessageType = z.infer<typeof MessageTypeSchema>;

/**
 * Schema for FILE_LIST message data entries.
 * Single source of truth for file list entry structure used by:
 * - AgentLogger.fileList() and logFileCategory()
 * - Progress view normalizers (normalizeFileListEntries)
 * - userVars.ts LoadedFileEntry type
 *
 * Note: The normalizer defaults missing `source` to 'unknown', so it's optional here.
 */
export const FileListEntrySchema = z.object({
  /** File path (absolute or relative) */
  path: z.string(),
  /** Whether the file was successfully loaded/found */
  ok: z.boolean(),
  /** Category source identifier (e.g., 'requiredFiles', 'Input Files'). Defaults to 'unknown' in normalizer. */
  source: z.string().optional(),
  /** Display label for the source (defaults to source if not provided) */
  sourceDisplay: z.string().optional(),
  /** Variable name if loaded for prompt variable substitution */
  varName: z.string().optional(),
  /** Whether this is an internal/bundled file */
  internal: z.boolean().optional(),
});

export type FileListEntry = z.infer<typeof FileListEntrySchema>;
