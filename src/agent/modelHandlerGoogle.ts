// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';
import { CompletionUsage } from 'openai/resources/completions';
import { GenerateContentResponseUsageMetadata } from '@google/genai/dist/node/node';

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

  /** Computes cost based on token usage. Overrides base implementation to handle Google's format. */
  computePrice(
    responseUsage: CompletionUsage | GenerateContentResponseUsageMetadata,
  ): number {
    // Handle OpenAI CompletionUsage format (from base class)
    if ('prompt_tokens' in responseUsage) {
      return super.computePrice(responseUsage as CompletionUsage);
    }

    // Handle Google's GenerateContentResponseUsageMetadata format
    const googleUsage = responseUsage as GenerateContentResponseUsageMetadata;
    const promptTokens = googleUsage?.promptTokenCount ?? 0;
    const completionTokens = googleUsage?.candidatesTokenCount ?? 0;
    const thoughtTokens = googleUsage?.thoughtsTokenCount ?? 0;

    return calculateTokenPrice(
      promptTokens,
      completionTokens + thoughtTokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );
  }

  /** Creates usage statistics from response format. Overrides base implementation to handle Google's format. */
  computeResponseUsage(
    responseUsage: CompletionUsage | GenerateContentResponseUsageMetadata,
    responseTime: number,
  ): OpenAIAPIResponseUsage {
    // Handle OpenAI CompletionUsage format (from base class)
    if ('prompt_tokens' in responseUsage) {
      return super.computeResponseUsage(
        responseUsage as CompletionUsage,
        responseTime,
      );
    }

    // Handle Google's GenerateContentResponseUsageMetadata format
    const googleUsage = responseUsage as GenerateContentResponseUsageMetadata;

    // Create a CompletionUsage object compatible with OpenAI's format
    const usageObj: CompletionUsage = {
      prompt_tokens: googleUsage?.promptTokenCount ?? 0,
      completion_tokens: googleUsage?.candidatesTokenCount ?? 0,
      total_tokens: googleUsage?.totalTokenCount ?? 0,
      prompt_tokens_details: {
        cached_tokens: googleUsage?.cachedContentTokenCount ?? 0,
      },
      completion_tokens_details: {
        reasoning_tokens: googleUsage?.thoughtsTokenCount ?? 0,
        accepted_prediction_tokens: undefined,
        rejected_prediction_tokens: undefined,
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
