// Local file imports
import { BaseReasoningStreamAggregator } from './BaseReasoningStreamAggregator';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import type { NormalizeOpenAIMessageContentOptions } from './openAIMessageUtils';

/**
 * Handler for MiniMax models using OpenAI-compatible API.
 *
 * MiniMax M-series models support interleaved thinking via reasoning_content
 * in streaming responses. The base OpenAI handler already extracts
 * reasoning_content from deltas and non-streaming responses.
 *
 * usageProvider and toolCallProvider inherit from base class via config.provider.
 *
 * @see https://platform.minimax.io/docs/api-reference/text-openai-api
 */
export class ModelHandlerMiniMax extends ModelHandlerOpenAI {
  protected override createStreamingAggregator(): BaseReasoningStreamAggregator | null {
    return this.capabilities.supportsReasoning
      ? new BaseReasoningStreamAggregator()
      : null;
  }

  /**
   * MiniMax thinking models require reasoning_content in tool-use follow-up messages.
   */
  protected override shouldIncludeReasoningInToolCalls(): boolean {
    return this.capabilities.supportsReasoning;
  }

  /**
   * MiniMax requires content to be converted to strings for non-vision models.
   */
  protected override getMessageNormalizationOptions(): NormalizeOpenAIMessageContentOptions {
    return { convertContentToString: true };
  }
}
