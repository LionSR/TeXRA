/**
 * Helper functions for generating replacement patterns
 */
import { capitalize } from '../frontend-utils/commonUtils';

// ===== Shared Constants =====

// Greek Letters
// prettier-ignore
export const GREEK_LETTERS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(' ');

// prettier-ignore
export const GREEK_UPPERCASE = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau Upsilon Phi Chi Psi Omega'.split(' ');

// Common LaTeX environments
// prettier-ignore
export const COMMON_ENVIRONMENTS = [
  'document',
  'figure',
  'figure*',
  'tikzpicture',
  'align',
  'equation',
  'itemize',
  'enumerate',
  'tabular',
];

// Math Environments
// prettier-ignore
export const MATH_ENVIRONMENTS = [
  'align',
  'align*',
  'equation',
  'equation*',
  'aligned',
  'aligned*',
  'gather',
  'gather*',
  'multline',
  'cases',
];

// Section types
export const SECTION_TYPES = [
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
];

// Math operators
// prettier-ignore
export const MATH_OPERATORS = [
  'cos',
  'sin',
  'tan',
  'arctan',
  'arccos',
  'arcsin',
  'log',
  'ln',
  'exp',
  'sqrt',
  'max',
  'min',
  'sup',
  'inf',
  'lim',
  'csc',
  'ker',
  'limsup',
  'deg',
  'gcd',
  'lg',
  'Pr',
  'cot',
  'det',
  'hom',
  'sec',
  'arg',
  'coth',
  'dim',
  'liminf',
];

// prettier-ignore
export const DOTS = 'cdot dot ldots cdots vdots ddots iddots'.split(' ');
export const INTEGRALS = 'int iint iiint oint ooint ooooint'.split(' ');

// Reference types
// prettier-ignore
export const REFERENCE_TYPES = [
  'figure',
  'table',
  'equation',
  'section',
  'fig.',
  'eq.',
  'eqn.',
  'Eq.',
  'Eqs.',
  'Fig.',
];

/**
 * Generates patterns for fixing extra backslashes in LaTeX commands
 * Example: \\\\alpha -> \\alpha
 */
export function generateBackslashFixes(commands: string[]): {
  [key: string]: string;
} {
  const patterns: { [key: string]: string } = {};

  commands.forEach((cmd) => {
    patterns[`\\\\${cmd}`] = `\\${cmd}`;
  });

  return patterns;
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
 * Generates patterns for fixing extra backslashes with special patterns
 * Example: \\\\\\rho -> \\rho (for triple backslashes)
 */
export function generateTripleBackslashFixes(commands: string[]): {
  [key: string]: string;
} {
  const patterns: { [key: string]: string } = {};

  commands.forEach((cmd) => {
    patterns[`\\\\\\${cmd}`] = `\\${cmd}`;
  });

  return patterns;
}

/**
 * Generates patterns for fixing backslashes in both lowercase and uppercase commands
 */
export function generateBackslashFixesWithCase(commands: string[]): {
  [key: string]: string;
} {
  const patterns: { [key: string]: string } = {};

  commands.forEach((cmd) => {
    // Lowercase version
    patterns[`\\\\${cmd}`] = `\\${cmd}`;

    // Only capitalize the first letter if it makes sense for the command
    if (/^[a-z]/.test(cmd)) {
      const capitalizedCmd = capitalize(cmd);
      patterns[`\\\\${capitalizedCmd}`] = `\\${capitalizedCmd}`;
    }
  });

  return patterns;
}

/**
 * Generates patterns for converting XML tags to LaTeX environments and vice versa
 */
export function generateXmlLatexConversions(environments: string[]): {
  [key: string]: string;
} {
  const patterns: { [key: string]: string } = {};

  environments.forEach((env) => {
    // XML to LaTeX
    patterns[`<${env}>`] = `\\begin{${env}}`;
    patterns[`</${env}>`] = `\\end{${env}}`;

    // XML with braces to LaTeX
    patterns[`<${env}}`] = `\\begin{${env}}`;
    patterns[`</${env}}`] = `\\end{${env}}`;

    // LaTeX with incorrect XML ending
    patterns[`\\end{${env}>}`] = `\\end{${env}}`;
    patterns[`\\end{${env}>`] = `\\end{${env}}`;
  });

  return patterns;
}

/**
 * Generates patterns for converting LaTeX environments to XML tags
 */
export function generateLatexToXmlConversions(tags: string[]): {
  [key: string]: string;
} {
  const patterns: { [key: string]: string } = {};

  tags.forEach((tag) => {
    // LaTeX to XML
    patterns[`\\begin{${tag}}`] = `<${tag}>`;
    patterns[`\\end{${tag}}`] = `</${tag}>`;

    // LaTeX with '>' at the end to XML
    patterns[`\\begin{${tag}>}`] = `<${tag}>`;
    patterns[`\\begin{${tag}>`] = `<${tag}>`;
    patterns[`\\end{${tag}>}`] = `</${tag}>`;
    patterns[`\\end{${tag}>`] = `</${tag}>`;
  });

  return patterns;
}

/**
 * Generates patterns for braces fixes in environment names
 */
export function generateEnvironmentBracesFixes(environments: string[]): {
  [key: string]: string;
} {
  const patterns: { [key: string]: string } = {};

  environments.forEach((env) => {
    patterns[`{\\${env}}`] = `{${env}}`;
  });

  return patterns;
}

/**
 * Generates patterns for section spacing fixes
 */
export function generateSectionSpacingFixes(
  environments: string[],
  sectionTypes: string[],
): { [key: string]: string } {
  const patterns: { [key: string]: string } = {};

  environments.forEach((env) => {
    sectionTypes.forEach((sectionType) => {
      patterns[`\\end{${env}}\n\\${sectionType}`] =
        `\\end{${env}}\n\n\n\\${sectionType}`;
    });
  });

  return patterns;
}

/**
 * Generates patterns for non-breaking spaces in references
 */
export function generateReferenceSpacing(referenceTypes: string[]): {
  [key: string]: string;
} {
  const patterns: { [key: string]: string } = {};

  referenceTypes.forEach((type) => {
    patterns[`${type} \\ref{`] = `${type}~\\ref{`;

    // Also handle capitalized versions
    if (/^[a-z]/.test(type)) {
      const capitalizedType = capitalize(type);
      patterns[`${capitalizedType} \\ref{`] = `${capitalizedType}~\\ref{`;
      patterns[`${capitalizedType}\\ref{`] = `${capitalizedType}~\\ref{`;
    }
  });

  return patterns;
}

/**
 * Generates patterns for environment spacing fixes
 */
export function generateEnvironmentSpacingFixes(environments: string[]): {
  [key: string]: string;
} {
  const patterns: { [key: string]: string } = {};

  environments.forEach((env) => {
    patterns[`\n\n\\begin{${env}}`] = `\n\\begin{${env}}`;
    patterns[`\\end{${env}}\n\n`] = `\\end{${env}}\n`;
  });

  return patterns;
}

/**
 * Generates patterns for linebreak fixes within environments
 */
export function generateEnvironmentLinebreakFixes(environments: string[]): {
  [key: string]: string;
} {
  const patterns: { [key: string]: string } = {};

  environments.forEach((env) => {
    patterns[`\n\n\\end{${env}}`] = `\n\\end{${env}}`;
    patterns[`\n    \n\\end{${env}}`] = `\n\\end{${env}}`;
    patterns[`\n\t\n\\end{${env}}`] = `\n\\end{${env}}`;
  });

  return patterns;
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
  const patterns: { [key: string]: string } = {};

  decorators.forEach((decorator) => {
    symbols.forEach((symbol) => {
      patterns[`\\${decorator}{\\${symbol}}`] = `\\${shortcutPrefix}${symbol}`;
    });
  });

  return patterns;
}

/**
 * Generate patterns for mathcal, mathbb and other font commands
 */
export function generateMathFontShortcuts(
  letters: string[],
  fontCmd: string,
  shortcutPrefix: string,
): { [key: string]: string } {
  const patterns: { [key: string]: string } = {};

  letters.forEach((letter) => {
    patterns[`\\${fontCmd}{${letter}}`] = `\\${shortcutPrefix}${letter}`;
  });

  return patterns;
}

/**
 * Generate patterns for fixing double backslashes in bold symbols
 * Example: \\\\ba -> \\ba (correcting double backslash error)
 */
export function generateBoldBackslashFixes(
  prefix: string,
  letters: string[],
): { [key: string]: string } {
  const patterns: { [key: string]: string } = {};

  letters.forEach((letter) => {
    patterns[`\\\\${prefix}${letter}`] = `\\${prefix}${letter}`;
  });

  return patterns;
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
  const patterns: { [key: string]: string } = {};

  letters.forEach((letter) => {
    patterns[`\\${decorator}{${letter}}`] = `\\${prefix}${letter}`;
  });

  return patterns;
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
  const patterns: { [key: string]: string } = {};

  letters.forEach((letter) => {
    // Handle uppercase/lowercase differences
    const displayLetter = /^[A-Z]/.test(letter) ? letter : letter.toLowerCase();
    patterns[`\\${outerDecorator}{\\${innerCommand}{${displayLetter}}}`] =
      `\\${outerPrefix}${innerPrefix}${displayLetter}`;
  });

  return patterns;
}

/**
 * Generate patterns for Greek letter with nested decorators
 * Example: \tilde{\boldsymbol{\zeta}} -> \tbze
 */
export function generateDecoratedGreekShortcuts(
  outerDecorator: string,
  innerDecorator: string,
  greekLetters: { [key: string]: string },
  outerPrefix: string,
): { [key: string]: string } {
  const patterns: { [key: string]: string } = {};

  for (const [greekLetter, shortcut] of Object.entries(greekLetters)) {
    patterns[`\\${outerDecorator}{\\${innerDecorator}{\\${greekLetter}}}`] =
      `\\${outerPrefix}${shortcut}`;
  }

  return patterns;
}

/**
 * Generate patterns for vector shortcuts
 * Examples: \vec{x} -> \vx, \vec{p} -> \vp
 */
export function generateVectorShortcuts(
  letters: string[],
  prefix: string = 'v',
): { [key: string]: string } {
  const patterns: { [key: string]: string } = {};

  letters.forEach((letter) => {
    patterns[`\\vec{${letter}}`] = `\\${prefix}${letter}`;
  });

  return patterns;
}

/**
 * Generate patterns to normalize different text/math roman style commands
 * Examples: \mathrm{const} -> \text{const}, {\rm const} -> \text{const}
 *
 * @param terms List of terms to generate patterns for
 * @param targetCommand Target command to convert to (default: 'text')
 * @param variant Specific variant to convert from: 'mathrm', 'mbox', or 'textrm'.
 *                If not provided, handles all variants.
 */
export function generateTextCommandNormalization(
  terms: string[],
  targetCommand: string = 'text',
  variant?: string,
): { [key: string]: string } {
  const patterns: { [key: string]: string } = {};

  // Define all possible variants if none specified
  const allVariants = ['mathrm', 'mbox', 'textrm'];
  const variantsToUse = variant ? [variant] : allVariants;

  variantsToUse.forEach((v) => {
    terms.forEach((term) => {
      patterns[`\\${v}{${term}}`] = `\\${targetCommand}{${term}}`;
    });
  });

  return patterns;
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
  const patterns: { [key: string]: string } = {};

  const allVariants = ['rm', 'bf', 'cal'];
  const variantsToUse = variant ? [variant] : allVariants;

  variantsToUse.forEach((v) => {
    terms.forEach((term) => {
      patterns[`{\\${v} ${term}}`] = `\\${targetCommand}{${term}}`;
      // Handle {\rm{X}} style
      patterns[`{\\${v}{${term}}}`] = `\\${targetCommand}{${term}}`;
    });
  });

  return patterns;
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
    patterns[`\\${arrow}`] = `\\${shortcut}`;
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
  const patterns: { [key: string]: string } = {};

  // For each variable, generate spacing rules
  variables.forEach((variable) => {
    // Handle ' d\x ' case - adding space at end
    patterns[` d\\${variable} `] = ` d\\${variable}${spaceChar}`;
    // Handle with comma
    patterns[`\\dd\\${variable}\\,`] = `\\dd\\${variable}${spaceChar}`;
    // Handle differential replacement
    patterns[`{d\\${variable}}`] = `{\\dd\\${variable}}`;
  });

  return patterns;
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
