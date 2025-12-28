/**
 * Google GenAI stream normalizer.
 *
 * Converts Google's GenerateContentResponse chunks to unified StreamEvents.
 * Uses the SDK's native AsyncIterable support for clean iteration.
 *
 * Key behaviors:
 * - Thinking: Detected by part.thought === true, delta calculated from cumulative
 * - Content: Delta calculated from cumulative text (chunk.text is cumulative)
 * - Tool calls: Extracted from functionCall parts, emitted on first occurrence
 * - Usage: Captured from final chunk's usageMetadata
 *
 * Note: Unlike Anthropic/OpenAI which provide deltas directly, Google's streaming
 * provides cumulative content. We calculate deltas by tracking previous values.
 */

import type { GenerateContentResponse, Part } from '@google/genai';

import type {
  StreamEvent,
  NormalizedResponse,
  NormalizedStopReason,
} from '../streamEventSchema';
import type { NormalizerOptions, GoogleNormalizerState } from '../types';

/**
 * Type alias for Google content streams.
 * The SDK returns an AsyncIterable<GenerateContentResponse>.
 */
export type GoogleContentStream = AsyncIterable<GenerateContentResponse>;

/**
 * Create initial normalizer state.
 */
function createInitialState(): GoogleNormalizerState {
  return {
    previousThinkingText: '',
    previousContentText: '',
    previousThinkingIndex: -1,
    previousContentIndex: -1,
    seenToolCallIds: new Set(),
  };
}

/**
 * Check if a part is a text part with content.
 */
function isTextPart(part: Part): part is Part & { text: string } {
  return typeof part.text === 'string' && part.text.length > 0;
}

/**
 * Extract thinking text from parts (parts with thought === true).
 */
function extractThinkingParts(parts: Part[]): string {
  return parts
    .filter(
      (part): part is Part & { text: string; thought: true } =>
        isTextPart(part) && part.thought === true,
    )
    .map((part) => part.text)
    .join('');
}

/**
 * Extract non-thinking text from parts.
 */
function extractNonThinkingText(parts: Part[]): string {
  return parts
    .filter(
      (part): part is Part & { text: string } =>
        isTextPart(part) && !part.thought,
    )
    .map((part) => part.text)
    .join('');
}

/**
 * Normalize Google finish reason to unified stop reason.
 */
function normalizeStopReason(
  finishReason: string | undefined,
): NormalizedStopReason {
  switch (finishReason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

/**
 * Process a chunk and yield delta events.
 * Google provides cumulative content, so we calculate deltas.
 */
function* processChunk(
  chunk: GenerateContentResponse,
  state: GoogleNormalizerState,
  options: NormalizerOptions,
): Generator<StreamEvent> {
  const candidate = chunk.candidates?.[0];
  if (!candidate) return;

  const parts = candidate.content?.parts ?? [];

  // Handle thinking parts (cumulative → delta)
  const currentThinking = extractThinkingParts(parts);
  if (currentThinking.length > state.previousThinkingText.length) {
    const delta = currentThinking.slice(state.previousThinkingText.length);
    state.previousThinkingText = currentThinking;

    yield {
      type: 'thinking',
      delta,
    };
  }

  // Handle content (cumulative chunk.text → delta)
  const currentText = chunk.text ?? '';
  if (
    currentText.length > state.previousContentText.length &&
    options.outputEnabled !== false
  ) {
    const delta = currentText.slice(state.previousContentText.length);
    state.previousContentText = currentText;

    yield {
      type: 'content',
      delta,
    };
  }

  // Handle tool calls (function calls)
  for (const part of parts) {
    if (part.functionCall) {
      const fc = part.functionCall;
      // Use function name + stringified args as a simple ID since Google doesn't provide one
      const id = `${fc.name}-${JSON.stringify(fc.args)}`;

      // Only emit if we haven't seen this tool call before
      if (!state.seenToolCallIds.has(id)) {
        state.seenToolCallIds.add(id);

        yield {
          type: 'tool_call_start',
          id,
          name: fc.name ?? 'unknown',
        };

        yield {
          type: 'tool_call_delta',
          id,
          arguments: JSON.stringify(fc.args ?? {}),
        };

        yield {
          type: 'tool_call_done',
          id,
        };
      }
    }
  }
}

/**
 * Extract tool calls from final response.
 */
function extractToolCalls(
  response: GenerateContentResponse,
): Array<{ id: string; name: string; arguments: string }> {
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  const parts = response.candidates?.[0]?.content?.parts ?? [];

  for (const part of parts) {
    if (part.functionCall) {
      const fc = part.functionCall;
      const id = `${fc.name}-${JSON.stringify(fc.args)}`;
      toolCalls.push({
        id,
        name: fc.name ?? 'unknown',
        arguments: JSON.stringify(fc.args ?? {}),
      });
    }
  }

  return toolCalls;
}

/**
 * Normalize Google stream to unified events.
 *
 * @param stream - Google content stream (implements AsyncIterable)
 * @param options - Normalizer options
 * @returns Async generator of normalized stream events
 */
export async function* normalizeGoogleStream(
  stream: GoogleContentStream,
  options: NormalizerOptions = {},
): AsyncGenerator<StreamEvent> {
  const state = createInitialState();
  const startTime = options.startTime ?? Date.now();

  let lastChunk: GenerateContentResponse | undefined;

  // Process streaming chunks
  for await (const chunk of stream) {
    lastChunk = chunk;
    yield* processChunk(chunk, state, options);
  }

  if (!lastChunk) {
    yield {
      type: 'error',
      message: 'Stream produced no response',
    };
    return;
  }

  const responseTimeMs = Date.now() - startTime;

  // Build tool calls array
  const toolCalls = extractToolCalls(lastChunk);

  // Extract final text (non-thinking content)
  const parts = lastChunk.candidates?.[0]?.content?.parts ?? [];
  const finalText = extractNonThinkingText(parts) || lastChunk.text || '';
  const finalThinking = extractThinkingParts(parts) || undefined;

  // Get usage from the final chunk
  const usage = lastChunk.usageMetadata;

  // Build normalized response
  const response: NormalizedResponse = {
    text: finalText,
    thinking: finalThinking,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason: normalizeStopReason(lastChunk.candidates?.[0]?.finishReason),
    usage: usage
      ? {
          inputTokens: usage.promptTokenCount ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
          cost: 0, // Will be calculated by caller
          responseTimeMs,
          provider: options.provider ?? 'google',
          reasoningTokens: usage.thoughtsTokenCount ?? undefined,
        }
      : undefined,
    raw: lastChunk,
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
