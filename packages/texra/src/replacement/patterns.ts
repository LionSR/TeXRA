/**
 * Builders for the literal rule tables: a table is a list of names, each
 * mapped to its `[pattern, replacement]` pairs.
 */

export type PatternDict = Record<string, string>;

/** Builds a pattern table from `items`, each mapped to its pairs. */
export function createPatterns<T>(
  items: T[],
  mapper: (item: T) => [string, string][],
): PatternDict {
  return Object.fromEntries(items.flatMap(mapper));
}

/**
 * Generates patterns for fixing extra backslashes in LaTeX commands
 * Example: \\\\alpha -> \\alpha
 */
export function generateBackslashFixes(commands: string[]): PatternDict {
  return createPatterns(commands, (cmd) => [[`\\\\${cmd}`, `\\${cmd}`]]);
}
