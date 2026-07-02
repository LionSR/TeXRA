import { z } from 'zod';

// Local imports - agent
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { ToolDefinition } from '@model';
import { ReasoningModelHandlerOpenAI } from './reasoningModelHandlerOpenAI';

// Type imports
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

function isKimiK25(fullName: string): boolean {
  return fullName.startsWith('kimi-k2.5');
}

function isKimiK27Code(fullName: string): boolean {
  return fullName === 'kimi-k2.7-code';
}

/** Response from Kimi's token estimation API */
const KimiTokenEstimateResponseSchema = z.object({
  data: z.object({ total_tokens: z.number() }),
});

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
export class ModelHandlerKimi extends ReasoningModelHandlerOpenAI {
  protected override get usageProvider(): NormalizedUsage['provider'] {
    return 'moonshot';
  }

  // Kimi K2.5 supports vision with standard OpenAI-style image_url format;
  // only stringify content for non-vision variants so image parts survive.
  protected override readonly convertContentToStringUnlessVision = true;

  protected override getThinkingParameter():
    { type: 'enabled' | 'disabled' } | undefined {
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
    // Kimi K2.7 Code requires temperature=1.0 for both catalog entries.
    let temperature = _temperature;
    if (isKimiK25(this.config.fullName)) {
      temperature = this.capabilities.supportsReasoning ? 1 : 0.6;
    } else if (isKimiK27Code(this.config.fullName)) {
      temperature = 1;
    }
    return super.buildChatBaseParams(
      messages,
      temperature,
      systemPrompt,
      endTag,
      tools,
    );
  }

  protected override buildCompactionSummaryParams(
    conversationMessages: ChatCompletionMessageParam[],
  ) {
    const params = super.buildCompactionSummaryParams(conversationMessages);
    if (isKimiK27Code(this.config.fullName)) {
      params.temperature = 1;
      delete params.thinking;
    }
    return params;
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

    const parsed = KimiTokenEstimateResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new Error(
        `Kimi token estimation returned an unexpected response shape: ${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data.data.total_tokens;
  }
}
