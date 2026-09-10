import { z } from 'zod';

import { ActiveSkillsSnapshotSchema } from './activeSkills';
import {
  CompactionActivityDataSchema,
  ContextManagementDataSchema,
  ContextStateDataSchema,
} from './contextManagement';
import { ErrorLogDataSchema } from './errors';
import {
  FileListEntrySchema,
  LogLevelSchema,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  MessageTypeSchema,
} from './log';
import {
  MissingOutputsPayloadSchema,
  ToolUseLogSchema,
  UserMessagePayloadSchema,
  WebFetchPayloadSchema,
  WebSearchPayloadSchema,
} from './progressView/data';
import { GroupLogPayloadSchema } from './taskGroup';
import { ExtendedTokenUsageStatsSchema } from './usage';
import { WorkflowCallProgressSchema } from './workflowCallProgress';

const StreamingTextDataSchema = z.looseObject({
  status: z.enum(['running', 'completed']).optional(),
  spillPath: z.string().optional(),
});

/** One payload contract per MessageType; both transcript and UI rows reuse it. */
const StreamMessageDataSchemas = {
  [MESSAGE_TYPES.THINKING]: StreamingTextDataSchema.optional(),
  [MESSAGE_TYPES.SCRATCHPAD]: StreamingTextDataSchema.optional(),
  [MESSAGE_TYPES.FILE_LIST]: z.array(FileListEntrySchema),
  [MESSAGE_TYPES.MISSING_OUTPUTS]: MissingOutputsPayloadSchema,
  [MESSAGE_TYPES.LATEXDIFF]: z.unknown().optional(),
  [MESSAGE_TYPES.STATISTICS]: ExtendedTokenUsageStatsSchema.partial(),
  [MESSAGE_TYPES.TOOL_USE]: ToolUseLogSchema,
  [MESSAGE_TYPES.WEB_SEARCH]: WebSearchPayloadSchema,
  [MESSAGE_TYPES.WEB_FETCH]: WebFetchPayloadSchema,
  [MESSAGE_TYPES.MODEL_RESPONSE]: StreamingTextDataSchema.optional(),
  [MESSAGE_TYPES.USER_MESSAGE]: UserMessagePayloadSchema.optional(),
  [MESSAGE_TYPES.PROGRESS_STATUS]: z.unknown().optional(),
  [MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY]: CompactionActivityDataSchema,
  [MESSAGE_TYPES.ERROR]: ErrorLogDataSchema.optional(),
  [MESSAGE_TYPES.INTERNAL]: z.unknown().optional(),
  [MESSAGE_TYPES.CONTEXT_MANAGEMENT]: ContextManagementDataSchema,
  [MESSAGE_TYPES.CONTEXT_STATE]: ContextStateDataSchema,
  [MESSAGE_TYPES.ACTIVE_SKILLS]: ActiveSkillsSnapshotSchema,
  [MESSAGE_TYPES.WORKFLOW_TASK]: WorkflowCallProgressSchema,
  [MESSAGE_TYPES.DEFAULT]: z.unknown().optional(),
} satisfies Record<z.infer<typeof MessageTypeSchema>, z.ZodType>;

const streamLogSharedFields = {
  seqNo: z.int().positive(),
  /**
   * Monotone order in which immutable transcript rows became printable.
   * Unlike seqNo, this is assigned when an existing row settles, so cold
   * reconstruction preserves the same append-only chronology as a live UI.
   */
  settlementSeqNo: z.int().positive().optional(),
  id: z.string().min(1),
  level: LogLevelSchema,
  timestamp: z.number(),
  groupId: z.string().optional(),
  text: z.string().optional(),
  verbose: z.boolean().optional(),
};

const logEntryBase = z.strictObject({
  ...streamLogSharedFields,
  type: z.literal(STREAM_LOG_ENTRY_TYPES.LOG),
});

const messageEntry = <T extends string, S extends z.ZodType>(
  messageType: T,
  data: S,
) =>
  logEntryBase.extend({
    messageType: z.literal(messageType),
    data,
  });

const StreamLogMessageEntrySchema = z.discriminatedUnion('messageType', [
  messageEntry(MESSAGE_TYPES.THINKING, StreamMessageDataSchemas.thinking),
  messageEntry(MESSAGE_TYPES.SCRATCHPAD, StreamMessageDataSchemas.scratchpad),
  messageEntry(MESSAGE_TYPES.FILE_LIST, StreamMessageDataSchemas.fileList),
  messageEntry(
    MESSAGE_TYPES.MISSING_OUTPUTS,
    StreamMessageDataSchemas.missingOutputs,
  ),
  messageEntry(MESSAGE_TYPES.LATEXDIFF, StreamMessageDataSchemas.latexdiff),
  messageEntry(MESSAGE_TYPES.STATISTICS, StreamMessageDataSchemas.statistics),
  messageEntry(MESSAGE_TYPES.TOOL_USE, StreamMessageDataSchemas.toolUse),
  messageEntry(MESSAGE_TYPES.WEB_SEARCH, StreamMessageDataSchemas.webSearch),
  messageEntry(MESSAGE_TYPES.WEB_FETCH, StreamMessageDataSchemas.webFetch),
  messageEntry(
    MESSAGE_TYPES.MODEL_RESPONSE,
    StreamMessageDataSchemas.modelResponse,
  ),
  messageEntry(
    MESSAGE_TYPES.USER_MESSAGE,
    StreamMessageDataSchemas.userMessage,
  ),
  messageEntry(
    MESSAGE_TYPES.PROGRESS_STATUS,
    StreamMessageDataSchemas.progressStatus,
  ),
  messageEntry(
    MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
    StreamMessageDataSchemas.contextCompactionActivity,
  ),
  messageEntry(MESSAGE_TYPES.ERROR, StreamMessageDataSchemas.error),
  messageEntry(MESSAGE_TYPES.INTERNAL, StreamMessageDataSchemas.internal),
  messageEntry(
    MESSAGE_TYPES.CONTEXT_MANAGEMENT,
    StreamMessageDataSchemas.contextManagement,
  ),
  messageEntry(
    MESSAGE_TYPES.CONTEXT_STATE,
    StreamMessageDataSchemas.contextState,
  ),
  messageEntry(
    MESSAGE_TYPES.ACTIVE_SKILLS,
    StreamMessageDataSchemas.activeSkills,
  ),
  messageEntry(
    MESSAGE_TYPES.WORKFLOW_TASK,
    StreamMessageDataSchemas.workflowTask,
  ),
  messageEntry(MESSAGE_TYPES.DEFAULT, StreamMessageDataSchemas.default),
]);

const MessageTypeAbsentLogEntrySchema = logEntryBase.extend({
  messageType: z.undefined().optional(),
  data: z.unknown().optional(),
});

const GroupStreamLogEntrySchema = z.strictObject({
  ...streamLogSharedFields,
  type: z.enum([
    STREAM_LOG_ENTRY_TYPES.GROUP_START,
    STREAM_LOG_ENTRY_TYPES.GROUP_END,
  ]),
  messageType: z.literal(MESSAGE_TYPES.DEFAULT).optional(),
  data: GroupLogPayloadSchema.prefault({}),
});

/**
 * Canonical stream-log row. Log payloads are discriminated by `messageType`;
 * group payloads use the entry `type` because group rows have no semantic
 * message payload. Persistence and trace import parse this contract once so
 * downstream projections receive typed data directly.
 */
export const RunLogEntrySchema = z.union([
  GroupStreamLogEntrySchema,
  StreamLogMessageEntrySchema,
  MessageTypeAbsentLogEntrySchema,
]);

export type RunLogEntry = z.infer<typeof RunLogEntrySchema>;

export type RunLogEntryOf<T extends NonNullable<RunLogEntry['messageType']>> =
  Extract<RunLogEntry, { messageType: T }>;
