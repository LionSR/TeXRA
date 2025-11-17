/**
 * Utility functions for parsing and handling merge-related filenames.
 * These functions extract components from edited filenames for merge operations.
 */

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

  // Complex format - collect parts until round number
  const agentParts: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith('r') && /^\d+$/.test(part.slice(1))) {
      return agentParts.join('_');
    }
    agentParts.push(part);
  }
  return null;
}

/**
 * Extracts components from edited filename for merge operations.
 * @param editedBase Base name of edited file without extension
 * @returns Tuple of [base name, agent name, round number, model name]
 * @throws Error if filename components cannot be extracted
 */
export function parseFilenameParts(
  editedBase: string,
): [string, string, number, string] {
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

  // Extract round number
  const roundMatch = editedBase.match(/_r(\d+)_/);
  if (!roundMatch) {
    throw new Error(
      `Could not extract round number from edited base: ${editedBase}`,
    );
  }
  const roundNum = parseInt(roundMatch[1], 10);

  // Get model name (last part)
  const model = parts.at(-1) || '';

  return [base, agent, roundNum, model];
}
