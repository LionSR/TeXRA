// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { hasEndTag } from './AgentDataclass';
import { OpenAIAPIResponseUsage, ResponseUsageFactory } from './ResponseUsage';

/**
 * Handler for Google models using OpenAI-compatible API.
 */
export class ModelHandlerGoogle extends ModelHandlerOpenAI {
  /** Returns OpenAI client configured with Google's base URL. */
  getClient(): OpenAI {
    const apiKey = this.getApiKey();
    const baseUrl = this.getBaseUrl();
    this.logger.info(`Using Google API key. Base URL: ${baseUrl}`);
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
    });
  }

  /** Computes cost based on Google's token usage format. */
  computePrice(responseUsage: any): number {
    // Google models return completionTokens, promptTokens instead of completion_tokens, prompt_tokens
    const promptTokens = responseUsage?.promptTokens ?? 0;
    const completionTokens = responseUsage?.completionTokens ?? 0;

    return (
      (promptTokens * this.config.inputPrice +
        completionTokens * this.config.outputPrice) /
      1e6
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
    this.logger.info(
      'Determining if should continue for Google model via OpenAI API',
    );
    return !hasEndTag(agentSetting, newResponse);
  }
}
