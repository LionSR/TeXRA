// Local imports - utilities

/**
 * Calculate the total number of conversation rounds.
 *
 * The configured round count provides a baseline (defaulting to 2).
 * When user reflection prompts are supplied, each prompt represents
 * an additional round and we add one more round for the final output
 * after all reflections. This function returns whichever count is
 * greater to ensure arrays sized by rounds are correctly allocated.
 *
 * @param configuredRounds Number of rounds specified in the agent settings
 * @param userReflect User-provided reflection prompts
 * @returns Total number of conversation rounds to execute
 */
export function calculateTotalRounds(
  configuredRounds: number | undefined,
  userReflect: string | string[] | undefined,
): number {
  const rounds = configuredRounds ?? 2;
  const reflectRounds = Array.isArray(userReflect) ? userReflect.length + 1 : 0;
  return Math.max(rounds, reflectRounds);
}
