// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { hasEndTag } from './AgentDataclass';
import { OpenAIAPIResponseUsage, ResponseUsageFactory } from './ResponseUsage';

/**
 * Handler for Google models using OpenAI-compatible API.
 */
export class ModelHandlerGoogle extends ModelHandlerOpenAI {
  /** Get OpenAI client with Google's base URL. */
  getClient(): OpenAI {
    const apiKey = this.getApiKey();
    const baseUrl = this.getBaseUrl();
    logger.info(
      'ModelHandlerGoogle',
      `Using Google API key. Base URL: ${baseUrl}`,
    );
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
    });
  }

  /** Compute price for Google token usage. */
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

  /** Compute statistics for Google models. */
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

  /** Determine if Google model should continue generating. */
  shouldContinue(
    stopReason: string,
    newResponse: string,
    agentSettings: any,
  ): boolean {
    logger.info(
      'ModelHandlerGoogle',
      'Determining if should continue for Google model via OpenAI API',
    );
    return !hasEndTag(agentSettings, newResponse);
  }
}
