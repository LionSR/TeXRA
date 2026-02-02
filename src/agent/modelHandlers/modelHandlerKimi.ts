// Local imports - agent
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { ToolDefinition } from '@model';
import { BaseReasoningStreamAggregator } from './BaseReasoningStreamAggregator';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import type { NormalizeOpenAIMessageContentOptions } from './openAIMessageUtils';

// Type imports
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * Handler for Moonshot Kimi models using OpenAI-compatible API.
 * Kimi K2 Thinking models return reasoning_content automatically when streaming.
 *
 * Kimi K2.5 has thinking enabled by default on the Moonshot API.
 * For non-thinking variants (supportsReasoning: false), we must explicitly
 * send `thinking: { type: 'disabled' }` to turn off thinking mode.
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

  protected override getMessageNormalizationOptions():
    | NormalizeOpenAIMessageContentOptions
    | undefined {
    // Kimi K2.5 supports vision with standard OpenAI-style image_url format.
    // Don't convert content to strings for vision models as it strips image parts.
    if (this.capabilities.supportsVision) {
      return undefined;
    }
    return { convertContentToString: true };
  }

  protected override getThinkingParameter():
    | { type: 'enabled' | 'disabled' }
    | undefined {
    // Kimi K2.5 has thinking enabled by default on the Moonshot API.
    // Explicitly disable it for non-thinking variants.
    if (
      this.config.fullName === 'kimi-k2.5' &&
      !this.capabilities.supportsReasoning
    ) {
      return { type: 'disabled' };
    }
    return undefined;
  }

  protected override buildChatBaseParams(
    messages: ChatCompletionMessageParam[],
    _temperature?: number,
    systemPrompt?: string,
    endTag?: string,
    tools?: ToolDefinition[],
  ) {
    // Kimi K2.5 requires fixed temperature values:
    // - thinking mode (supportsReasoning: true): temperature=1.0
    // - non-thinking mode (supportsReasoning: false): temperature=0.6
    let temperature = _temperature;
    if (this.config.fullName.startsWith('kimi-k2.5')) {
      temperature = this.capabilities.supportsReasoning ? 1 : 0.6;
    }
    return super.buildChatBaseParams(
      messages,
      temperature,
      systemPrompt,
      endTag,
      tools,
    );
  }
}
