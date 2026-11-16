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
} from './toolCard';
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
  // A status note is its message alone: no payload can reach the transcript.
  [MESSAGE_TYPES.PROGRESS_STATUS]: Schema.Undefined,
  [MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY]: CompactionActivityDataSchema,
  [MESSAGE_TYPES.ERROR]: Schema.optional(ErrorLogDataSchema),
  [MESSAGE_TYPES.CONTEXT_MANAGEMENT]: ContextManagementDataSchema,
  [MESSAGE_TYPES.DEFAULT]: Schema.optional(Schema.Unknown),
} satisfies Record<MessageType, Schema.Top>;

/** What a producer writes for message type `K`: the payload its schema
 *  decodes, required unless the schema admits none. */
type LogWriteOf<K extends MessageType> =
  undefined extends (typeof LOG_PAYLOAD_SCHEMAS)[K]['Encoded']
    ? {
        readonly messageType: K;
        readonly data?: (typeof LOG_PAYLOAD_SCHEMAS)[K]['Encoded'];
      }
    : {
        readonly messageType: K;
        readonly data: (typeof LOG_PAYLOAD_SCHEMAS)[K]['Encoded'];
      };

/**
 * What a trace's log methods take: a row's category (subscribers pick a
 * render style from it) with the payload the transcript decodes for it,
 * so a pairing is checked where it is written; or no category, a default
 * row with any data. The row stores the payload as JSON; a `Cause` stores
 * as the error it raised.
 */
export type LogOptions =
  | { readonly messageType?: undefined; readonly data?: unknown }
  | { [K in MessageType]: LogWriteOf<K> }[MessageType];

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
