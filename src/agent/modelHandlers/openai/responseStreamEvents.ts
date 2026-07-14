// Stateless type guards and helpers for OpenAI Responses API streaming events.
//
// These are pure functions over the SDK's discriminated-union event/item types.
// They carry no handler state, so they live outside `ModelHandlerOpenAIResponse`
// and are shared by the WebSocket transport, the HTTP streaming loop, and the
// stream processor.

import type {
  ResponseOutputItem,
  ResponseFunctionToolCallItem,
  ResponseFunctionWebSearch,
  ResponseStreamEvent,
  ResponseTextDeltaEvent,
  ResponseReasoningTextDeltaEvent,
  ResponseReasoningSummaryTextDeltaEvent,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseWebSearchCallInProgressEvent,
  ResponseFunctionCallArgumentsDoneEvent,
} from 'openai/resources/responses/responses';

/** Type guard for function-call output items. */
export function isResponseFunctionToolCallItem(
  item: unknown,
): item is ResponseFunctionToolCallItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'function_call'
  );
}

/** Type guard for reasoning delta events (both raw and summary). */
export function isReasoningDeltaEvent(
  event: ResponseStreamEvent,
): event is
  ResponseReasoningTextDeltaEvent | ResponseReasoningSummaryTextDeltaEvent {
  return (
    event.type === 'response.reasoning_text.delta' ||
    event.type === 'response.reasoning_summary_text.delta'
  );
}

/**
 * Type guard for the start of a reasoning output item. This fires even when
 * no reasoning summary text will ever stream (e.g. gpt-5 with summaries
 * disabled), so it is the reliable "model started thinking" signal.
 */
export function isReasoningItemAddedEvent(
  event: ResponseStreamEvent,
): event is ResponseOutputItemAddedEvent {
  return (
    event.type === 'response.output_item.added' &&
    event.item.type === 'reasoning'
  );
}

/** Type guard for web search in_progress events. */
export function isWebSearchInProgressEvent(
  event: ResponseStreamEvent,
): event is ResponseWebSearchCallInProgressEvent {
  return event.type === 'response.web_search_call.in_progress';
}

/** Type guard for text output delta events. */
export function isTextDeltaEvent(
  event: ResponseStreamEvent,
): event is ResponseTextDeltaEvent {
  return event.type === 'response.output_text.delta';
}

/** Type guard for output item done events. */
export function isOutputItemDoneEvent(
  event: ResponseStreamEvent,
): event is ResponseOutputItemDoneEvent {
  return event.type === 'response.output_item.done';
}

/** Type guard for function call arguments done events. */
export function isFunctionCallArgumentsDoneEvent(
  event: ResponseStreamEvent,
): event is ResponseFunctionCallArgumentsDoneEvent {
  return event.type === 'response.function_call_arguments.done';
}

/** Type guard for web search output items. */
export function isWebSearchItem(
  item: ResponseOutputItem,
): item is ResponseFunctionWebSearch {
  return item.type === 'web_search_call';
}

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
