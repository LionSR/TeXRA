// Local file imports
import type { ToolDefinition } from '@model';
import { BaseReasoningStreamAggregator } from './BaseReasoningStreamAggregator';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import type { NormalizeOpenAIMessageContentOptions } from './openAIMessageUtils';

// Type imports
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * Handler for MiniMax models using OpenAI-compatible API.
 *
 * MiniMax M-series are interleaved thinking models. By default, their thinking
 * is embedded in `<think>...</think>` tags within `content`. We use the
 * `reasoning_split` parameter to separate thinking into the standard
 * `reasoning_content` field, aligning with the pattern used by DeepSeek/GLM/Kimi.
 *
 * With `reasoning_split: true`:
 * - **Streaming**: `reasoning_content` in deltas is populated (extracted by base handler)
 * - **Non-streaming**: `reasoning_content` on the message is populated (extracted by base handler)
 * - **Tool calls**: `reasoning_content` is preserved in assistant messages via
 *   `shouldIncludeReasoningInToolCalls()`, maintaining the interleaved reasoning chain
 *
 * @see https://platform.minimax.io/docs/api-reference/text-openai-api
 * @see https://platform.minimax.io/docs/guides/text-m2-function-call
 */
export class ModelHandlerMiniMax extends ModelHandlerOpenAI {
  /**
   * MiniMax thinking models require reasoning_content in tool-use follow-up
   * messages to maintain the interleaved reasoning chain across tool calls.
   */
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
   * reasoning in the standard `reasoning_content` field instead of embedding
   * `<think>` tags in content.
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
