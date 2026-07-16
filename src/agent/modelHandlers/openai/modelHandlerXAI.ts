// Third-party imports
import type { ExtractResponseResult } from '@agent/types/ModelHandlerContracts';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import type { ChatCompletion } from 'openai/resources/chat/completions';

// Local file imports

// Type imports

/**
 * Handler for xAI models using OpenAI-compatible API.
 *
 * Note: the legacy grok-4 generation (deprecated May 2026) rejected the
 * reasoning_effort parameter outright. Current reasoning models (grok-4.3,
 * grok-4.5) document low/medium/high effort control — see
 * validateReasoningEffort in the base class for the clamp.
 *
 * processThinkingBlock is inherited from ModelHandlerOpenAI which already
 * extracts reasoning_content from the response message.
 *
 * usageProvider and toolCallProvider inherit from base class via config.provider.
 */
export class ModelHandlerXAI extends ModelHandlerOpenAI {
  /** Extracts response text and usage statistics from API response. */
  override extractResponse(
    responseObject: ChatCompletion,
    endTag: string,
  ): ExtractResponseResult {
    const result = super.extractResponse(responseObject, endTag);

    // Log reasoning tokens if present (xAI-specific debug info)
    const reasoningTokens =
      responseObject.usage?.completion_tokens_details?.reasoning_tokens;
    if (reasoningTokens) {
      this.logger.debug(`Found reasoning tokens: ${reasoningTokens}`);
    }

    return result;
  }
}
