import { Schema } from 'effect';
import { NonNegativeIntSchema } from './nonNegativeInt';

export const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
} as const;

export const LogLevelSchema = Schema.Enum(LOG_LEVELS);
export type LogLevel = typeof LogLevelSchema.Type;

export const MESSAGE_TYPES = {
  THINKING: 'thinking',
  TOOL_USE: 'toolUse',
  WEB_SEARCH: 'webSearch',
  MODEL_RESPONSE: 'modelResponse',
  USER_MESSAGE: 'userMessage',
  PROGRESS_STATUS: 'progressStatus',
  CONTEXT_COMPACTION_ACTIVITY: 'contextCompactionActivity',
  ERROR: 'error',
  CONTEXT_MANAGEMENT: 'contextManagement',
  DEFAULT: 'default',
} as const;

export const MessageTypeSchema = Schema.Enum(MESSAGE_TYPES);

export type MessageType = typeof MessageTypeSchema.Type;
