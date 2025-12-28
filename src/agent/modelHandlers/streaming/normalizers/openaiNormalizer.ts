/**
 * OpenAI stream normalizer.
 *
 * Converts OpenAI's ChatCompletionStream events to unified StreamEvents.
 * Uses the SDK's native AsyncIterable support for clean iteration.
 *
 * Key behaviors:
 * - Content: Yields content events from ChatCompletionChunk
 * - Reasoning: Yields thinking events from reasoning_content field
 * - Tool calls: Reconstructs from indexed fragments, yields tool_call_* events
 * - Usage: Captured from final chunk or stream.totalUsage()
 */

import type {
  ChatCompletion,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions';

import type {
  StreamEvent,
  NormalizedResponse,
  NormalizedStopReason,
} from '../streamEventSchema';
import type { NormalizerOptions, OpenAINormalizerState } from '../types';

/**
 * Duck-typed interface for OpenAI chat completion streams.
 * The SDK's ChatCompletionStream implements AsyncIterable<ChatCompletionChunk>.
 */
export interface OpenAIChatCompletionStream
  extends AsyncIterable<ChatCompletionChunk> {
  /** Get the final aggregated completion after streaming completes */
  finalChatCompletion(): Promise<ChatCompletion>;
  /** Get total usage across all chunks (may fail if stream ended abnormally) */
  totalUsage(): Promise<ChatCompletion['usage']>;
}

/**
 * Reasoning content type for DeepSeek, o1 models (not in SDK types).
 */
type ReasoningContent = string | Array<{ type: string; text?: string }>;

/**
 * Extended delta type with reasoning_content field.
 */
interface DeltaWithReasoning {
  content?: string | null;
  reasoning_content?: ReasoningContent;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

/**
 * Create initial normalizer state.
 */
function createInitialState(): OpenAINormalizerState {
  return {
    toolCalls: new Map(),
    thinkingBuffer: '',
    contentBuffer: '',
    hasChunks: false,
  };
}

/**
 * Extract reasoning text from reasoning_content field.
 */
function extractReasoningText(content: ReasoningContent | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map((item) => item.text ?? '').join('');
}

/**
 * Extract reasoning delta from a chunk.
 */
function extractReasoningDelta(chunk: ChatCompletionChunk): string {
  const choice = chunk.choices[0];
  if (!choice) return '';

  const delta = choice.delta as DeltaWithReasoning;
  if (!('reasoning_content' in delta)) return '';

  return extractReasoningText(delta.reasoning_content);
}

/**
 * Normalize OpenAI finish reason to unified stop reason.
 */
function normalizeStopReason(
  finishReason: string | null | undefined,
): NormalizedStopReason {
  switch (finishReason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

/**
 * Process a single chunk and yield normalized events.
 */
function* processChunk(
  chunk: ChatCompletionChunk,
  state: OpenAINormalizerState,
  options: NormalizerOptions,
): Generator<StreamEvent> {
  state.hasChunks = true;
  const choice = chunk.choices[0];
  if (!choice) return;

  const delta = choice.delta as DeltaWithReasoning;

  // Handle reasoning/thinking content
  const reasoningDelta = extractReasoningDelta(chunk);
  if (reasoningDelta) {
    state.thinkingBuffer += reasoningDelta;
    yield {
      type: 'thinking',
      delta: reasoningDelta,
    };
  }

  // Handle content
  if (delta.content && options.outputEnabled !== false) {
    state.contentBuffer += delta.content;
    yield {
      type: 'content',
      delta: delta.content,
    };
  }

  // Handle tool calls (indexed fragments)
  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      const index = toolCall.index;
      const existing = state.toolCalls.get(index);

      // New tool call starting
      if (!existing && toolCall.id && toolCall.function?.name) {
        state.toolCalls.set(index, {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments ?? '',
        });

        yield {
          type: 'tool_call_start',
          id: toolCall.id,
          name: toolCall.function.name,
          index,
        };
      }

      // Tool call argument fragment
      if (toolCall.function?.arguments) {
        const tc = state.toolCalls.get(index);
        if (tc) {
          tc.arguments += toolCall.function.arguments;
          yield {
            type: 'tool_call_delta',
            id: tc.id,
            arguments: toolCall.function.arguments,
          };
        }
      }
    }
  }
}

/**
 * Extract final text from ChatCompletion message.
 */
function extractFinalText(completion: ChatCompletion): string {
  const message = completion.choices[0]?.message;
  return message?.content ?? '';
}

/**
 * Extract thinking text from ChatCompletion message.
 */
function extractThinkingText(completion: ChatCompletion): string | undefined {
  const message = completion.choices[0]?.message as {
    reasoning_content?: ReasoningContent;
  };
  const reasoning = extractReasoningText(message?.reasoning_content);
  return reasoning || undefined;
}

/**
 * Normalize OpenAI stream to unified events.
 *
 * @param stream - OpenAI chat completion stream (implements AsyncIterable)
 * @param options - Normalizer options
 * @returns Async generator of normalized stream events
 */
export async function* normalizeOpenAIStream(
  stream: OpenAIChatCompletionStream,
  options: NormalizerOptions = {},
): AsyncGenerator<StreamEvent> {
  const state = createInitialState();
  const startTime = options.startTime ?? Date.now();

  // Process streaming chunks using SDK's native AsyncIterable
  for await (const chunk of stream) {
    yield* processChunk(chunk, state, options);
  }

  // Get the final aggregated completion
  const finalCompletion = await stream.finalChatCompletion();
  const responseTimeMs = Date.now() - startTime;

  // Emit tool_call_done for each tool call
  for (const [, toolCall] of state.toolCalls) {
    yield {
      type: 'tool_call_done',
      id: toolCall.id,
    };
  }

  // Get usage (with fallback to stream.totalUsage())
  let usage = finalCompletion.usage;
  if (!usage) {
    try {
      usage = await stream.totalUsage();
    } catch {
      // totalUsage() may fail if stream ended abnormally
    }
  }

  // Build tool calls array from state
  const toolCalls = Array.from(state.toolCalls.values()).map((tc) => ({
    id: tc.id,
    name: tc.name,
    arguments: tc.arguments,
  }));

  // Build normalized response
  const response: NormalizedResponse = {
    text: extractFinalText(finalCompletion) || state.contentBuffer,
    thinking: extractThinkingText(finalCompletion) || state.thinkingBuffer || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason: normalizeStopReason(
      finalCompletion.choices[0]?.finish_reason,
    ),
    usage: usage
      ? {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          cost: 0, // Will be calculated by caller
          responseTimeMs,
          provider: options.provider ?? 'openai',
        }
      : undefined,
    raw: finalCompletion,
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
 * Reasoning extractor hook type.
 * Allows subclasses to customize reasoning extraction (e.g., Kimi, DeepSeek).
 */
export type ReasoningExtractor = (chunk: ChatCompletionChunk) => string;

/**
 * Default reasoning extractor using reasoning_content field.
 */
export const defaultReasoningExtractor: ReasoningExtractor =
  extractReasoningDelta;

/**
 * Normalize OpenAI stream with custom reasoning extractor.
 *
 * This variant allows subclasses to provide custom reasoning extraction
 * for providers that use different field names or formats.
 *
 * @param stream - OpenAI chat completion stream
 * @param options - Normalizer options
 * @param reasoningExtractor - Custom function to extract reasoning from chunks
 * @returns Async generator of normalized stream events
 */
export async function* normalizeOpenAIStreamWithCustomExtractor(
  stream: OpenAIChatCompletionStream,
  options: NormalizerOptions = {},
  reasoningExtractor: ReasoningExtractor = defaultReasoningExtractor,
): AsyncGenerator<StreamEvent> {
  const state = createInitialState();
  const startTime = options.startTime ?? Date.now();

  // Process streaming chunks
  for await (const chunk of stream) {
    state.hasChunks = true;
    const choice = chunk.choices[0];
    if (!choice) continue;

    const delta = choice.delta as DeltaWithReasoning;

    // Handle reasoning with custom extractor
    const reasoningDelta = reasoningExtractor(chunk);
    if (reasoningDelta) {
      state.thinkingBuffer += reasoningDelta;
      yield {
        type: 'thinking',
        delta: reasoningDelta,
      };
    }

    // Handle content
    if (delta.content && options.outputEnabled !== false) {
      state.contentBuffer += delta.content;
      yield {
        type: 'content',
        delta: delta.content,
      };
    }

    // Handle tool calls (same logic as processChunk)
    if (delta.tool_calls) {
      for (const toolCall of delta.tool_calls) {
        const index = toolCall.index;
        const existing = state.toolCalls.get(index);

        if (!existing && toolCall.id && toolCall.function?.name) {
          state.toolCalls.set(index, {
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments ?? '',
          });

          yield {
            type: 'tool_call_start',
            id: toolCall.id,
            name: toolCall.function.name,
            index,
          };
        }

        if (toolCall.function?.arguments) {
          const tc = state.toolCalls.get(index);
          if (tc) {
            tc.arguments += toolCall.function.arguments;
            yield {
              type: 'tool_call_delta',
              id: tc.id,
              arguments: toolCall.function.arguments,
            };
          }
        }
      }
    }
  }

  // Final completion and events (same as normalizeOpenAIStream)
  const finalCompletion = await stream.finalChatCompletion();
  const responseTimeMs = Date.now() - startTime;

  for (const [, toolCall] of state.toolCalls) {
    yield { type: 'tool_call_done', id: toolCall.id };
  }

  let usage = finalCompletion.usage;
  if (!usage) {
    try {
      usage = await stream.totalUsage();
    } catch {
      // Ignore
    }
  }

  const toolCalls = Array.from(state.toolCalls.values()).map((tc) => ({
    id: tc.id,
    name: tc.name,
    arguments: tc.arguments,
  }));

  const response: NormalizedResponse = {
    text: extractFinalText(finalCompletion) || state.contentBuffer,
    thinking:
      extractThinkingText(finalCompletion) || state.thinkingBuffer || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason: normalizeStopReason(
      finalCompletion.choices[0]?.finish_reason,
    ),
    usage: usage
      ? {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          cost: 0,
          responseTimeMs,
          provider: options.provider ?? 'openai',
        }
      : undefined,
    raw: finalCompletion,
  };

  if (response.usage) {
    yield { type: 'usage', usage: response.usage };
  }

  yield { type: 'done', response };
}
