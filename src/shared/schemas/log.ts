import { z } from 'zod';

export const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
} as const;

const LogLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * Legacy 2-value terminal vocabulary a `GROUP_END` row's `data.status` used
 * to carry (retired as a *production* type by #8087/§8.2 — every live writer
 * now emits the literal `RunOutcome`). Kept solely as a read-side type:
 * `StreamLogStore`'s `parsePersistedEntries` boundary (§8.3) still matches
 * these two literals to normalize on-disk rows written before the cutover.
 * This is the permanent legacy-transcript reader, not a temporary shim,
 * since released transcripts are never rewritten. No longer asserted as a
 * subset of `TaskGroupStatus`: that type is retyped to the native
 * `StreamPhase`/`RunOutcome` vocabulary (#7993 step 3) and shares no values
 * with this one.
 */
export const END_GROUP_STATUS = {
  ERROR: 'error',
  STOPPED: 'stopped',
} as const;

export const EndGroupStatusSchema = z.enum(END_GROUP_STATUS);
export type EndGroupStatus = z.infer<typeof EndGroupStatusSchema>;

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

const MessageTypeSchema = z.enum(MESSAGE_TYPES);

export type MessageType = z.infer<typeof MessageTypeSchema>;

/**
 * Message types whose text streams in incrementally (`data.status: 'running'`)
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

const StreamLogEntryTypeSchema = z.enum(STREAM_LOG_ENTRY_TYPES);

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
  internal: z.boolean().optional(),
  /** Present only when this file was loaded through the media pipeline. */
  media: LoadedMediaMetadataSchema.optional(),
});

export type FileListEntry = z.infer<typeof FileListEntrySchema>;

export const StreamLogEntrySchema = z.strictObject({
  seqNo: z.int().positive(),
  /**
   * Monotone order in which immutable transcript rows became printable.
   * Unlike seqNo, this is assigned when an existing row settles, so cold
   * reconstruction preserves the same append-only chronology as a live UI.
   */
  settlementSeqNo: z.int().positive().optional(),
  id: z.string().min(1),
  type: StreamLogEntryTypeSchema,
  level: LogLevelSchema,
  timestamp: z.number(),
  groupId: z.string().optional(),
  messageType: MessageTypeSchema.optional(),
  text: z.string().optional(),
  verbose: z.boolean().optional(),
  data: z.unknown().optional(),
});

export type StreamLogEntry = z.infer<typeof StreamLogEntrySchema>;

export const StreamLogTextDeltaSchema = z.strictObject({
  id: z.string().min(1),
  appendText: z.string().min(1),
});
export type StreamLogTextDelta = z.infer<typeof StreamLogTextDeltaSchema>;

const LogMessageDataSchema = z.strictObject({
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
