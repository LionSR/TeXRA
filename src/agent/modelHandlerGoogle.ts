// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { hasEndTag } from './AgentDataclass';
import {
  OpenAIAPIResponseUsage,
  ExtendedCompletionUsage,
} from './ResponseUsage';

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

  /** Normalizes Google's usage format to OpenAI CompletionUsage format. */
  private normalizeToOpenAIFormat(usage: any): ExtendedCompletionUsage {
    // If it's already in OpenAI format, return as-is
    if ('prompt_tokens' in usage && 'completion_tokens' in usage) {
      return usage;
    }

    // Convert Google's format to OpenAI format
    const thoughtTokens = usage.thoughtsTokenCount ?? usage.thoughtTokens ?? 0;
    const toolTokens = usage.toolUseTokenCount ?? 0;

    return {
      prompt_tokens: usage.promptTokens ?? 0,
      completion_tokens:
        (usage.completionTokens ?? 0) + thoughtTokens + toolTokens,
      total_tokens: usage.totalTokens ?? 0,
      prompt_tokens_details: {
        cached_tokens: usage.cachedContentTokenCount ?? 0,
      },
      completion_tokens_details: {
        reasoning_tokens: thoughtTokens,
        accepted_prediction_tokens: undefined,
        rejected_prediction_tokens: undefined,
      },
    };
  }

  /** Computes cost based on Google's token usage format. */
  computePrice(responseUsage: any): number {
    if (!responseUsage) return 0;

    const normalized = this.normalizeToOpenAIFormat(responseUsage);

    // Use the parent class's computePrice with normalized OpenAI format
    return super.computePrice(normalized);
  }

  /** Creates usage statistics from Google's response format. */
  computeResponseUsage(
    responseUsage: any,
    responseTime: number,
  ): OpenAIAPIResponseUsage {
    if (!responseUsage) {
      // Use parent's method for null case
      return super.computeResponseUsage(null, responseTime);
    }

    const normalized = this.normalizeToOpenAIFormat(responseUsage);

    // Use the parent class's computeResponseUsage with normalized format
    return super.computeResponseUsage(normalized, responseTime);
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
