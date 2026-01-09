// Local imports - agent
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { BaseReasoningStreamAggregator } from './BaseReasoningStreamAggregator';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import type { NormalizeOpenAIMessageContentOptions } from './openAIMessageUtils';

/**
 * Handler for Moonshot Kimi models using OpenAI-compatible API.
 *
 * Kimi K2 Thinking models automatically enable reasoning based on model name.
 * No explicit `thinking` parameter is needed - the API returns reasoning_content
 * automatically when streaming. The base class's executeStreamingChat handles
 * reasoning_content extraction via extractReasoningDelta.
 *
 * Note: getBaseUrl() is NOT overridden here.
 * The base ModelHandler.getBaseUrl() correctly handles:
 * - Server-side keys: routes through relay
 * - Direct access: uses BASE_URLS[MOONSHOT] = 'https://api.moonshot.cn/v1'
 */
export class ModelHandlerKimi extends ModelHandlerOpenAI {
  protected override get usageProvider(): NormalizedUsage['provider'] {
    return 'kimi';
  }

  /**
   * Create streaming aggregator for thinking models.
   * Uses BaseReasoningStreamAggregator to properly reconstruct responses
   * with reasoning_content.
   */
  protected override createStreamingAggregator(): BaseReasoningStreamAggregator | null {
    return this.capabilities.supportsReasoning
      ? new BaseReasoningStreamAggregator()
      : null;
  }

  /**
   * Kimi requires string content format for messages.
   * Uses the parent's normalization hook instead of overriding createResponse.
   */
  protected override getMessageNormalizationOptions(): NormalizeOpenAIMessageContentOptions {
    return { convertContentToString: true };
  }

  // Note: processThinkingBlock is inherited from ModelHandlerOpenAI which
  // already handles reasoning_content extraction via extractReasoningFromMessage().
  //
  // Note: createMediaContent is inherited from ModelHandlerOpenAI which
  // already handles images via buildStandardVisionParts() and logs
  // appropriate warnings for unsupported media categories.
}
