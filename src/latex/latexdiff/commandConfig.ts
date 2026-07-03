import type { OutputFileInfo } from '@shared/schemas';

/**
 * Normalize arbitrary command payload metadata into the internal round map.
 * VS Code commands can be invoked with any argument shape, so only the current
 * tuple-array form is trusted; malformed or legacy map-shaped values fall back
 * to discovery instead of crashing the command handler.
 */
export function normalizeRunLatexdiffOutputsByRound(
  value: unknown,
): Map<number, OutputFileInfo[]> | null {
  if (!Array.isArray(value)) return null;

  const validRounds = value
    .filter(
      (entry): entry is [number, OutputFileInfo[]] =>
        Array.isArray(entry) &&
        typeof entry[0] === 'number' &&
        Number.isInteger(entry[0]) &&
        Array.isArray(entry[1]) &&
        entry[1].length > 0,
    )
    .sort((a, b) => a[0] - b[0]);

  return validRounds.length > 0 ? new Map(validRounds) : null;
}
