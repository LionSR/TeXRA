/**
 * Utility functions for parsing and handling merge-related filenames.
 * These functions extract components from edited filenames for merge operations.
 */

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
 * Extracts agent name from filename parts handling multiple formats.
 * @param parts Array of filename parts split by underscore
 * @param underscoreCount Total number of underscores in filename
 * @returns Agent name or null if not found
 */
export function extractAgentName(
  parts: string[],
  underscoreCount: number,
): string | null {
  if (underscoreCount === 3 && parts.length >= 2) {
    // Standard format
    return parts[1];
  }

  // Complex format - find round number index and join parts before it
  const partsAfterBase = parts.slice(1);
  const roundIndex = partsAfterBase.findIndex(
    (part) => part.startsWith('r') && /^\d+$/.test(part.slice(1)),
  );

  return roundIndex !== -1
    ? partsAfterBase.slice(0, roundIndex).join('_')
    : null;
}

/**
 * Extracts components from edited filename for merge operations.
 * @param editedBase Base name of edited file without extension
 * @returns Parsed filename components
 * @throws Error if filename components cannot be extracted
 */
export function parseFilenameParts(editedBase: string): FilenameParts {
  const parts = editedBase.split('_');
  const underscoreCount = parts.length - 1;
  const base = parts[0];

  // Extract agent name
  const agent = extractAgentName(parts, underscoreCount);
  if (!agent) {
    throw new Error(
      `Could not extract agent name from edited base: ${editedBase}`,
    );
  }

  // Extract round number from the LAST _rN_ pattern
  // (base filename may contain its own _rN_ pattern)
  const roundMatches = [...editedBase.matchAll(/_r(\d+)_/g)];
  const lastRoundMatch = roundMatches.at(-1);
  if (!lastRoundMatch) {
    throw new Error(
      `Could not extract round number from edited base: ${editedBase}`,
    );
  }
  const roundNum = parseInt(lastRoundMatch[1], 10);

  // Get model name (last part)
  const model = parts.at(-1) || '';

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
