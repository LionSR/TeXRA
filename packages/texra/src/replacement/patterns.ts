/**
 * Builders for the literal rule tables: a table is a list of names, each
 * mapped to its `[pattern, replacement]` pairs.
 */

export type PatternDict = Record<string, string>;

/** Builds a pattern table from `items`, each mapped to its pairs. */
export function createPatterns<T>(
  items: readonly T[],
  mapper: (item: T) => [string, string][],
): PatternDict {
  return Object.fromEntries(items.flatMap(mapper));
}

/**
 * Generates patterns for fixing extra backslashes in LaTeX commands
 * Example: \\\\alpha -> \\alpha
 */
export function generateBackslashFixes(
  commands: readonly string[],
): PatternDict {
  return createPatterns(commands, (cmd) => [[`\\\\${cmd}`, `\\${cmd}`]]);
}

/**
 * Rewrites the legacy font switches around one letter to the math font
 * command of the same name. Example: {\rm X} -> \mathrm{X}
 */
export function generateLegacyFontFixes(
  letters: readonly string[],
  switches: readonly string[],
): PatternDict {
  return createPatterns(letters, (letter) =>
    switches.map((name): [string, string] => [
      `{\\${name} ${letter}}`,
      `\\math${name}{${letter}}`,
    ]),
  );
}
