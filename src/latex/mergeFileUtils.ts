/** Helpers for parsing merge-related filenames. */

/**
 * Last `_rN_` match. Returns the last occurrence so nested filenames (where
 * the base contains its own `_rN_`) resolve correctly.
 *
 * @example
 * extractLastRoundMatch('main_enhance_r1_gpt52_criticize_r0_gpt52.tex')
 * // matches '_r0_' (the last occurrence), not '_r1_'
 */
export function extractLastRoundMatch(
  filename: string,
): RegExpMatchArray | null {
  return [...filename.matchAll(/_r(\d+)_/g)].at(-1) ?? null;
}

/**
 * Last `_rN_<model>` match. Captures `[1]=round`, `[2]=model`. Model capture
 * stops at underscore or dot so chained filenames resolve correctly.
 *
 * @example
 * extractLastRoundModelMatch('main_enhance_r1_gpt52_criticize_r0_gpt52.tex')
 * // matches '_r0_gpt52' with [1]='0', [2]='gpt52'
 */
export function extractLastRoundModelMatch(
  filename: string,
): RegExpMatchArray | null {
  return [...filename.matchAll(/_r(\d+)_([^_.]+)/g)].at(-1) ?? null;
}

/**
 * Extracts agent suffix by comparing base and edited filenames.
 * Use when the base filename contains underscores and simple parsing won't work.
 *
 * Note: This function isolates the suffix first by stripping the known base,
 * then finds the first _rN in that suffix. This is correct because the suffix
 * represents a single agent operation (e.g., "_transcribe_r1_gemini"), not a
 * nested filename.
 *
 * @example
 * extractAgentSuffix(
 *   "20251018_meeting_notes",
 *   "20251018_meeting_notes_transcribe_r1_gemini"
 * ) // returns "transcribe"
 */
export function extractAgentSuffix(
  baseNameWithoutExt: string,
  editedNameWithoutExt: string,
): string | null {
  if (!editedNameWithoutExt.startsWith(baseNameWithoutExt)) {
    return null;
  }

  // Get suffix after base name, e.g., "_transcribe_r1_gemini3p"
  const suffix = editedNameWithoutExt.slice(baseNameWithoutExt.length);

  // Extract agent: everything between leading underscore and first _r{digits}
  // Using first match is correct here since suffix is already isolated
  const match = suffix.match(/^_(.+?)_r\d+/);
  return match?.[1] ?? null;
}
