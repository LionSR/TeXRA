// (none needed)

// Local file imports
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';

/**
 * Handler for xAI models using OpenAI-compatible API.
 * usageProvider and toolCallProvider inherit from base class via config.provider.
 *
 * xAI's Grok models use the standard OpenAI-compatible format with:
 * - reasoning_content field for thinking (handled by base class extractReasoningFromMessage)
 * - completion_tokens_details.reasoning_tokens for usage tracking (handled by base class)
 *
 * Note: reasoning_effort is NOT supported by grok-4; specifying it will cause an error.
 * The base class validateReasoningEffort() handles this by converting 'medium' to 'high'.
 */
export class ModelHandlerXAI extends ModelHandlerOpenAI {
  // All functionality is inherited from ModelHandlerOpenAI:
  // - processThinkingBlock: Uses base class extractReasoningFromMessage which handles reasoning_content
  // - extractResponse: Base class already handles all OpenAI-compatible formats
  // - normalizeUsage: Base class already extracts reasoning_tokens from completion_tokens_details
}
