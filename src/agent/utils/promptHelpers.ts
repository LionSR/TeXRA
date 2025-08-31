// Local imports - agent
// Utility helpers for constructing prompts

// Local imports
import { renderPrompt } from './promptUtils';
import { loadTexraRules } from '@frontend/files/rules';
import type { AgentPrompt } from '@agent/core/AgentDataclass';

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

/**
 * Convert reflection round number to array index.
 * Reflection rounds start at 1, arrays start at 0.
 *
 * @param reflectionRound The reflection round number (1-based)
 * @returns Array index (0-based)
 */
export function reflectionRoundToIndex(reflectionRound: number): number {
  // Round 0 is the initial process, reflection starts at round 1
  // So round 1 should map to index 0, round 2 to index 1, etc.
  return Math.max(0, reflectionRound - 1);
}

/**
 * Retrieve the reflection prompt template for a given round.
 *
 * @param agentPrompt The agent prompt configuration
 * @param currRound Current conversation round index (1-based for reflections)
 * @returns Reflection prompt template string
 */
export function getReflectPromptForRound(
  agentPrompt: AgentPrompt,
  currRound: number,
): string {
  const { userReflect } = agentPrompt;
  if (Array.isArray(userReflect)) {
    const index = reflectionRoundToIndex(currRound);
    // Use the specific round template if available, otherwise fall back to first
    return index < userReflect.length
      ? userReflect[index]
      : userReflect[0] || '';
  }
  return userReflect || '';
}
