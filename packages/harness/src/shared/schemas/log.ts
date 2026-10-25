import { Schema } from 'effect';

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
  SCRATCHPAD: 'scratchpad',
  FILE_LIST: 'fileList',
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

const LoadedMediaMetadataSchema = Schema.Union([
  Schema.Struct({
    /**
     * Visual model input, including PDFs handled natively or rendered into
     * pages. The TUI's `[image]` label describes this model-facing category,
     * not merely an `image/*` filesystem MIME type.
     */
    kind: Schema.Literal('image'),
    mimeType: Schema.String.check(Schema.isMinLength(1)),
    sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    kind: Schema.Literal('audio'),
    mimeType: Schema.String.check(Schema.isMinLength(1)),
    sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
]);
export type LoadedMediaMetadata = typeof LoadedMediaMetadataSchema.Type;

export const FileListEntrySchema = Schema.Struct({
  path: Schema.String,
  ok: Schema.Boolean,
  source: Schema.optional(Schema.String),
  sourceDisplay: Schema.optional(Schema.String),
  varName: Schema.optional(Schema.String),
  /** Present only when this file was loaded through the media pipeline. */
  media: Schema.optional(LoadedMediaMetadataSchema),
});

export type FileListEntry = typeof FileListEntrySchema.Type;
