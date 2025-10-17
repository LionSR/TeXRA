// Local imports - agent
import type { AgentPrompt } from '@agent/core/AgentDataclass';

// Local imports - utilities
import { normalizeAgentPrompts } from './promptNormalization';

/**
 * Calculate the total number of conversation rounds.
 *
 * The configured round count provides a baseline (defaulting to 2).
 * When user reflection prompts are supplied in the userRequest array,
 * each prompt represents an additional round and we add one more round
 * for the final output after all reflections. This function returns
 * whichever count is greater to ensure arrays sized by rounds are
 * correctly allocated.
 *
 * @param configuredRounds Number of rounds specified in the agent settings
 * @param userRequest User request prompt (string or array with reflection prompts)
 * @returns Total number of conversation rounds to execute
 */
export function calculateTotalRounds(
  configuredRounds: number | undefined,
  userRequest: string | string[] | undefined,
): number {
  const rounds = configuredRounds ?? 2;
  const { reflectionPrompts } = normalizeAgentPrompts({
    userRequest,
  } as Pick<AgentPrompt, 'userRequest'>);

  const reflectRounds =
    reflectionPrompts.length > 0 ? reflectionPrompts.length + 1 : 0;
  return Math.max(rounds, reflectRounds);
}
