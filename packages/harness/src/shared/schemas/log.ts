import { Schema } from 'effect';

/**
 * The severity of a `log` trace event, from `error` down to `debug`. A
 * surface's own level filter decides which it shows; `debug` rows are the
 * transcript's debug tier.
 */
export const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
} as const;

/** One of the {@link LOG_LEVELS} values, as a `log` trace event records it. */
export const LogLevelSchema = Schema.Enum(LOG_LEVELS);
/** The decoded shape of {@link LogLevelSchema}. */
export type LogLevel = typeof LogLevelSchema.Type;

/**
 * What kind of card a `log` row draws in the transcript: streamed thinking or
 * model text, a files-loaded list, a tool call, a web search, the user's
 * message, a status line, a context-management notice, or an error. Each
 * type's `data` payload has its own schema in `logPayload.ts`; `default` is a
 * plain text line.
 */
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

/** One of the {@link MESSAGE_TYPES} values, as a `log` row records it. */
export const MessageTypeSchema = Schema.Enum(MESSAGE_TYPES);

/** The decoded shape of {@link MessageTypeSchema}. */
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
/**
 * What the media pipeline loaded for one file in a files-loaded list: whether
 * the model sees it as an image or as audio, its MIME type and its size. The
 * transcript's file-list row shows it.
 */
export type LoadedMediaMetadata = typeof LoadedMediaMetadataSchema.Type;

/**
 * One file in a `fileList` log row: its path, whether it loaded, the category
 * it was loaded under (`Input Files`, `Context Files`, …) with its display
 * label, the template variable it fills, and what the media pipeline made of
 * it. A document task's loader writes these; the transcript draws them as one
 * files-loaded card per category.
 */
export const FileListEntrySchema = Schema.Struct({
  path: Schema.String,
  ok: Schema.Boolean,
  source: Schema.optional(Schema.String),
  sourceDisplay: Schema.optional(Schema.String),
  varName: Schema.optional(Schema.String),
  /** Present only when this file was loaded through the media pipeline. */
  media: Schema.optional(LoadedMediaMetadataSchema),
});

/** The decoded shape of {@link FileListEntrySchema}. */
export type FileListEntry = typeof FileListEntrySchema.Type;
