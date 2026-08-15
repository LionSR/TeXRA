// Local imports
import { joinReasoningItemsText } from '../utils/reasoningDetailsText';

// Third-party imports
import type { ReasoningDetailUnion } from '@openrouter/sdk/models';

/**
 * Extracts text content from OpenRouter reasoning_details array.
 * Handles the structured format with type-specific fields.
 * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 */
export function extractTextFromReasoningDetails(details: unknown): string {
  return joinReasoningItemsText<ReasoningDetailUnion>(details, (item) => {
    if (item.type === 'reasoning.text') return item.text ?? undefined;
    if (item.type === 'reasoning.summary') return item.summary;
    return undefined;
  });
}
