/**
 * OpenAI Response API stream normalizer.
 *
 * Converts OpenAI's Response API streaming events to unified StreamEvents.
 * The Response API uses a different event structure than the Chat Completions API.
 *
 * Key behaviors:
 * - Thinking: From response.reasoning_text.delta and response.reasoning_summary_text.delta
 * - Content: From response.output_text.delta
 * - Web search: From response.web_search_call.in_progress and response.output_item.done
 * - Tool calls: From output items in final response
 *
 * Note: This API supports interleaved thinking and web search (think → search → think)
 */

import type {
  ResponseStreamEvent,
  ResponseTextDeltaEvent,
  ResponseReasoningTextDeltaEvent,
  ResponseReasoningSummaryTextDeltaEvent,
  ResponseOutputItemDoneEvent,
  ResponseWebSearchCallInProgressEvent,
  ResponseOutputItem,
  ResponseFunctionWebSearch,
  Response,
} from 'openai/resources/responses/responses';

import {
  extractDomain,
  buildOpenAIWebSearchResult,
  hasOpenAIWebSearchData,
} from '@agent/modelHandlers/types/ServerToolTypes';

import type {
  StreamEvent,
  NormalizedResponse,
  NormalizedStopReason,
} from '../streamEventSchema';
import type { NormalizerOptions, OpenAIResponseNormalizerState } from '../types';

/**
 * Duck-typed interface for OpenAI Response streams.
 * The SDK's ResponseStream implements AsyncIterable<ResponseStreamEvent>.
 */
export interface OpenAIResponseStream
  extends AsyncIterable<ResponseStreamEvent> {
  /** Get the final aggregated response after streaming completes */
  finalResponse(): Promise<Response>;
}

/**
 * Create initial normalizer state.
 */
function createInitialState(): OpenAIResponseNormalizerState {
  return {
    hasThinkingContent: false,
    emittedWebSearchIds: new Set(),
    thinkingBuffer: '',
    contentBuffer: '',
  };
}

/**
 * Type guard for reasoning delta events (both raw and summary).
 */
function isReasoningDeltaEvent(
  event: ResponseStreamEvent,
): event is ResponseReasoningTextDeltaEvent | ResponseReasoningSummaryTextDeltaEvent {
  return (
    event.type === 'response.reasoning_text.delta' ||
    event.type === 'response.reasoning_summary_text.delta'
  );
}

/**
 * Type guard for text output delta events.
 */
function isTextDeltaEvent(
  event: ResponseStreamEvent,
): event is ResponseTextDeltaEvent {
  return event.type === 'response.output_text.delta';
}

/**
 * Type guard for web search in_progress events.
 */
function isWebSearchInProgressEvent(
  event: ResponseStreamEvent,
): event is ResponseWebSearchCallInProgressEvent {
  return event.type === 'response.web_search_call.in_progress';
}

/**
 * Type guard for output item done events.
 */
function isOutputItemDoneEvent(
  event: ResponseStreamEvent,
): event is ResponseOutputItemDoneEvent {
  return event.type === 'response.output_item.done';
}

/**
 * Type guard for web search output items.
 */
function isWebSearchItem(item: ResponseOutputItem): item is ResponseFunctionWebSearch {
  return item.type === 'web_search_call';
}

/**
 * Normalize OpenAI Response status to unified stop reason.
 */
function normalizeStopReason(status: string | undefined): NormalizedStopReason {
  switch (status) {
    case 'completed':
      return 'stop';
    case 'incomplete':
      return 'max_tokens';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'stop';
    default:
      return 'unknown';
  }
}

/**
 * Process a single streaming event and yield normalized events.
 */
function* processEvent(
  event: ResponseStreamEvent,
  state: OpenAIResponseNormalizerState,
  options: NormalizerOptions,
): Generator<StreamEvent> {
  if (isReasoningDeltaEvent(event)) {
    state.thinkingBuffer += event.delta;
    state.hasThinkingContent = true;
    yield {
      type: 'thinking',
      delta: event.delta,
    };
  } else if (isTextDeltaEvent(event)) {
    if (options.outputEnabled !== false) {
      state.contentBuffer += event.delta;
      yield {
        type: 'content',
        delta: event.delta,
      };
    }
  } else if (isWebSearchInProgressEvent(event)) {
    // Web search starting - this is just a signal, data comes in output_item.done
    // We yield a status event to indicate search is in progress
    yield {
      type: 'web_search',
      callId: event.item_id,
      query: '', // Query is not available at this point
      results: [],
      status: 'in_progress',
      provider: 'openai',
    };
  } else if (isOutputItemDoneEvent(event)) {
    const item = event.item;
    if (
      isWebSearchItem(item) &&
      !state.emittedWebSearchIds.has(item.id) &&
      hasOpenAIWebSearchData(item)
    ) {
      const searchResult = buildOpenAIWebSearchResult(item);
      yield {
        type: 'web_search',
        callId: item.id,
        query: searchResult.query,
        results: searchResult.results.map((r) => ({
          url: r.url,
          title: r.title,
          snippet: r.snippet,
          domain: extractDomain(r.url),
        })),
        status: 'completed',
        provider: 'openai',
      };
      state.emittedWebSearchIds.add(item.id);
    }
  }
}

/**
 * Extract text content from Response output.
 */
function extractTextFromResponse(response: Response): string {
  const textParts: string[] = [];
  const output = response.output;

  if (!Array.isArray(output)) {
    return '';
  }

  for (const item of output) {
    if (item.type === 'message') {
      const content = item.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'output_text' && part.text) {
            textParts.push(part.text);
          }
        }
      }
    }
  }

  return textParts.join('');
}

/**
 * Extract thinking content from Response output.
 */
function extractThinkingFromResponse(response: Response): string | undefined {
  const thinkingParts: string[] = [];
  const output = response.output;

  if (!Array.isArray(output)) {
    return undefined;
  }

  for (const item of output) {
    if (item.type === 'reasoning') {
      // Handle reasoning items (text array)
      const summary = (item as { summary?: { text?: string }[] }).summary;
      if (Array.isArray(summary)) {
        for (const part of summary) {
          if (part.text) {
            thinkingParts.push(part.text);
          }
        }
      }
    }
  }

  return thinkingParts.length > 0 ? thinkingParts.join('\n\n') : undefined;
}

/**
 * Extract tool calls from Response output.
 */
function extractToolCalls(
  response: Response,
): Array<{ id: string; name: string; arguments: string }> {
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  const output = response.output;

  if (!Array.isArray(output)) {
    return toolCalls;
  }

  for (const item of output) {
    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? item.id,
        name: item.name ?? 'unknown',
        arguments: item.arguments ?? '{}',
      });
    }
  }

  return toolCalls;
}

/**
 * Normalize OpenAI Response stream to unified events.
 *
 * @param stream - OpenAI Response stream (implements AsyncIterable)
 * @param options - Normalizer options
 * @returns Async generator of normalized stream events
 */
export async function* normalizeOpenAIResponseStream(
  stream: OpenAIResponseStream,
  options: NormalizerOptions = {},
): AsyncGenerator<StreamEvent> {
  const state = createInitialState();
  const startTime = options.startTime ?? Date.now();

  // Process streaming events
  for await (const event of stream) {
    yield* processEvent(event, state, options);
  }

  // Get the final response
  const response = await stream.finalResponse();
  const responseTimeMs = Date.now() - startTime;

  // Emit any web searches not yet emitted (fallback for edge cases)
  const output = response.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (
        isWebSearchItem(item) &&
        !state.emittedWebSearchIds.has(item.id) &&
        hasOpenAIWebSearchData(item)
      ) {
        const searchResult = buildOpenAIWebSearchResult(item);
        yield {
          type: 'web_search',
          callId: item.id,
          query: searchResult.query,
          results: searchResult.results.map((r) => ({
            url: r.url,
            title: r.title,
            snippet: r.snippet,
            domain: extractDomain(r.url),
          })),
          status: 'completed',
          provider: 'openai',
        };
        state.emittedWebSearchIds.add(item.id);
      }
    }
  }

  // Extract tool calls from final response
  const toolCalls = extractToolCalls(response);

  // Emit tool_call_done for each tool call
  for (const toolCall of toolCalls) {
    yield {
      type: 'tool_call_start',
      id: toolCall.id,
      name: toolCall.name,
    };
    yield {
      type: 'tool_call_delta',
      id: toolCall.id,
      arguments: toolCall.arguments,
    };
    yield {
      type: 'tool_call_done',
      id: toolCall.id,
    };
  }

  // Build normalized response
  const finalText = extractTextFromResponse(response) || state.contentBuffer;
  const finalThinking = extractThinkingFromResponse(response) || state.thinkingBuffer || undefined;

  const usage = response.usage;
  const normalizedResponse: NormalizedResponse = {
    text: finalText,
    thinking: finalThinking,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason: normalizeStopReason(response.status),
    usage: usage
      ? {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cost: 0, // Will be calculated by caller
          responseTimeMs,
          provider: options.provider ?? 'openai-response',
          reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? undefined,
        }
      : undefined,
    raw: response,
  };

  // Emit usage event if available
  if (normalizedResponse.usage) {
    yield {
      type: 'usage',
      usage: normalizedResponse.usage,
    };
  }

  // Emit done event
  yield {
    type: 'done',
    response: normalizedResponse,
  };
}
