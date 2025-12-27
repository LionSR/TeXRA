/**
 * Helper functions for generating replacement patterns
 */
// Local imports
import { capitalize } from '@frontend/ui/messageUtils';

// Re-export commonly used constants
export {
  GREEK_LETTERS,
  SECTION_TYPES,
  MATH_OPERATORS,
  LATEX_ENVIRONMENTS,
  FENCED_LATEX_ENVIRONMENTS,
  FENCED_LATEX_ENVIRONMENT_PATTERN,
  FENCED_LATEX_BLOCK_PATTERN_MULTILINE,
  FENCED_LATEX_BLOCK_PATTERN_INLINE,
  FENCED_LATEX_BLOCK_PATTERNS,
} from './constants';

/**
 * Generates patterns for fixing extra backslashes in LaTeX commands
 * Example: \\\\alpha -> \\alpha
 */
export function generateBackslashFixes(commands: string[]): {
  [key: string]: string;
} {
  return Object.fromEntries(commands.map((cmd) => [`\\\\${cmd}`, `\\${cmd}`]));
}

/**
 * Generates patterns for fixing extra backslashes in LaTeX commands
 * with automatic grouping by command type.
 *
 * Takes an object where keys are group names and values are arrays of commands.
 *
 * @example
 * generateGroupedBackslashFixes({
 *   greekLetters: ['alpha', 'beta', 'gamma'],
 *   mathOperators: ['sin', 'cos', 'tan']
 * });
 */
export function generateGroupedBackslashFixes(commandGroups: {
  [groupName: string]: string[];
}): { [key: string]: string } {
  const patterns: { [key: string]: string } = {};

  // For each group, process all its commands
  for (const [groupName, commands] of Object.entries(commandGroups)) {
    // Add a comment for the group
    if (commands.length > 0) {
      // We're creating a fake pattern with a comment that will be visible
      // when inspecting the patterns object, but won't affect replacements
      patterns[`// == ${groupName} ==`] = `// ${commands.length} commands`;
    }

    // Add the actual patterns for this group
    commands.forEach((cmd) => {
      patterns[`\\\\${cmd}`] = `\\${cmd}`;
    });
  }

  return patterns;
}

/**
 * Generates patterns for converting XML tags to LaTeX environments and vice versa
 */
export function generateXmlLatexConversions(environments: string[]): {
  [key: string]: string;
} {
  return Object.fromEntries(
    environments.flatMap((env) => [
      // XML to LaTeX
      [`<${env}>`, `\\begin{${env}}`],
      [`</${env}>`, `\\end{${env}}`],
      // XML with begin to LaTeX
      [`<begin{${env}}>`, `\\begin{${env}}`],
      [`</begin{${env}}>`, `\\end{${env}}`],
      // XML with end to LaTeX
      [`<end{${env}}>`, `\\end{${env}}`],
      [`</end{${env}}>`, `\\end{${env}}`],
      // XML with braces to LaTeX
      [`<${env}}`, `\\begin{${env}}`],
      [`</${env}}`, `\\end{${env}}`],
      [`</${env}\n`, `\\end{${env}}\n`],
      [`</${env}}\n`, `\\end{${env}}\n`],
      // XML begin tags incorrectly closed with leading slash
      [`</begin{${env}}`, `\\begin{${env}}`],
      [`</begin{${env}}\n`, `\\begin{${env}}\n`],
      [`</begin{${env}`, `\\begin{${env}}`],
      // LaTeX with incorrect XML ending
      [`\\end{${env}>}`, `\\end{${env}}`],
      [`\\end{${env}>`, `\\end{${env}}`],
      // LaTeX with incorrect labels
      [`\\begin{-${env}}`, `\\begin{${env}}`],
      [`\\end{-${env}}`, `\\end{${env}}`],
      // LaTeX with incorrect XML ending
      [`\\begin${env}`, `\\begin{${env}}`],
      [`\\end${env}`, `\\end{${env}}`],
      // LaTeX with duplicated begin/end keywords
      [`\\begin{begin{${env}}`, `\\begin{${env}}`],
      [`\\begin{begin{${env}}}`, `\\begin{${env}}`],
      [`\\begin{\\begin{${env}}`, `\\begin{${env}}`],
      [`\\begin{\\begin{${env}}}`, `\\begin{${env}}`],
      [`\\end{end{${env}}`, `\\end{${env}}`],
      [`\\end{end{${env}}}`, `\\end{${env}}`],
      [`\\end{\\end{${env}}`, `\\end{${env}}`],
      [`\\end{\\end{${env}}}`, `\\end{${env}}`],
    ]),
  );
}

/**
 * Generates patterns for converting LaTeX environments to XML tags
 */
export function generateLatexToXmlConversions(tags: string[]): {
  [key: string]: string;
} {
  return Object.fromEntries(
    tags.flatMap((tag) => [
      // LaTeX to XML
      [`\\begin{${tag}}`, `<${tag}>`],
      [`\\end{${tag}}`, `</${tag}>`],
      // LaTeX with '>' at the end to XML
      [`\\begin{${tag}>}`, `<${tag}>`],
      [`\\begin{${tag}>`, `<${tag}>`],
      [`\\end{${tag}>}`, `</${tag}>`],
      [`\\end{${tag}>`, `</${tag}>`],
    ]),
  );
}

/**
 * Generates patterns for braces fixes in environment names
 */
export function generateEnvironmentBracesFixes(environments: string[]): {
  [key: string]: string;
} {
  return Object.fromEntries(
    environments.map((env) => [`{\\${env}}`, `{${env}}`]),
  );
}

/**
 * Generates patterns for section spacing fixes
 */
export function generateSectionSpacingFixes(
  environments: string[],
  sectionTypes: string[],
): { [key: string]: string } {
  return Object.fromEntries(
    environments.flatMap((env) =>
      sectionTypes.map((sectionType) => [
        `\\end{${env}}\n\\${sectionType}`,
        `\\end{${env}}\n\n\n\\${sectionType}`,
      ]),
    ),
  );
}

/**
 * Generates patterns that remove invalid section ending commands.
 * These commands (e.g., \end{section}) should never appear in LaTeX output.
 */
export function generateInvalidSectionEndingFixes(sectionTypes: string[]): {
  [key: string]: string;
} {
  return Object.fromEntries(
    sectionTypes.flatMap((sectionType) =>
      [
        `\\end{${sectionType}}`,
        `\\end{${sectionType}*}`,
        `\\end {${sectionType}}`,
        `\\end {${sectionType}*}`,
        // Additional space variants
        `\\end{ ${sectionType}}`,
        `\\end{ ${sectionType}*}`,
        `\\end{${sectionType} }`,
        `\\end{${sectionType}* }`,
        `\\end { ${sectionType} }`,
        `\\end { ${sectionType}* }`,
      ].map((ending) => [ending, '']),
    ),
  );
}

/**
 * Generates patterns for non-breaking spaces in references
 */
export function generateReferenceSpacing(referenceTypes: string[]): {
  [key: string]: string;
} {
  return Object.fromEntries(
    referenceTypes.flatMap((type) => {
      const entries: [string, string][] = [
        [`${type} \\ref{`, `${type}~\\ref{`],
      ];
      // Also handle capitalized versions
      if (/^[a-z]/.test(type)) {
        const capitalizedType = capitalize(type);
        entries.push(
          [`${capitalizedType} \\ref{`, `${capitalizedType}~\\ref{`],
          [`${capitalizedType}\\ref{`, `${capitalizedType}~\\ref{`],
        );
      }
      return entries;
    }),
  );
}

/**
 * Generates patterns for linebreak fixes within environments
 */
export function generateEnvironmentLinebreakFixes(environments: string[]): {
  [key: string]: string;
} {
  return Object.fromEntries(
    environments.flatMap((env) => [
      [`\n\n\\end{${env}}`, `\n\\end{${env}}`],
      [`\n    \n\\end{${env}}`, `\n\\end{${env}}`],
      [`\n\t\n\\end{${env}}`, `\n\\end{${env}}`],
    ]),
  );
}

/**
 * Generate patterns for mapping math commands to shorter versions
 * Example: \\alpha -> \\al
 */
export function generateMathCommandShortcuts(commandMap: {
  [key: string]: string;
}): { [key: string]: string } {
  const patterns: { [key: string]: string } = {};

  for (const [fullCmd, shortCmd] of Object.entries(commandMap)) {
    patterns[`\\${fullCmd}`] = `\\${shortCmd}`;
  }

  return patterns;
}

/**
 * Generate patterns for mapping decorated math symbols to shorter versions
 * Example: \\boldsymbol{\\alpha} -> \\bal
 */
export function generateDecoratedMathShortcuts(
  decorators: string[],
  symbols: string[],
  shortcutPrefix: string,
): { [key: string]: string } {
  return Object.fromEntries(
    decorators.flatMap((decorator) =>
      symbols.map((symbol) => [
        `\\${decorator}{\\${symbol}}`,
        `\\${shortcutPrefix}${symbol}`,
      ]),
    ),
  );
}

/**
 * Generate patterns for mathcal, mathbb and other font commands
 */
export function generateMathFontShortcuts(
  letters: string[],
  fontCmd: string,
  shortcutPrefix: string,
): { [key: string]: string } {
  return Object.fromEntries(
    letters.map((letter) => [
      `\\${fontCmd}{${letter}}`,
      `\\${shortcutPrefix}${letter}`,
    ]),
  );
}

/**
 * Generate patterns for fixing double backslashes in bold symbols
 * Example: \\\\ba -> \\ba (correcting double backslash error)
 */
export function generateBoldBackslashFixes(
  prefix: string,
  letters: string[],
): { [key: string]: string } {
  return Object.fromEntries(
    letters.map((letter) => [`\\\\${prefix}${letter}`, `\\${prefix}${letter}`]),
  );
}

/**
 * Generate patterns for decorated variables (tilde, hat, bar)
 * Examples:
 * - \tilde{x} -> \tx (for single letters)
 * - \hat{H} -> \hH (for single letters)
 */
export function generateDecoratorShortcuts(
  decorator: string,
  letters: string[],
  prefix: string,
): { [key: string]: string } {
  return Object.fromEntries(
    letters.map((letter) => [
      `\\${decorator}{${letter}}`,
      `\\${prefix}${letter}`,
    ]),
  );
}

/**
 * Generate patterns for nested decorated variables (like tilde with mathbf)
 * Examples:
 * - \tilde{\mathbf{x}} -> \tbx
 * - \hat{\mathcal{H}} -> \hcH
 */
export function generateNestedDecoratorShortcuts(
  outerDecorator: string,
  innerCommand: string,
  letters: string[],
  outerPrefix: string,
  innerPrefix: string,
): { [key: string]: string } {
  return Object.fromEntries(
    letters.map((letter) => {
      // Handle uppercase/lowercase differences
      const displayLetter = /^[A-Z]/.test(letter)
        ? letter
        : letter.toLowerCase();
      return [
        `\\${outerDecorator}{\\${innerCommand}{${displayLetter}}}`,
        `\\${outerPrefix}${innerPrefix}${displayLetter}`,
      ];
    }),
  );
}

/**
 * Generate patterns for vector shortcuts
 * Examples: \vec{x} -> \vx, \vec{p} -> \vp
 */
export function generateVectorShortcuts(
  letters: string[],
  prefix: string = 'v',
): { [key: string]: string } {
  return Object.fromEntries(
    letters.map((letter) => [`\\vec{${letter}}`, `\\${prefix}${letter}`]),
  );
}

/**
 * Generate patterns to normalize legacy font commands like {\rm X}, {\bf X},
 * or {\cal X}.
 */
export function generateLegacyTextCommandNormalization(
  terms: string[],
  targetCommand: string,
  variant?: string,
): { [key: string]: string } {
  const allVariants = ['rm', 'bf', 'cal'];
  const variantsToUse = variant ? [variant] : allVariants;

  return Object.fromEntries(
    variantsToUse.flatMap((v) =>
      terms.flatMap((term) => [
        [`{\\${v} ${term}}`, `\\${targetCommand}{${term}}`],
        // Handle {\rm{X}} style
        [`{\\${v}{${term}}}`, `\\${targetCommand}{${term}}`],
      ]),
    ),
  );
}

/**
 * Generate patterns for arrow and relation shortcuts
 * Examples: \rightarrow -> \ra, \Leftrightarrow -> \LRa
 */
export function generateArrowRelationShortcuts(arrowMap: {
  [key: string]: string;
}): { [key: string]: string } {
  const patterns: { [key: string]: string } = {};

  for (const [arrow, shortcut] of Object.entries(arrowMap)) {
    patterns[`\\${arrow} `] = `\\${shortcut} `;
    patterns[`\\${arrow}\\`] = `\\${shortcut}\\`;
  }

  return patterns;
}

/**
 * Generate patterns for differential spacing
 * Examples: \dd x -> \dd x~, \int d\ -> \int \dd\
 */
export function generateDifferentialSpacing(
  variables: string[],
  spaceChar: string = '~',
): { [key: string]: string } {
  return Object.fromEntries(
    variables.flatMap((variable) => [
      // Handle ' d\x ' case - adding space at end
      [` d\\${variable} `, ` d\\${variable}${spaceChar}`],
      // Handle with comma
      [`\\dd\\${variable}\\,`, `\\dd\\${variable}${spaceChar}`],
      // Handle differential replacement
      [`{d\\${variable}}`, `{\\dd\\${variable}}`],
    ]),
  );
}

/**
 * Generate patterns for mapping commands with custom shortcuts
 * Examples: \partial -> \der, \nabla -> \na
 */
export function generateCommandShortcuts(commandMap: {
  [key: string]: string;
}): { [key: string]: string } {
  const patterns: { [key: string]: string } = {};

  for (const [command, shortcut] of Object.entries(commandMap)) {
    patterns[`\\${command}`] = `\\${shortcut}`;
  }

  return patterns;
}
