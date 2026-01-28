// Local imports - agent
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { BaseReasoningStreamAggregator } from './BaseReasoningStreamAggregator';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import type { NormalizeOpenAIMessageContentOptions } from './openAIMessageUtils';

/**
 * Handler for Moonshot Kimi models using OpenAI-compatible API.
 * Kimi K2 Thinking models return reasoning_content automatically when streaming.
 */
export class ModelHandlerKimi extends ModelHandlerOpenAI {
  protected override get usageProvider(): NormalizedUsage['provider'] {
    return 'kimi';
  }

  protected override createStreamingAggregator(): BaseReasoningStreamAggregator | null {
    return this.capabilities.supportsReasoning
      ? new BaseReasoningStreamAggregator()
      : null;
  }

  protected override getMessageNormalizationOptions(): NormalizeOpenAIMessageContentOptions {
    return { convertContentToString: true };
  }
}
