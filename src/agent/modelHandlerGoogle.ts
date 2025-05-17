// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { hasEndTag } from './AgentDataclass';
import { OpenAIAPIResponseUsage, ResponseUsageFactory } from './ResponseUsage';
import { calculateTokenPrice } from '../utils/priceUtils';

/**
 * Handler for Google models using OpenAI-compatible API.
 * The Flash Thinking model is an experimental model and has the following limitations:
 * Thoughts are only shown in Google AI Studio
 * Therefore we cannot extract them from the response yet
 */
export class ModelHandlerGoogle extends ModelHandlerOpenAI {
  /** Returns OpenAI client configured with Google's base URL. */
  async getClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl();
    this.logger.debug(`Using Google API key. Base URL: ${baseURL}`);
    return new OpenAI({ apiKey, baseURL });
  }

  /** Computes cost based on Google's token usage format. */
  computePrice(responseUsage: any): number {
    // Google models return completionTokens, promptTokens instead of completion_tokens, prompt_tokens
    const promptTokens = responseUsage?.promptTokens ?? 0;
    const completionTokens = responseUsage?.completionTokens ?? 0;

    return calculateTokenPrice(
      promptTokens,
      completionTokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );
  }

  /** Creates usage statistics from Google's response format. */
  computeResponseUsage(
    responseUsage: any,
    responseTime: number,
  ): OpenAIAPIResponseUsage {
    // Create a minimal usage object with Google's token counts
    const usageObj = {
      prompt_tokens: responseUsage?.promptTokens ?? 0,
      completion_tokens: responseUsage?.completionTokens ?? 0,
      total_tokens: responseUsage?.totalTokens ?? 0,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: {
        reasoning_tokens: 0,
        accepted_prediction_tokens: null,
        rejected_prediction_tokens: null,
      },
    };

    return ResponseUsageFactory.fromOpenAIResponse(
      usageObj,
      this.computePrice(responseUsage),
      responseTime,
    );
  }

  /** Determines if generation should continue based on response content. */
  shouldContinue(
    stopReason: string,
    newResponse: string,
    agentSetting: any,
  ): boolean {
    return !hasEndTag(agentSetting, newResponse);
  }
}
