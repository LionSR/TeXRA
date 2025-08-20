// Local imports - agent
// Utility helpers for constructing prompts

// Local imports
import { renderPrompt } from './promptUtils';
import { loadTexraRules } from '@frontend/files/rules';

/**
 * Combine the base system prompt with optional rules from `.texrarules`.
 *
 * @param systemPrompt Base system prompt template
 * @param userVars Variables for template rendering
 * @returns Full system prompt string
 */
export async function getSystemPromptWithRules(
  systemPrompt: string,
  userVars: Record<string, any>,
): Promise<string> {
  const basePrompt = await renderPrompt(systemPrompt, userVars);
  const rules = await loadTexraRules();
  return rules ? `${basePrompt}\n${rules}` : basePrompt;
}

/**
 * Get the assistant prefill text for a specific round.
 *
 * @param prefills Prefill array from agent settings
 * @param currRound Current conversation round index
 * @returns Prefill string for the round
 */
export function getPrefillForRound(
  prefills: string[] | undefined,
  currRound: number,
): string {
  if (!prefills || prefills.length === 0) {
    return '';
  }
  return currRound < prefills.length ? prefills[currRound] : prefills[0];
}
