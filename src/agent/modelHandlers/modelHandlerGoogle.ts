// Standard library imports
// (none needed)

// Third-party imports
import { FinishReason } from '@google/genai';
import OpenAI from 'openai';
import type { CompletionUsage } from 'openai/resources/completions';

// Local imports - agent
import { AgentSetting, hasEndTag } from '../core/AgentDataclass';
import {
  OpenAIAPIResponseUsage,
  GenerateContentResponseUsageMetadata,
} from '../core/ResponseUsage';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { OPENAI_CHAT_FINISH } from './types/StopReasonTypes';
import type { ProviderStopReason } from './types/StopReasonTypes';

// Token limit stop reasons reported by Google's OpenAI-compatible API.
const TOKEN_LIMIT_REASONS = new Set<string>([
  OPENAI_CHAT_FINISH.LENGTH.toLowerCase(),
  'max_tokens',
  'maxtokens',
]);

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
    // const baseURL = this.getBaseUrl();
    const baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
    this.logger.debug(`Using Google API key. Base URL: ${baseURL}`);
    return new OpenAI({ apiKey, baseURL });
  }

  /** Normalizes Google's usage format to OpenAI CompletionUsage format. */
  private normalizeToOpenAIFormat(
    usage: GenerateContentResponseUsageMetadata | CompletionUsage,
  ): CompletionUsage {
    // If it's already in OpenAI format, return as-is
    if ('prompt_tokens' in usage && 'completion_tokens' in usage) {
      return usage;
    }

    // Convert Google's format to OpenAI format
    const thoughtTokens = usage.thoughtsTokenCount ?? 0;
    const toolTokens = usage.toolUsePromptTokenCount ?? 0;

    return {
      prompt_tokens: (usage.promptTokenCount ?? 0) + toolTokens,
      completion_tokens: (usage.candidatesTokenCount ?? 0) + thoughtTokens,
      total_tokens: usage.totalTokenCount ?? 0,

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

  // In the future i want to type this to GenerateContentResponseUsageMetadata | CompletionUsage, but this needs to change the base class
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

  /**
   * Determines if generation should continue based on response content and stop reason.
   * Google surfaces FinishReason.MAX_TOKENS when output truncates; we only continue when
   * that happens before the agent's closing tag has been emitted.
   */
  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    const containsEndTag = hasEndTag(agentSetting, newResponse);
    const normalizedStopReason =
      typeof stopReason === 'string' ? stopReason.toLowerCase() : undefined;

    const hitTokenLimit =
      stopReason === FinishReason.MAX_TOKENS ||
      (normalizedStopReason !== undefined &&
        TOKEN_LIMIT_REASONS.has(normalizedStopReason));

    if (hitTokenLimit && !containsEndTag) {
      this.logger.debug(
        `Continuing generation: stopReason='${stopReason}' hit token limit before end tag '${agentSetting.endTag}'.`,
      );
      return true;
    }

    this.logger.debug(
      `Stopping generation: stopReason='${stopReason}', hitTokenLimit=${hitTokenLimit}, hasEndTag=${containsEndTag}.`,
    );
    return false;
  }
}
