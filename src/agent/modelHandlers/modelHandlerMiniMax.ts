// Local file imports
import type { ToolDefinition } from '@model';
import { BaseReasoningStreamAggregator } from './BaseReasoningStreamAggregator';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import type { NormalizeOpenAIMessageContentOptions } from './openAIMessageUtils';

// Type imports
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

/** Extracts text from a MiniMax `reasoning_details` value (array or string). */
function extractTextFromReasoningDetails(
  details: unknown,
): string | undefined {
  if (typeof details === 'string') return details || undefined;
  if (!Array.isArray(details)) return undefined;
  const text = (details as Array<{ text?: string | null }>).reduce(
    (acc, item) => acc + (item?.text ?? ''),
    '',
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
export class ModelHandlerMiniMax extends ModelHandlerOpenAI {
  protected override shouldIncludeReasoningInToolCalls(): boolean {
    return this.capabilities.supportsReasoning;
  }

  protected override createStreamingAggregator(): BaseReasoningStreamAggregator | null {
    return this.capabilities.supportsReasoning
      ? new BaseReasoningStreamAggregator()
      : null;
  }

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
      (params as Record<string, unknown>).reasoning_split = true;
    }

    return params;
  }

  /**
   * MiniMax returns reasoning in `reasoning_details` (array), not `reasoning_content`.
   */
  protected override extractReasoningDelta(
    chunk: ChatCompletionChunk,
  ): string {
    const delta = chunk.choices[0]?.delta as
      | { reasoning_details?: unknown }
      | undefined;
    if (delta && 'reasoning_details' in delta && delta.reasoning_details) {
      return extractTextFromReasoningDetails(delta.reasoning_details) ?? '';
    }
    return super.extractReasoningDelta(chunk);
  }

  protected override extractReasoningFromMessage(
    message: Record<string, unknown> | undefined,
  ): string | null {
    const details = message?.reasoning_details;
    if (details) {
      const extracted = extractTextFromReasoningDetails(details);
      if (extracted) return extracted;
    }
    return super.extractReasoningFromMessage(message);
  }

  /**
   * MiniMax requires content to be converted to strings for non-vision models.
   * Vision models use standard OpenAI image_url format.
   */
  protected override getMessageNormalizationOptions():
    | NormalizeOpenAIMessageContentOptions
    | undefined {
    if (this.capabilities.supportsVision) {
      return undefined;
    }
    return { convertContentToString: true };
  }
}
