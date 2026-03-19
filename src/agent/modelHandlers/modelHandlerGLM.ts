// Local file imports
import { BaseReasoningStreamAggregator } from './BaseReasoningStreamAggregator';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import type { NormalizeOpenAIMessageContentOptions } from './openAIMessageUtils';

/**
 * Handler for GLM (Zhipu AI) models using OpenAI-compatible API.
 *
 * GLM-4.5 supports reasoning mode with reasoning_content in responses.
 * The base OpenAI handler already extracts reasoning_content from deltas.
 *
 * usageProvider and toolCallProvider inherit from base class via config.provider.
 *
 * @see https://open.bigmodel.cn/dev/api
 */
export class ModelHandlerGLM extends ModelHandlerOpenAI {
  protected override createStreamingAggregator(): BaseReasoningStreamAggregator | null {
    return this.capabilities.supportsReasoning
      ? new BaseReasoningStreamAggregator()
      : null;
  }

  /**
   * GLM requires content to be converted to strings.
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
