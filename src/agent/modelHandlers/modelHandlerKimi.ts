// Local imports - agent
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { ToolDefinition } from '@model';
import { BaseReasoningStreamAggregator } from './BaseReasoningStreamAggregator';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import type { NormalizeOpenAIMessageContentOptions } from './openAIMessageUtils';

// Type imports
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/** Response from Kimi's token estimation API */
interface KimiTokenEstimateResponse {
  data: {
    total_tokens: number;
  };
}

/**
 * Handler for Moonshot Kimi models using OpenAI-compatible API.
 * Kimi K2 Thinking models return reasoning_content automatically when streaming.
 *
 * Kimi K2.5 has thinking enabled by default on the Moonshot API.
 * For non-thinking variants (supportsReasoning: false), we must explicitly
 * send `thinking: { type: 'disabled' }` to turn off thinking mode.
 *
 * Supports thinking mode with tool calls. When thinking mode is enabled:
 * - The model outputs reasoning_content along with tool_calls
 * - The reasoning_content must be included in assistant messages during tool-use cycles
 *
 * @see https://platform.moonshot.cn/docs/guide/reasoning-model
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

  /**
   * Kimi thinking models require reasoning_content in tool-use follow-up messages.
   */
  protected override shouldIncludeReasoningInToolCalls(): boolean {
    return this.capabilities.supportsReasoning;
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

  /**
   * Whether this handler supports native token counting.
   * Kimi provides a token estimation API for accurate pre-flight counts.
   */
  override get supportsTokenCounting(): boolean {
    return true;
  }

  /**
   * Estimates token count using Kimi's native token counting API.
   * This provides accurate token counts for Moonshot models.
   *
   * @param messages The messages to count tokens for.
   * @returns Promise resolving to the total token count.
   * @see https://platform.moonshot.cn/docs/api/tokenization
   */
  override async estimateTokenCount(
    messages: ChatCompletionMessageParam[],
  ): Promise<number> {
    const apiKey = await this.getApiKey();
    const baseUrl = this.getBaseUrl() ?? 'https://api.moonshot.ai/v1';

    const response = await fetch(`${baseUrl}/tokenizers/estimate-token-count`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.fullName,
        messages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Kimi token estimation failed (${response.status}): ${errorText}`,
      );
    }

    const result = (await response.json()) as KimiTokenEstimateResponse;
    return result.data.total_tokens;
  }
}
