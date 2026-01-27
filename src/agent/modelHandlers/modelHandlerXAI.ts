// Third-party imports
import type { ChatCompletion } from 'openai/resources/chat/completions';

// Local file imports
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';

// Type imports
import type { ExtractResponseResult } from './types/IModelHandler';

/**
 * Handler for xAI models using OpenAI-compatible API.
 *
 * Note: reasoning_effort is not supported by grok-4 models.
 * Specifying reasoning_effort parameter will result in an error response.
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
