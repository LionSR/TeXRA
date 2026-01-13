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
export function extractLastRoundMatch(filename: string): RegExpMatchArray | null {
  return [...filename.matchAll(/_r(\d+)_/g)].at(-1) ?? null;
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
 * Works backwards from the LAST _rN_ pattern to correctly handle nested filenames
 * like "main_enhance_r1_gpt52_criticize_r0_gpt52".
 *
 * @param editedBase Base name of edited file without extension
 * @returns Parsed filename components
 * @throws Error if filename components cannot be extracted
 */
export function parseFilenameParts(editedBase: string): FilenameParts {
  const lastRoundMatch = extractLastRoundMatch(editedBase);
  if (!lastRoundMatch || lastRoundMatch.index === undefined) {
    throw new Error(
      `Could not extract round number from edited base: ${editedBase}`,
    );
  }

  const roundNum = parseInt(lastRoundMatch[1], 10);
  const roundIndex = lastRoundMatch.index;

  // Model is everything after _rN_
  const model = editedBase.slice(roundIndex + lastRoundMatch[0].length);

  // Everything before _rN_ is base + agent
  const beforeRound = editedBase.slice(0, roundIndex);

  // Agent is the part after the last underscore before _rN_
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

  // Extract agent: everything between leading underscore and _r{digits}
  const match = suffix.match(/^_(.+?)_r\d+/);
  return match?.[1] ?? null;
}
