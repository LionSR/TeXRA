/**
 * How the app's bridges answer a request: the runtime's own errors, and the
 * two only a bridge raises. A request the bridge could not parse never
 * reached the runtime, and a handler that died has its cause in the host's
 * log, not on the wire.
 */
import { Schema } from 'effect';

import { RequestErrorSchema } from '@texra-ai/harness/schemas';

/** The request could not be parsed. */
export class Invalid extends Schema.TaggedError<Invalid>()('Invalid', {
  reason: Schema.String,
}) {}

/** A handler died. The cause is in the host log under `ref` (the request
 *  id); the surface hears that the request failed, never the text. */
export class Internal extends Schema.TaggedError<Internal>()('Internal', {
  ref: Schema.String,
}) {}

/** A request's failure as a bridge answers it: the classes themselves. */
export const BridgeErrorSchema = RequestErrorSchema.mapMembers((members) => [
  ...members,
  Invalid,
  Internal,
]);
export type BridgeError = typeof BridgeErrorSchema.Type;
