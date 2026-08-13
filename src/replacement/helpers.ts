/**
 * Helper functions for generating replacement patterns
 */
// Local imports
import { capitalize } from '@utils/text/stringUtils';

// ============================================================================
// Core factory functions for pattern generation
// ============================================================================

type PatternDict = Record<string, string>;
type PatternMapper<T> = (item: T) => [string, string][];

/**
 * Creates a pattern dictionary from items using a mapper function.
 * This is the core abstraction for all pattern generators.
 */
function createPatterns<T>(items: T[], mapper: PatternMapper<T>): PatternDict {
  return Object.fromEntries(items.flatMap(mapper));
}

// ============================================================================
// Public generator functions
// ============================================================================

/**
 * Generates patterns for fixing extra backslashes in LaTeX commands
 * Example: \\\\alpha -> \\alpha
 */
export function generateBackslashFixes(commands: string[]): PatternDict {
  return createPatterns(commands, (cmd) => [[`\\\\${cmd}`, `\\${cmd}`]]);
}

/**
 * Generates patterns for converting XML tags to LaTeX environments and vice versa
 */
export function generateXmlLatexConversions(
  environments: string[],
): PatternDict {
  return createPatterns(environments, (env) => [
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
  ]);
}

/**
 * Generates patterns for converting LaTeX environments to XML tags
 */
export function generateLatexToXmlConversions(tags: string[]): PatternDict {
  return createPatterns(tags, (tag) => [
    // LaTeX to XML
    [`\\begin{${tag}}`, `<${tag}>`],
    [`\\end{${tag}}`, `</${tag}>`],
    // LaTeX with '>' at the end to XML
    [`\\begin{${tag}>}`, `<${tag}>`],
    [`\\begin{${tag}>`, `<${tag}>`],
    [`\\end{${tag}>}`, `</${tag}>`],
    [`\\end{${tag}>`, `</${tag}>`],
  ]);
}

/**
 * Generates patterns for braces fixes in environment names
 */
export function generateEnvironmentBracesFixes(
  environments: string[],
): PatternDict {
  return createPatterns(environments, (env) => [[`{\\${env}}`, `{${env}}`]]);
}

/**
 * Generates patterns for section spacing fixes
 */
export function generateSectionSpacingFixes(
  environments: string[],
  sectionTypes: string[],
): PatternDict {
  return createPatterns(environments, (env) =>
    sectionTypes.map((sectionType) => [
      `\\end{${env}}\n\\${sectionType}`,
      `\\end{${env}}\n\n\n\\${sectionType}`,
    ]),
  );
}

/**
 * Generates patterns that remove invalid section ending commands.
 * These commands (e.g., \end{section}) should never appear in LaTeX output.
 */
export function generateInvalidSectionEndingFixes(
  sectionTypes: string[],
): PatternDict {
  return createPatterns(sectionTypes, (sectionType) =>
    [
      `\\end{${sectionType}}`,
      `\\end{${sectionType}*}`,
      `\\end {${sectionType}}`,
      `\\end {${sectionType}*}`,
      `\\end{ ${sectionType}}`,
      `\\end{ ${sectionType}*}`,
      `\\end{${sectionType} }`,
      `\\end{${sectionType}* }`,
      `\\end { ${sectionType} }`,
      `\\end { ${sectionType}* }`,
    ].map((ending) => [ending, '']),
  );
}

/**
 * Generates patterns for non-breaking spaces in references
 */
export function generateReferenceSpacing(
  referenceTypes: string[],
): PatternDict {
  return createPatterns(referenceTypes, (type) => {
    const entries: [string, string][] = [[`${type} \\ref{`, `${type}~\\ref{`]];
    if (/^[a-z]/.test(type)) {
      const capitalizedType = capitalize(type);
      entries.push(
        [`${capitalizedType} \\ref{`, `${capitalizedType}~\\ref{`],
        [`${capitalizedType}\\ref{`, `${capitalizedType}~\\ref{`],
      );
    }
    return entries;
  });
}

/**
 * Generates patterns for linebreak fixes within environments
 */
export function generateEnvironmentLinebreakFixes(
  environments: string[],
): PatternDict {
  return createPatterns(environments, (env) => [
    [`\n\n\\end{${env}}`, `\n\\end{${env}}`],
    [`\n    \n\\end{${env}}`, `\n\\end{${env}}`],
    [`\n\t\n\\end{${env}}`, `\n\\end{${env}}`],
  ]);
}

/**
 * Generate patterns for mapping decorated math symbols to shorter versions
 * Example: \\boldsymbol{\\alpha} -> \\bal
 */
export function generateDecoratedMathShortcuts(
  decorators: string[],
  symbols: string[],
  shortcutPrefix: string,
): PatternDict {
  return createPatterns(decorators, (decorator) =>
    symbols.map((symbol) => [
      `\\${decorator}{\\${symbol}}`,
      `\\${shortcutPrefix}${symbol}`,
    ]),
  );
}

/**
 * Generate patterns for single-argument commands wrapping one letter, covering
 * both decorators and math fonts.
 * Examples:
 * - \tilde{x} -> \tx
 * - \hat{H} -> \hH
 * - \mathcal{X} -> \cX
 */
export function generateDecoratorShortcuts(
  decorator: string,
  letters: string[],
  prefix: string,
): PatternDict {
  return createPatterns(letters, (letter) => [
    [`\\${decorator}{${letter}}`, `\\${prefix}${letter}`],
  ]);
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
): PatternDict {
  return createPatterns(letters, (letter) => [
    [
      `\\${outerDecorator}{\\${innerCommand}{${letter}}}`,
      `\\${outerPrefix}${innerPrefix}${letter}`,
    ],
  ]);
}

/**
 * Generate patterns to normalize legacy font commands like {\rm X}, {\bf X},
 * or {\cal X}.
 */
export function generateLegacyTextCommandNormalization(
  terms: string[],
  targetCommand: string,
  variant: string,
): PatternDict {
  return createPatterns(terms, (term) => [
    [`{\\${variant} ${term}}`, `\\${targetCommand}{${term}}`],
    [`{\\${variant}{${term}}}`, `\\${targetCommand}{${term}}`],
  ]);
}

/**
 * Generate patterns for arrow and relation shortcuts
 * Examples: \rightarrow -> \ra, \Leftrightarrow -> \LRa
 */
export function generateArrowRelationShortcuts(
  arrowMap: PatternDict,
): PatternDict {
  return createPatterns(Object.entries(arrowMap), ([arrow, shortcut]) => [
    [`\\${arrow} `, `\\${shortcut} `],
    [`\\${arrow}\\`, `\\${shortcut}\\`],
  ]);
}

/**
 * Generate patterns for differential spacing
 * Examples: \dd x -> \dd x~, \int d\ -> \int \dd\
 */
export function generateDifferentialSpacing(
  variables: string[],
  spaceChar: string = '~',
): PatternDict {
  return createPatterns(variables, (variable) => [
    [` d\\${variable} `, ` d\\${variable}${spaceChar}`],
    [`\\dd\\${variable}\\,`, `\\dd\\${variable}${spaceChar}`],
    [`{d\\${variable}}`, `{\\dd\\${variable}}`],
  ]);
}

/**
 * Generate patterns for mapping commands to shorter versions
 * Examples: \partial -> \der, \nabla -> \na, \alpha -> \al
 */
export function generateCommandShortcuts(commandMap: PatternDict): PatternDict {
  return createPatterns(Object.entries(commandMap), ([command, shortcut]) => [
    [`\\${command}`, `\\${shortcut}`],
  ]);
}
