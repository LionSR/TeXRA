import { z } from 'zod';

import { ActiveSkillsSnapshotSchema } from './activeSkills';
import {
  CompactionActivityDataSchema,
  ContextManagementDataSchema,
  ContextStateDataSchema,
} from './contextManagement';
import { parseDiffResultEntries } from './diffResult';
import { ErrorLogDataSchema } from './errors';
import { FileListEntrySchema, MESSAGE_TYPES, type MessageType } from './log';
import {
  MissingOutputsPayloadSchema,
  ToolUseLogSchema,
  UserMessagePayloadSchema,
  WebSearchPayloadSchema,
} from './progressView/data';
import { ExtendedTokenUsageStatsSchema } from './usage';
import { WorkflowCallProgressSchema } from './workflowCallProgress';

const StreamingTextDataSchema = z.looseObject({
  status: z.enum(['running', 'completed']).optional(),
  spillPath: z.string().optional(),
});

/**
 * The payload contract of a durable `log` row, one per `messageType`. The
 * transcript fold decodes a row's `data` here exactly once; a payload its
 * schema rejects becomes a visible error row, never a cast.
 */
const LOG_PAYLOAD_SCHEMAS = {
  [MESSAGE_TYPES.THINKING]: StreamingTextDataSchema.optional(),
  [MESSAGE_TYPES.SCRATCHPAD]: StreamingTextDataSchema.optional(),
  [MESSAGE_TYPES.FILE_LIST]: z.array(FileListEntrySchema),
  [MESSAGE_TYPES.MISSING_OUTPUTS]: MissingOutputsPayloadSchema,
  [MESSAGE_TYPES.LATEXDIFF]: z.unknown().transform(parseDiffResultEntries),
  [MESSAGE_TYPES.STATISTICS]: ExtendedTokenUsageStatsSchema.partial(),
  // Passthrough: a tool's extra fields (e.g. `files`) are forwarded as-is.
  [MESSAGE_TYPES.TOOL_USE]: ToolUseLogSchema.loose(),
  [MESSAGE_TYPES.WEB_SEARCH]: WebSearchPayloadSchema,
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
} satisfies Record<MessageType, z.ZodType>;

/** A decoded `log` row payload, discriminated by its message type. */
export type LogPayload = {
  [K in MessageType]: {
    readonly messageType: K;
    readonly data: z.output<(typeof LOG_PAYLOAD_SCHEMAS)[K]>;
  };
}[MessageType];

/** Decode one `log` row payload, or name the schema's objection. */
export function decodeLogPayload(
  messageType: MessageType,
  data: unknown,
): { readonly payload: LogPayload } | { readonly issue: string } {
  const parsed = LOG_PAYLOAD_SCHEMAS[messageType].safeParse(data);
  return parsed.success
    ? { payload: { messageType, data: parsed.data } as LogPayload }
    : { issue: parsed.error.message };
}
