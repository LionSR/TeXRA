/** What `texra run` names: a program, or `chat`. */

export const RUN_TARGET_NAME_DESCRIPTION =
  'Program name, or `chat` for a single-turn answer';

/** The error for a `texra run` name that is neither a program nor `chat`. */
export function missingRunTargetMessage(
  name: string,
  programNames: readonly string[],
): string {
  return `Unknown program: ${name}. Available: ${programNames.toSorted().join(', ')}. Use \`chat\` for a single-turn answer.`;
}
