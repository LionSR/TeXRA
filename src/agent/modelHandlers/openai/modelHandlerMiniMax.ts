// Local file imports
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { ToolDefinition } from '@shared/schemas';
import { ReasoningModelHandlerOpenAI } from './reasoningModelHandlerOpenAI';
import { joinReasoningItemsText } from '../utils/reasoningDetailsText';

// Type imports
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

/** Extracts text from a MiniMax `reasoning_details` value (array or string). */
function extractMiniMaxReasoningText(details: unknown): string | undefined {
  const text = joinReasoningItemsText<{ text?: string | null }>(
    details,
    (item) => item.text ?? undefined,
  );
  return text || undefined;
}

/**
 * Handler for MiniMax models using OpenAI-compatible API.
 *
 * MiniMax M-series are interleaved thinking models. By default, their thinking
 * is embedded in `<think>...</think>` tags within `content`. We use the
 * `reasoning_split` parameter to separate thinking into a dedicated field.
 *
 * With `reasoning_split: true`, MiniMax returns reasoning in a
 * `reasoning_details` array (not `reasoning_content`). This handler overrides
 * the extraction methods to read from that field.
 *
 * @see https://platform.minimax.io/docs/api-reference/text-openai-api
 * @see https://platform.minimax.io/docs/guides/text-m2-function-call
 */
export class ModelHandlerMiniMax extends ReasoningModelHandlerOpenAI {
  /**
   * Adds `reasoning_split: true` for thinking models so MiniMax returns
   * reasoning separately instead of embedding `<think>` tags in content.
   */
  protected override buildChatBaseParams(
    messages: ChatCompletionMessageParam[],
    temperature?: number,
    systemPrompt?: string,
    endTag?: string,
    tools?: ToolDefinition[],
  ) {
    const params = super.buildChatBaseParams(
      messages,
      temperature,
      systemPrompt,
      endTag,
      tools,
    );

    if (this.capabilities.supportsReasoning) {
      // MiniMax-only field, not part of the OpenAI SDK's typed request params.
      (params as typeof params & { reasoning_split: boolean }).reasoning_split =
        true;
    }

    return params;
  }

  /**
   * MiniMax returns reasoning in `reasoning_details` (array), not `reasoning_content`.
   */
  protected override extractReasoningDelta(chunk: ChatCompletionChunk): string {
    const details = (
      chunk.choices[0]?.delta as { reasoning_details?: unknown } | undefined
    )?.reasoning_details;
    if (details) return extractMiniMaxReasoningText(details) ?? '';
    return super.extractReasoningDelta(chunk);
  }

  protected override extractReasoningFromMessage(
    message: Record<string, unknown> | undefined,
  ): string | null {
    const extracted = extractMiniMaxReasoningText(message?.reasoning_details);
    return extracted ?? super.extractReasoningFromMessage(message);
  }
}
