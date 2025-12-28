/**
 * Anthropic stream normalizer.
 *
 * Converts Anthropic's BetaMessageStream events to unified StreamEvents.
 * Uses the SDK's native AsyncIterable support for clean iteration.
 *
 * Key behaviors:
 * - Thinking blocks: Yields separate thinking events with blockIndex for interleaving
 * - Text blocks: Yields content events with blockIndex for consecutive merging
 * - Web search: Accumulates input JSON, yields when results arrive
 * - Tool calls: Yields tool_call_* events for streaming tool arguments
 */

import { extractDomain } from '@agent/modelHandlers/types/ServerToolTypes';

import type {
  BetaRawMessageStreamEvent,
  BetaMessage,
  BetaContentBlock,
} from '@anthropic-ai/sdk/resources/beta/messages';
import type {
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebSearchResultBlock,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';

import type {
  StreamEvent,
  NormalizedResponse,
  NormalizedStopReason,
} from '../streamEventSchema';
import type {
  NormalizerOptions,
  AnthropicNormalizerState,
  WebSearchResultEntry,
} from '../types';

/**
 * Duck-typed interface for Anthropic message streams.
 * The SDK's MessageStream implements AsyncIterable<BetaRawMessageStreamEvent>.
 */
export interface AnthropicMessageStream extends AsyncIterable<BetaRawMessageStreamEvent> {
  /** Get the final aggregated message after streaming completes */
  finalMessage(): Promise<BetaMessage>;
}

/**
 * Maximum size for accumulated search input JSON (64KB).
 * Prevents memory growth for very long queries.
 */
const MAX_SEARCH_INPUT_SIZE = 65536;

/**
 * Create initial normalizer state.
 */
function createInitialState(): AnthropicNormalizerState {
  return {
    lastBlockIndex: -1,
    currentThinkingIndex: null,
    currentTextBlockIndex: null,
    pendingSearches: new Map(),
    emittedSearchIds: new Set(),
    thinkingBuffer: '',
    contentBuffer: '',
  };
}

/**
 * Normalize Anthropic stop reason to unified stop reason.
 */
function normalizeStopReason(
  stopReason: BetaMessage['stop_reason'],
): NormalizedStopReason {
  switch (stopReason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'max_tokens';
    case 'tool_use':
      return 'tool_use';
    case 'stop_sequence':
      return 'stop';
    default:
      return 'unknown';
  }
}

/**
 * Parse search query from accumulated input JSON.
 */
function parseSearchQuery(input: string | undefined): string {
  if (!input) {
    return '';
  }

  try {
    const parsed = JSON.parse(input) as { query?: string };
    return parsed.query ?? '';
  } catch {
    // Partial JSON (common for streaming), try to extract query with regex
    const match = input.match(/"query"\s*:\s*"([^"]+)"/);
    return match?.[1] ?? '';
  }
}

/**
 * Extract search results from a web_search_tool_result block.
 */
function extractSearchResults(
  block: WebSearchToolResultBlock,
): WebSearchResultEntry[] {
  const entries: WebSearchResultEntry[] = [];

  if (Array.isArray(block.content)) {
    for (const item of block.content) {
      const r = item as WebSearchResultBlock;
      if (r.type === 'web_search_result' && r.url) {
        entries.push({
          url: r.url,
          title: r.title,
          snippet: r.encrypted_content,
          pageAge: r.page_age ?? undefined,
          domain: extractDomain(r.url),
        });
      }
    }
  }

  return entries;
}

/**
 * Extract tool calls from final message.
 */
function extractToolCalls(
  message: BetaMessage,
): Array<{ id: string; name: string; arguments: string }> {
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  for (const block of message.content) {
    if (block.type === 'tool_use') {
      const toolBlock = block as ToolUseBlock;
      toolCalls.push({
        id: toolBlock.id,
        name: toolBlock.name,
        arguments: JSON.stringify(toolBlock.input),
      });
    }
  }

  return toolCalls;
}

/**
 * Extract final text from message content blocks.
 */
function extractFinalText(content: BetaContentBlock[]): string {
  const textParts: string[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    }
  }

  return textParts.join('');
}

/**
 * Extract thinking text from message content blocks.
 */
function extractThinkingText(content: BetaContentBlock[]): string | undefined {
  const thinkingParts: string[] = [];

  for (const block of content) {
    if (block.type === 'thinking') {
      thinkingParts.push(block.thinking);
    }
  }

  return thinkingParts.length > 0 ? thinkingParts.join('\n\n') : undefined;
}

/**
 * Handle content_block_start events.
 */
function* handleBlockStart(
  event: Extract<BetaRawMessageStreamEvent, { type: 'content_block_start' }>,
  state: AnthropicNormalizerState,
  _options: NormalizerOptions,
): Generator<StreamEvent> {
  const blockType = event.content_block.type;
  const blockIndex = event.index;

  if (blockType === 'thinking') {
    // Track new thinking block
    state.currentThinkingIndex = blockIndex;
    // Reset text block tracking when thinking starts
    state.currentTextBlockIndex = null;
  } else if (blockType === 'text') {
    // Track new text block
    state.currentTextBlockIndex = blockIndex;
    // Reset thinking when text starts (if not consecutive)
    state.currentThinkingIndex = null;
  } else if (blockType === 'server_tool_use') {
    // Track web search server tool use
    const block = event.content_block as ServerToolUseBlock;
    if (block.name === 'web_search') {
      state.pendingSearches.set(block.id, {
        index: blockIndex,
        input: '',
      });
    }
    // Reset block tracking
    state.currentThinkingIndex = null;
    state.currentTextBlockIndex = null;
  } else if (blockType === 'web_search_tool_result') {
    // Handle web search result
    const resultBlock = event.content_block as WebSearchToolResultBlock;
    const searchData = state.pendingSearches.get(resultBlock.tool_use_id);
    const query = parseSearchQuery(searchData?.input);
    const entries = extractSearchResults(resultBlock);

    if (entries.length > 0 || query) {
      yield {
        type: 'web_search',
        callId: resultBlock.tool_use_id,
        query,
        results: entries,
        status: 'completed',
        provider: 'anthropic',
      };
      state.emittedSearchIds.add(resultBlock.tool_use_id);
    }

    state.pendingSearches.delete(resultBlock.tool_use_id);
    state.currentThinkingIndex = null;
    state.currentTextBlockIndex = null;
  } else if (blockType === 'tool_use') {
    // Start of a tool call
    const toolBlock = event.content_block as ToolUseBlock;
    yield {
      type: 'tool_call_start',
      id: toolBlock.id,
      name: toolBlock.name,
    };
    state.currentThinkingIndex = null;
    state.currentTextBlockIndex = null;
  }

  state.lastBlockIndex = blockIndex;
}

/**
 * Handle content_block_delta events.
 */
function* handleBlockDelta(
  event: Extract<BetaRawMessageStreamEvent, { type: 'content_block_delta' }>,
  state: AnthropicNormalizerState,
  options: NormalizerOptions,
): Generator<StreamEvent> {
  const { delta } = event;

  if (delta.type === 'thinking_delta') {
    state.thinkingBuffer += delta.thinking;
    yield {
      type: 'thinking',
      delta: delta.thinking,
      blockIndex: event.index,
    };
  } else if (delta.type === 'text_delta') {
    if (options.outputEnabled !== false) {
      state.contentBuffer += delta.text;
      yield {
        type: 'content',
        delta: delta.text,
        blockIndex: event.index,
      };
    }
  } else if (delta.type === 'input_json_delta') {
    // Accumulate input JSON for web search or tool calls
    for (const [toolId, searchData] of state.pendingSearches) {
      if (searchData.index === event.index) {
        // Apply size limit to prevent memory growth
        if (searchData.input.length < MAX_SEARCH_INPUT_SIZE) {
          const remaining = MAX_SEARCH_INPUT_SIZE - searchData.input.length;
          searchData.input += delta.partial_json.slice(0, remaining);
        }

        // Also emit as tool_call_delta for tool calls
        yield {
          type: 'tool_call_delta',
          id: toolId,
          arguments: delta.partial_json,
        };
        break;
      }
    }
  }
}

/**
 * Handle content_block_stop events.
 * Updates state but doesn't yield events (block completion is implicit).
 */
function handleBlockStop(
  event: Extract<BetaRawMessageStreamEvent, { type: 'content_block_stop' }>,
  state: AnthropicNormalizerState,
): void {
  // Reset tracking if this was the active block
  if (state.currentThinkingIndex === event.index) {
    state.currentThinkingIndex = null;
  }
  // Note: Don't reset currentTextBlockIndex - might be followed by consecutive text block
}

/**
 * Normalize Anthropic stream to unified events.
 *
 * @param stream - Anthropic message stream (implements AsyncIterable)
 * @param options - Normalizer options
 * @returns Async generator of normalized stream events
 */
export async function* normalizeAnthropicStream(
  stream: AnthropicMessageStream,
  options: NormalizerOptions = {},
): AsyncGenerator<StreamEvent> {
  const state = createInitialState();
  const startTime = options.startTime ?? Date.now();

  // Process streaming events using SDK's native AsyncIterable
  for await (const event of stream) {
    if (event.type === 'content_block_start') {
      yield* handleBlockStart(event, state, options);
    } else if (event.type === 'content_block_delta') {
      yield* handleBlockDelta(event, state, options);
    } else if (event.type === 'content_block_stop') {
      handleBlockStop(event, state);
    }
    // message_start, message_delta, message_stop are handled by finalMessage()
  }

  // Get the final aggregated message
  const finalMessage = await stream.finalMessage();
  const responseTimeMs = Date.now() - startTime;

  // Extract tool calls from final message
  const toolCalls = extractToolCalls(finalMessage);

  // Emit tool_call_done for each tool call
  for (const toolCall of toolCalls) {
    yield {
      type: 'tool_call_done',
      id: toolCall.id,
    };
  }

  // Build normalized response
  const response: NormalizedResponse = {
    text: extractFinalText(finalMessage.content),
    thinking: extractThinkingText(finalMessage.content),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason: normalizeStopReason(finalMessage.stop_reason),
    usage: finalMessage.usage
      ? {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
          cost: 0, // Will be calculated by caller
          responseTimeMs,
          provider: 'anthropic',
          cachedInputTokens:
            finalMessage.usage.cache_read_input_tokens ?? undefined,
          cacheCreationTokens:
            finalMessage.usage.cache_creation_input_tokens ?? undefined,
        }
      : undefined,
    raw: finalMessage,
  };

  // Emit usage event if available
  if (response.usage) {
    yield {
      type: 'usage',
      usage: response.usage,
    };
  }

  // Emit done event
  yield {
    type: 'done',
    response,
  };
}

/**
 * Get the set of emitted search IDs from the normalizer state.
 * Useful for deduplication when also extracting from final response.
 */
export function getEmittedSearchIds(
  state: AnthropicNormalizerState,
): Set<string> {
  return state.emittedSearchIds;
}
