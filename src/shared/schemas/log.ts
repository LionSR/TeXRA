import { z } from 'zod';

import type { TaskGroupStatus } from './stream.js';

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

/** Terminal states for finalizing log groups (subset of TaskGroupStatus) */
export const END_GROUP_STATUS = {
  ERROR: 'error',
  STOPPED: 'stopped',
} as const;

export const EndGroupStatusSchema = z.enum([
  END_GROUP_STATUS.ERROR,
  END_GROUP_STATUS.STOPPED,
]);
export type EndGroupStatus = z.infer<typeof EndGroupStatusSchema>;

type _AssertEndGroupStatusSubset = EndGroupStatus extends TaskGroupStatus
  ? true
  : never;

export const MESSAGE_TYPES = {
  THINKING: 'thinking',
  SCRATCHPAD: 'scratchpad',
  FILE_LIST: 'fileList',
  MISSING_OUTPUTS: 'missingOutputs',
  LATEXDIFF: 'latexdiff',
  STATISTICS: 'statistics',
  TOOL_USE: 'toolUse',
  WEB_SEARCH: 'webSearch',
  MODEL_RESPONSE: 'modelResponse',
  USER_MESSAGE: 'userMessage',
  PROGRESS_STATUS: 'progressStatus',
  ERROR: 'error',
  INTERNAL: 'internal',
  CONTEXT_MANAGEMENT: 'contextManagement',
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

export const FileListEntrySchema = z.object({
  path: z.string(),
  ok: z.boolean(),
  source: z.string().optional(),
  sourceDisplay: z.string().optional(),
  varName: z.string().optional(),
  internal: z.boolean().optional(),
});

export type FileListEntry = z.infer<typeof FileListEntrySchema>;

export const LogMessageDataSchema = z.strictObject({
  id: z.string().min(1),
  text: z.string(),
  level: LogLevelSchema,
  timestamp: z.number(),
  groupId: z.string().optional(),
  messageType: MessageTypeSchema.optional(),
  verbose: z.boolean().optional(),
  data: z.unknown().optional(),
});
export type LogMessageData = z.infer<typeof LogMessageDataSchema>;

export const LogMessageUpdateSchema = LogMessageDataSchema.partial().required({
  id: true,
});
export type LogMessageUpdate = z.infer<typeof LogMessageUpdateSchema>;
