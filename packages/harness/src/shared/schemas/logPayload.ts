import { Schema } from 'effect';

import {
  CompactionActivityDataSchema,
  ContextManagementDataSchema,
} from './contextManagement';
import { ErrorLogDataSchema } from './errors';
import { FileListEntrySchema, MESSAGE_TYPES, type MessageType } from './log';
import {
  ToolUseLogSchema,
  UserMessagePayloadSchema,
  WebSearchPayloadSchema,
} from './progressView/data';

const StreamingTextDataSchema = Schema.StructWithRest(
  Schema.Struct({
    status: Schema.optional(Schema.Literals(['running', 'completed'])),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/**
 * The payload contract of a durable `log` row, one per `messageType`. The
 * transcript fold decodes a row's `data` here exactly once; a payload its
 * schema rejects becomes a visible error row, never a cast.
 */
const LOG_PAYLOAD_SCHEMAS = {
  [MESSAGE_TYPES.THINKING]: Schema.optional(StreamingTextDataSchema),
  [MESSAGE_TYPES.SCRATCHPAD]: Schema.optional(StreamingTextDataSchema),
  [MESSAGE_TYPES.FILE_LIST]: Schema.Array(FileListEntrySchema),
  // Passthrough: a tool's extra fields (e.g. `files`) are forwarded as-is.
  [MESSAGE_TYPES.TOOL_USE]: Schema.StructWithRest(ToolUseLogSchema, [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
  [MESSAGE_TYPES.WEB_SEARCH]: WebSearchPayloadSchema,
  [MESSAGE_TYPES.MODEL_RESPONSE]: Schema.optional(StreamingTextDataSchema),
  [MESSAGE_TYPES.USER_MESSAGE]: Schema.optional(UserMessagePayloadSchema),
  [MESSAGE_TYPES.PROGRESS_STATUS]: Schema.optional(Schema.Unknown),
  [MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY]: CompactionActivityDataSchema,
  [MESSAGE_TYPES.ERROR]: Schema.optional(ErrorLogDataSchema),
  [MESSAGE_TYPES.CONTEXT_MANAGEMENT]: ContextManagementDataSchema,
  [MESSAGE_TYPES.DEFAULT]: Schema.optional(Schema.Unknown),
} satisfies Record<MessageType, Schema.Top>;

/** A decoded `log` row payload, discriminated by its message type. */
export type LogPayload = {
  [K in MessageType]: {
    readonly messageType: K;
    readonly data: (typeof LOG_PAYLOAD_SCHEMAS)[K]['Type'];
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
