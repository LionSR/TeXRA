/** What `texra run` names: a program, or `chat`. */

export const RUN_TARGET_NAME_DESCRIPTION =
  'Program name (an unknown name prints the programs), or `chat` for one answer from the assistant';

/** The error for a `texra run` name that is neither a program nor `chat`. */
export function missingRunTargetMessage(
  name: string,
  programNames: readonly string[],
): string {
  return `No program is named ${name}. Programs: ${programNames.toSorted().join(', ')}. Use \`chat\` for one answer from the assistant.`;
}
