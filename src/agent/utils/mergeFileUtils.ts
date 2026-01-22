/**
 * Utility functions for parsing and handling merge-related filenames.
 * These functions extract components from edited filenames for merge operations.
 */

/**
 * Extracts the last _rN_ match from a filename.
 * Use this to correctly handle nested filenames where the base contains its own _rN_ pattern.
 *
 * @param filename The filename or path to extract from
 * @returns The last RegExpMatchArray or null if no match found
 *
 * @example
 * extractLastRoundMatch('main_enhance_r1_gpt52_criticize_r0_gpt52.tex')
 * // Returns match for '_r0_' (the last occurrence), not '_r1_'
 */
export function extractLastRoundMatch(
  filename: string,
): RegExpMatchArray | null {
  return [...filename.matchAll(/_r(\d+)_/g)].at(-1) ?? null;
}

/**
 * Extracts the last _rN_model match from a filename, capturing both round and model.
 * Model capture stops at underscore or dot to handle chained filenames.
 *
 * @param filename The filename or path to extract from
 * @returns The last RegExpMatchArray with [0]=full match, [1]=round, [2]=model, or null
 *
 * @example
 * extractLastRoundModelMatch('main_enhance_r1_gpt52_criticize_r0_gpt52.tex')
 * // Returns match for '_r0_gpt52' with [1]='0', [2]='gpt52'
 */
export function extractLastRoundModelMatch(
  filename: string,
): RegExpMatchArray | null {
  return [...filename.matchAll(/_r(\d+)_([^_.]+)/g)].at(-1) ?? null;
}

/**
 * Parsed components from a merge filename.
 */
export type FilenameParts = {
  /** Base name of the file */
  base: string;
  /** Agent name that processed the file */
  agent: string;
  /** Round number of processing */
  roundNum: number;
  /** Model name used for processing */
  model: string;
};

/**
 * Extracts components from edited filename for merge operations.
 * Works backwards from the LAST _rN_model pattern to correctly handle nested filenames
 * like "main_enhance_r1_gpt52_criticize_r0_gpt52".
 *
 * @param editedBase Base name of edited file without extension
 * @returns Parsed filename components
 * @throws Error if filename components cannot be extracted
 */
export function parseFilenameParts(editedBase: string): FilenameParts {
  const lastMatch = extractLastRoundModelMatch(editedBase);
  if (!lastMatch || lastMatch.index === undefined) {
    throw new Error(
      `Could not extract filename components from edited base: ${editedBase}`,
    );
  }

  const roundNum = parseInt(lastMatch[1], 10);
  const model = lastMatch[2];

  // Everything before _rN_model is base + agent
  const beforeRound = editedBase.slice(0, lastMatch.index);

  // Agent is the part after the last underscore before _rN_model
  const lastUnderscoreIndex = beforeRound.lastIndexOf('_');
  if (lastUnderscoreIndex === -1) {
    throw new Error(
      `Could not extract agent name from edited base: ${editedBase}`,
    );
  }

  const base = beforeRound.slice(0, lastUnderscoreIndex);
  const agent = beforeRound.slice(lastUnderscoreIndex + 1);

  return { base, agent, roundNum, model };
}

/**
 * Extracts agent suffix by comparing base and edited filenames.
 * Use when the base filename contains underscores and simple parsing won't work.
 *
 * Note: This function isolates the suffix first by stripping the known base,
 * then finds the first _rN in that suffix. This is correct because the suffix
 * represents a single agent operation (e.g., "_transcribe_r1_gemini"), not a
 * nested filename. For nested filenames, use parseFilenameParts() instead.
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
