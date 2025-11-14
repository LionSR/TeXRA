// Local imports - agent
// Utility helpers for constructing prompts

// Local imports
import { loadTexraRules } from '@frontend/files/rules';

// Local file imports
import { renderPrompt } from './promptUtils';

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

// (other prompt helper utilities are intentionally kept colocated with their consumers)
