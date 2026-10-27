import { Result, Schema } from 'effect';

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

/** One arm of the log payload: a message type and the `data` its rows carry. */
function arm<T extends MessageType, S extends Schema.Top>(
  messageType: T,
  data: S,
) {
  return Schema.Struct({ messageType: Schema.Literal(messageType), data });
}

/**
 * The payload contract of a durable `log` row, one arm per `messageType`.
 * The transcript fold decodes a row's `data` here exactly once; a payload
 * its arm rejects becomes a visible error row, never a cast.
 */
const LogPayloadSchema = Schema.Union([
  arm(MESSAGE_TYPES.THINKING, Schema.optional(StreamingTextDataSchema)),
  arm(MESSAGE_TYPES.SCRATCHPAD, Schema.optional(StreamingTextDataSchema)),
  arm(MESSAGE_TYPES.FILE_LIST, Schema.Array(FileListEntrySchema)),
  // Passthrough: a tool's extra fields (e.g. `files`) are forwarded as-is.
  arm(
    MESSAGE_TYPES.TOOL_USE,
    Schema.StructWithRest(ToolUseLogSchema, [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
  arm(MESSAGE_TYPES.WEB_SEARCH, WebSearchPayloadSchema),
  arm(MESSAGE_TYPES.MODEL_RESPONSE, Schema.optional(StreamingTextDataSchema)),
  arm(MESSAGE_TYPES.USER_MESSAGE, Schema.optional(UserMessagePayloadSchema)),
  arm(MESSAGE_TYPES.PROGRESS_STATUS, Schema.optional(Schema.Unknown)),
  arm(MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY, CompactionActivityDataSchema),
  arm(MESSAGE_TYPES.ERROR, Schema.optional(ErrorLogDataSchema)),
  arm(MESSAGE_TYPES.CONTEXT_MANAGEMENT, ContextManagementDataSchema),
  arm(MESSAGE_TYPES.DEFAULT, Schema.optional(Schema.Unknown)),
]);

/** A decoded `log` row payload, discriminated by its message type. */
export type LogPayload = typeof LogPayloadSchema.Type;

const decodeLogPayloadArm = Schema.decodeUnknownResult(LogPayloadSchema);

/**
 * Decode one `log` row payload, or name the schema's objection. The
 * parameter takes the union's own message types, so a `MESSAGE_TYPES` entry
 * without an arm fails to compile at the fold that calls this.
 */
export function decodeLogPayload(
  messageType: LogPayload['messageType'],
  data: unknown,
): { readonly payload: LogPayload } | { readonly issue: string } {
  // An error row is read strictly; see ErrorLogDataSchema.
  const parsed = decodeLogPayloadArm(
    { messageType, data },
    messageType === MESSAGE_TYPES.ERROR
      ? { onExcessProperty: 'error' }
      : undefined,
  );
  return Result.isSuccess(parsed)
    ? { payload: parsed.success }
    : { issue: parsed.failure.message };
}
