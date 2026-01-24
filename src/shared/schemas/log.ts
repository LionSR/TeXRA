// Third-party imports
import { z } from 'zod';

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
export type LogLevel = z.infer<typeof LogLevelSchema>;

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
 * Log message data schema - single source of truth for log entry structure.
 */
export const LogMessageDataSchema = z.strictObject({
  /** Unique identifier for this log entry */
  id: z.string().min(1),
  /** Raw message text */
  text: z.string(),
  /** Severity level */
  level: LogLevelSchema,
  /** Unix timestamp (ms) */
  timestamp: z.number(),
  /** Optional group association */
  groupId: z.string().optional(),
  /** Optional message category */
  messageType: MessageTypeSchema.optional(),
  /** Whether verbose details should be displayed */
  verbose: z.boolean().optional(),
  /** Optional structured data associated with the entry */
  data: z.unknown().optional(),
});

export type LogMessageData = z.infer<typeof LogMessageDataSchema>;

/**
 * Log message update schema - partial update for existing log entries.
 * All fields optional except id (required for identifying the entry to update).
 */
export const LogMessageUpdateSchema = LogMessageDataSchema.partial().required({
  id: true,
});

export type LogMessageUpdate = z.infer<typeof LogMessageUpdateSchema>;
