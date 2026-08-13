// Stateless type guards and helpers for OpenAI Responses API streaming events.
//
// These are pure functions over the SDK's discriminated-union event/item types
// that a plain `type` comparison cannot express: narrowing an `unknown` item,
// and reading a field only some event variants declare. Everything that is a
// straight discriminant check is written inline at its use site.

import type { ResponseStreamEvent } from 'openai/resources/responses/responses';

/**
 * Extract the `response_id` an event belongs to, when present. Used to filter
 * events by request on a reused WebSocket connection.
 */
export function getStreamEventResponseId(
  event: ResponseStreamEvent,
): string | undefined {
  return 'response_id' in event && typeof event.response_id === 'string'
    ? event.response_id
    : undefined;
}
