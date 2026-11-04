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
import { DeclinableUsageRouteSchema } from './usage';

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
  // A status note is its message alone (`logProgressStatus`).
  [MESSAGE_TYPES.PROGRESS_STATUS]: Schema.Undefined,
  // A used-up plan's automatic retry on the model's own key: the route the
  // run declined. The row's message is the harness's plain wording; an app
  // words the route itself.
  [MESSAGE_TYPES.QUOTA_FALLBACK]: Schema.Struct({
    route: DeclinableUsageRouteSchema,
  }),
  [MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY]: CompactionActivityDataSchema,
  [MESSAGE_TYPES.ERROR]: Schema.optional(ErrorLogDataSchema),
  [MESSAGE_TYPES.CONTEXT_MANAGEMENT]: ContextManagementDataSchema,
  [MESSAGE_TYPES.DEFAULT]: Schema.optional(Schema.Unknown),
} satisfies Record<MessageType, Schema.Top>;

/** The decoded `log` row payload for message type `K`. */
type LogPayloadOf<K extends MessageType> = {
  readonly messageType: K;
  readonly data: (typeof LOG_PAYLOAD_SCHEMAS)[K]['Type'];
};

/** A decoded `log` row payload, discriminated by its message type. */
export type LogPayload = { [K in MessageType]: LogPayloadOf<K> }[MessageType];

/** Decode one `log` row payload, or name the schema's objection. */
export function decodeLogPayload<K extends MessageType>(
  messageType: K,
  data: unknown,
):
  | { readonly payload: { [P in K]: LogPayloadOf<P> }[K] }
  | { readonly issue: string } {
  // An error row is read strictly; see ErrorLogDataSchema.
  const parsed = Schema.decodeUnknownResult(LOG_PAYLOAD_SCHEMAS[messageType])(
    data,
    messageType === MESSAGE_TYPES.ERROR
      ? { onExcessProperty: 'error' }
      : undefined,
  );
  if (Result.isFailure(parsed)) return { issue: parsed.failure.message };
  const payload: LogPayloadOf<K> = { messageType, data: parsed.success };
  return { payload };
}
