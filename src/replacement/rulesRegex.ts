// Local imports
import type { RegexReplacementCategory as RegexReplacementCategoryName } from '@shared/constants/replacementCategories';

import { RegexReplacementCategory, ReplacementFunction } from './types';
import {
  FENCED_LATEX_BLOCK_PATTERN_INLINE,
  FENCED_LATEX_BLOCK_PATTERN_MULTILINE,
} from './constants';

const EQUATION_ENVIRONMENT_PATTERN =
  '(?:align\\*?|aligned\\*?|alignat\\*?|flalign\\*?|gather\\*?|multline\\*?|equation\\*?|eqnarray\\*?|split\\*?)';

const convertFencedLatexBlock: ReplacementFunction = (
  match,
  leadingBreak,
  indent,
  environment,
  multilineBody,
  inlineBody,
) => {
  const newline = match.includes('\r\n') ? '\r\n' : '\n';
  const safeLeadingBreak = leadingBreak ?? '';
  const safeIndent = indent ?? '';
  const safeEnvironment = environment ?? '';
  const safeBody = multilineBody || inlineBody || '';

  const bodyWithTrailingBreak =
    safeBody === '' || safeBody.endsWith(newline)
      ? safeBody
      : `${safeBody}${newline}`;
  const emptyBodyPadding = safeBody === '' ? newline : '';

  return `${safeLeadingBreak}${safeIndent}\\begin{${safeEnvironment}}${newline}${emptyBodyPadding}${bodyWithTrailingBreak}${safeIndent}\\end{${safeEnvironment}}`;
};

function hasBalancedBraces(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      if (depth === 0) return false;
      depth -= 1;
    }
  }
  return depth === 0;
}

function createCaptionTrimmer(
  command: '\\caption' | '\\caption*',
): ReplacementFunction {
  return (match, content) => {
    if (typeof content !== 'string') return match;
    if (!hasBalancedBraces(content) || /[\r\n]/.test(content)) return match;

    const trimmed = content.replace(/^[\t ]+/, '').replace(/[\t ]+$/, '');
    return trimmed === content ? match : `${command}{${trimmed}}`;
  };
}

// ===== Regex replacements =====

const MACRO_TO_ENVIRONMENT: Record<string, string> = {
  be: '\\begin{equation}',
  ee: '\\end{equation}',
  bea: '\\begin{eqnarray}',
  eea: '\\end{eqnarray}',
  bse: '\\begin{subequations}',
  ese: '\\end{subequations}',
};

const expandEquationMacro: ReplacementFunction = (
  match,
  leading = '',
  macro = '',
  trailing = '',
) => {
  const replacement = MACRO_TO_ENVIRONMENT[macro];
  return replacement ? `${leading}${replacement}${trailing}` : match;
};

export const EQUATION_MACRO_REPLACEMENTS: RegexReplacementCategory = {
  name: 'equation_macros' satisfies RegexReplacementCategoryName,
  description:
    'Expands short equation helpers like \\be into full environments',
  isRegex: true,
  flags: 'gm',
  patterns: {
    // Require macros to be on their own line so inline uses like "foo \\be bar"
    // remain untouched. We only support lowercase helpers here for backwards
    // compatibility with legacy documents that relied on these shorthands
    // (including the deprecated eqnarray environment).
    '^(\\s*)\\\\([a-z]+)(\\s*)$': expandEquationMacro,
  },
};

export const FENCED_LATEX_BLOCK_REPLACEMENTS: RegexReplacementCategory = {
  name: 'fenced_latex_blocks' satisfies RegexReplacementCategoryName,
  description:
    'Convert Markdown-style fenced math blocks into proper LaTeX environments',
  isRegex: true,
  flags: 'g',
  patterns: {
    [FENCED_LATEX_BLOCK_PATTERN_MULTILINE]: convertFencedLatexBlock,
    [FENCED_LATEX_BLOCK_PATTERN_INLINE]: convertFencedLatexBlock,
  },
};

// Parentheses sizing standardization
export const PARENTHESES_REPLACEMENTS: RegexReplacementCategory = {
  name: 'parentheses' satisfies RegexReplacementCategoryName,
  description: 'Standardize parentheses sizing using regex patterns',
  isRegex: true,
  flags: 'g',
  patterns: {
    // ===== Small delimiter normalization =====
    // Convert \big* delimiters to regular parentheses when content is simple
    '\\\\big\\(([^\\n]*?)\\\\big\\)': '($1)',
    '\\\\big\\[([^\\n]*?)\\\\big\\]': '[$1]',
    '\\\\bigl\\(([^\\n]*?)\\\\bigr\\)': '($1)',
    '\\\\bigl\\[([^\\n]*?)\\\\bigr\\]': '[$1]',

    // ===== Medium delimiter standardization =====
    // Convert \Big* delimiters to \left...\right format
    '\\\\Big\\(([^\\n]*?)\\\\Big\\)': '\\left($1\\right)',
    '\\\\Big\\[([^\\n]*?)\\\\Big\\]': '\\left[$1\\right]',
    '\\\\Big\\{([^\\n]*?)\\\\Big\\}': '\\left\\{$1\\right\\}',

    // ===== Bigl/Bigr delimiter standardization =====
    // Convert \Bigl...\Bigr to \left...\right format
    '\\\\Bigl\\(([^\\n]*?)\\\\Bigr\\)': '\\left($1\\right)',
    '\\\\Bigl\\[([^\\n]*?)\\\\Bigr\\]': '\\left[$1\\right]',
    '\\\\Bigl\\\\{([^\\n]*?)\\\\Bigr\\\\}': '\\left\\{$1\\right\\}',

    // ===== Large delimiter standardization =====
    // Convert \biggl...\biggr to \left...\right format
    '\\\\biggl\\(([^\\n]*?)\\\\biggr\\)': '\\left($1\\right)',
    '\\\\biggl\\[([^\\n]*?)\\\\biggr\\]': '\\left[$1\\right]',
    '\\\\biggl\\\\{([^\\n]*?)\\\\biggr\\\\}': '\\left\\{$1\\right\\}',

    // ===== Extra large delimiter standardization =====
    // Convert \Biggl...\Biggr to \left...\right format
    '\\\\Biggl\\(([^\\n]*?)\\\\Biggr\\)': '\\left($1\\right)',
    '\\\\Biggl\\[([^\\n]*?)\\\\Biggr\\]': '\\left[$1\\right]',
    '\\\\Biggl\\\\{([^\\n]*?)\\\\Biggr\\\\}': '\\left\\{$1\\right\\}',
  },
};

// LaTeX inline math formatting fixes
export const INLINE_MATH_REPLACEMENTS: RegexReplacementCategory = {
  name: 'inline_math' satisfies RegexReplacementCategoryName,
  description: 'Fixes for LaTeX inline math formatting',
  isRegex: true,
  flags: 'g',
  patterns: {
    // ===== Convert \( \) to $ $ =====
    '\\\\\\(\\s*(.*?)\\s*\\\\\\)': '$$$1$',

    // ===== Remove spacing commands with arbitrary integers =====
    '\\[-?\\d+pt\\]': '', // Remove [Npt] spacing commands
    '\\[-?\\d+mm\\]': '', // Remove [Nmm] spacing commands
    '\\[-?\\d+ex\\]': '', // Remove [Nex] spacing commands
    '\\[0\\.-?\\d+mm\\]': '', // Remove [0.Nmm] spacing commands
    '\\[0\\.-?\\d+ex\\]': '', // Remove [0.Nex] spacing commands

    // ===== Remove horizontal and vertical spacing commands =====
    '\\\\hspace\\[-?\\d+pt\\]': '', // Remove \hspace[Npt] commands
    '\\\\hspace\\{-?\\d+mm\\}': '', // Remove \hspace{Nmm} commands
    '\\\\hspace\\{-?\\d+ex\\}': '', // Remove \hspace{Nex} commands
    '\\\\vspace\\{-?\\d+pt\\}': '', // Remove \vspace{Npt} commands
    '\\\\vspace\\{-?\\d+mm\\}': '', // Remove \vspace{Nmm} commands
    '\\\\vspace\\{-?\\d+ex\\}': '\n', // Replace \vspace{Nex} with newline
  },
};

// Context-aware personal style conversions
export const PERSONAL_STYLE_CONTEXTUAL_REPLACEMENTS: RegexReplacementCategory =
  {
    name: 'personal_style_contextual' satisfies RegexReplacementCategoryName,
    description:
      'Context-aware replacements for personal style rules that avoid macro definitions',
    isRegex: true,
    flags: 'g',
    patterns: {
      // Temporarily protect \mathrm{Tr} inside command definitions
      '((?:\\\\(?:re)?newcommand|\\\\providecommand|\\\\DeclareMathOperator\\*?)\\{[^}]+\\}(?:\\[[^\\]]*\\])?\\{)\\\\mathrm\\{Tr\\}':
        '$1__TEXRA_PRESERVE_TR__',
      // Temporarily protect \mathrm{tr} inside command definitions
      '((?:\\\\(?:re)?newcommand|\\\\providecommand|\\\\DeclareMathOperator\\*?)\\{[^}]+\\}(?:\\[[^\\]]*\\])?\\{)\\\\mathrm\\{tr\\}':
        '$1__TEXRA_PRESERVE_tr__',
      // Apply preferred operator command forms
      '\\\\mathrm\\{Tr\\}': '\\Tr',
      '\\\\mathrm\\{tr\\}': '\\tr',
      // Restore protected command definitions
      __TEXRA_PRESERVE_TR__: '\\mathrm{Tr}',
      __TEXRA_PRESERVE_tr__: '\\mathrm{tr}',
    },
  };

/**
 * LATEXDIFF USAGE NOTE:
 *
 * For commands that should not have their arguments split by latexdiff,
 * use the --append-safecmd option:
 *
 * latexdiff --append-safecmd="bze,hbze,mycommand" old.tex new.tex
 *
 * This tells latexdiff to treat these commands and their arguments as
 * atomic units that should not be split across \DIFdel/\DIFadd blocks.
 *
 * Common commands to add as safecmd:
 * - Custom macros with mathematical arguments
 * - Commands with complex subscripts/superscripts
 * - Commands whose arguments must remain intact for compilation
 */

// Latexdiff markup fixes using regex
export const LATEXDIFF_MARKUP_REPLACEMENTS: RegexReplacementCategory = {
  name: 'latexdiff_markup' satisfies RegexReplacementCategoryName,
  description: 'Fixes for redundant braces and whitespace in latexdiff markup',
  isRegex: true,
  flags: 'gs',
  patterns: {
    // Collapse redundant blank lines / spaces between a closing brace and \end{...}%DIFAUXCMD
    // Matches: newline + spaces/tabs + newline + spaces/tabs + }\end{align*}%DIFAUXCMD
    '\n[ \t]*\n[ \t]*\\}\\\\end\\{(align|aligned)(\\*?)\\}%DIFAUXCMD':
      '\n}\\end{$1$2}%DIFAUXCMD',

    // === Fix broken subscripts/superscripts in \DIFdel commands ===
    // These patterns wrap math fragments in dollar signs to preserve math mode
    //
    // LIMITATION: These patterns only fix isolated subscript/superscript fragments.
    // If there's additional content after (like in \DIFdel{_{t-1})F_{t-1|t}(}),
    // the additional content is NOT processed to avoid overly aggressive replacements.
    //
    // TODO: Consider multi-pass processing or more sophisticated parsing for complex cases
    // with multiple math fragments within a single \DIFdel block

    // Pattern 1: Numeric subscripts
    // Example: \DIFdel{_1|}%DIFDELCMD → \DIFdel{$_1$}%DIFDELCMD
    // Example: \DIFdel{_0)}%DIFDELCMD → \DIFdel{$_0$}%DIFDELCMD
    '\\\\DIFdel\\{_(\\d+)[\\)\\|]?\\}%DIFDELCMD': '\\DIFdel{$_$1$}%DIFDELCMD',

    // Pattern 2: Prime symbols (derivatives)
    // Example: \DIFdel{'_0)}%DIFDELCMD → \DIFdel{$'_0$}%DIFDELCMD
    // Example: \DIFdel{''_t}%DIFDELCMD → \DIFdel{$''_t$}%DIFDELCMD
    "\\\\DIFdel\\{('+)_([a-zA-Z\\d]+)[\\)\\|]?\\}%DIFDELCMD":
      '\\DIFdel{$$1_$2$}%DIFDELCMD',

    // Pattern 3: Subscript with braces and arithmetic
    // Example: \DIFdel{_{t-1})}%DIFDELCMD → \DIFdel{$_{t-1}$}%DIFDELCMD
    // Example: \DIFdel{_{n+2}}%DIFDELCMD → \DIFdel{$_{n+2}$}%DIFDELCMD
    '\\\\DIFdel\\{_\\{([a-zA-Z][+-]?\\d*)\\}[\\)\\|]?\\}%DIFDELCMD':
      '\\DIFdel{$_{$1}$}%DIFDELCMD',

    // Pattern 4: Simple subscript with optional arithmetic
    // Example: \DIFdel{_{t}|}%DIFDELCMD → \DIFdel{$_t$}%DIFDELCMD
    // Example: \DIFdel{_{k-1})}%DIFDELCMD → \DIFdel{$_{k-1}$}%DIFDELCMD
    '\\\\DIFdel\\{_([a-zA-Z](?:[+-]\\d+)?)[\\)\\|]?\\}%DIFDELCMD':
      '\\DIFdel{$_$1$}%DIFDELCMD',

    // Pattern 5: Numeric superscripts
    // Example: \DIFdel{^2}%DIFDELCMD → \DIFdel{$^2$}%DIFDELCMD
    // Example: \DIFdel{^{10}}%DIFDELCMD → \DIFdel{$^{10}$}%DIFDELCMD
    '\\\\DIFdel\\{\\^(\\d+)[\\)\\|]?\\}%DIFDELCMD': '\\DIFdel{$^$1$}%DIFDELCMD',

    // Pattern 6: Superscript with braces and arithmetic
    // Example: \DIFdel{^{t-1}}%DIFDELCMD → \DIFdel{$^{t-1}$}%DIFDELCMD
    // Example: \DIFdel{^{n+2})}%DIFDELCMD → \DIFdel{$^{n+2}$}%DIFDELCMD
    '\\\\DIFdel\\{\\^\\{([a-zA-Z][+-]?\\d*)\\}[\\)\\|]?\\}%DIFDELCMD':
      '\\DIFdel{$^{$1}$}%DIFDELCMD',

    // Pattern 7: Simple superscript with optional arithmetic
    // Example: \DIFdel{^t|}%DIFDELCMD → \DIFdel{$^t$}%DIFDELCMD
    // Example: \DIFdel{^{k-1}}%DIFDELCMD → \DIFdel{$^{k-1}$}%DIFDELCMD
    '\\\\DIFdel\\{\\^([a-zA-Z](?:[+-]\\d+)?)[\\)\\|]?\\}%DIFDELCMD':
      '\\DIFdel{$^$1$}%DIFDELCMD',

    // Pattern 8: Special cases for LaTeX commands as subscripts
    // Example: \DIFdel{_\tf}%DIFDELCMD → \DIFdel{$_\tf$}%DIFDELCMD
    // Example: \DIFdel{_\tauf}%DIFDELCMD → \DIFdel{$_\tauf$}%DIFDELCMD
    // Example: \DIFdel{_{\tf-1}}%DIFDELCMD → \DIFdel{$_{\tf-1}$}%DIFDELCMD
    '\\\\DIFdel\\{_\\{?(\\\\(?:tf|tauf)(?:[+-]\\d+)?)[\\}\\)\\|]?\\}%DIFDELCMD':
      '\\DIFdel{$_$1$}%DIFDELCMD',

    // Pattern 9: Fallback for simple single-letter subscripts
    // Example: \DIFdel{_I()}%DIFDELCMD → \DIFdel{$_I$}%DIFDELCMD
    // Example: \DIFdel{_x|}%DIFDELCMD → \DIFdel{$_x$}%DIFDELCMD
    '\\\\DIFdel\\{_([a-zA-Z])[\\(\\)\\|]?\\}%DIFDELCMD':
      '\\DIFdel{$_$1$}%DIFDELCMD',

    // === Fix broken math fragments with \DIFadd commands ===
    // Similar conservative patterns for \DIFadd commands

    // Numeric subscripts in \DIFadd
    // Example: \DIFadd{_1|}%DIFADDCMD → \DIFadd{$_1$}%DIFADDCMD
    '\\\\DIFadd\\{_(\\d+)[\\)\\|]?\\}%DIFADDCMD': '\\DIFadd{$_$1$}%DIFADDCMD',

    // Prime symbols in \DIFadd
    // Example: \DIFadd{'_0)}%DIFADDCMD → \DIFadd{$'_0$}%DIFADDCMD
    "\\\\DIFadd\\{('+)_([a-zA-Z\\d]+)[\\)\\|]?\\}%DIFADDCMD":
      '\\DIFadd{$$1_$2$}%DIFADDCMD',

    // Example: \DIFadd{_{t-1}}%DIFADDCMD → \DIFadd{$_{t-1}$}%DIFADDCMD
    '\\\\DIFadd\\{_\\{([a-zA-Z][+-]?\\d*)\\}[\\)\\|]?\\}%DIFADDCMD':
      '\\DIFadd{$_{$1}$}%DIFADDCMD',

    // Example: \DIFadd{_{k})}%DIFADDCMD → \DIFadd{$_k$}%DIFADDCMD
    '\\\\DIFadd\\{_([a-zA-Z](?:[+-]\\d+)?)[\\)\\|]?\\}%DIFADDCMD':
      '\\DIFadd{$_$1$}%DIFADDCMD',

    // Numeric superscripts in \DIFadd
    // Example: \DIFadd{^2}%DIFADDCMD → \DIFadd{$^2$}%DIFADDCMD
    '\\\\DIFadd\\{\\^(\\d+)[\\)\\|]?\\}%DIFADDCMD': '\\DIFadd{$^$1$}%DIFADDCMD',

    // Special cases for LaTeX commands as subscripts in \DIFadd
    // Example: \DIFadd{_\tf}%DIFADDCMD → \DIFadd{$_\tf$}%DIFADDCMD
    // Example: \DIFadd{_{\tauf-1}}%DIFADDCMD → \DIFadd{$_{\tauf-1}$}%DIFADDCMD
    '\\\\DIFadd\\{_\\{?(\\\\(?:tf|tauf)(?:[+-]\\d+)?)[\\}\\)\\|]?\\}%DIFADDCMD':
      '\\DIFadd{$_$1$}%DIFADDCMD',

    // Note: For commands like \bze that should not be split, use:
    // latexdiff --append-safecmd="bze,hbze" old.tex new.tex
    // This prevents latexdiff from splitting the command and its arguments

    // === Fix escaped tildes in \DIFdel/\DIFadd commands ===
    // The escaped tilde \~ is a tilde accent command that needs an argument.
    // Inside \DIFdel{} it should be the non-breaking space character ~.
    // Example: \DIFdel{\~}%DIFDELCMD → \DIFdel{~}%DIFDELCMD
    '\\\\DIFdel\\{\\\\~\\}%DIFDELCMD': '\\DIFdel{~}%DIFDELCMD',
    // Example: \DIFadd{\~}%DIFADDCMD → \DIFadd{~}%DIFADDCMD
    '\\\\DIFadd\\{\\\\~\\}%DIFADDCMD': '\\DIFadd{~}%DIFADDCMD',
  },
};

export const EQUATION_STYLE_REPLACEMENTS: RegexReplacementCategory = {
  name: 'equation_style' satisfies RegexReplacementCategoryName,
  description: 'Fixes for equation style formatting',
  isRegex: true,
  flags: 'g',
  patterns: {
    // Swap order of superscript and subscript in integrals/sums/products to ensure subscript comes first
    // Example: \int^{x}_{t} -> \int_{t}^{x}
    '(\\\\int|\\\\sum|\\\\prod)\\^\\{([^{}]+|\\{[^{}]*\\})\\}_\\{([^{}]+|\\{[^{}]*\\})\\}':
      '$1_{$3}^{$2}',
    // Remove extra space after \left( and before \right)
    '\\\\left\\(\\s+': '\\left(',
    '\\s+\\\\right\\)': '\\right)', // this works
    '\\\\left\\\\{\\s+': '\\left\\{', // Note the double backslash before {
    '\\s+\\\\right\\\\}': '\\right\\}', // Note the double backslash before }
    '\\\\left\\|\\s+': '\\left|',
    '\\s+\\\\right\\|': '\\right|',
    '\\\\left\\[\\s+': '\\left[',
    '\\s+\\\\right\\]': '\\right]',

    // Fix list item spacing
    // '\\\\begin\\{(itemize|enumerate|description)\\}\\s*\\\\item':
    // '\\begin{$1}\n    \\item',
    // this is also detecting \n after \begin{itemize}

    // Fix Repeated Words (Common Typos)
    '\\b(the|and|or|of|in|to|a|for|that|this|with|by|on|as) \\1\\b': '$1',
    '([Aa]ppendix|[Pp]roblem|[Ss]olution|[Cc]hapter|[Aa]lgorithm|[Ff]igure|[Tt]able|[Ss]ection|[Ee]quation|[Ll]emma|[Cc]orollary|[Pp]roposition|[Tt]heorem|[Ee]qns\\.|[Ee]q\\.)~?\\s*\\ref':
      '$1~\\ref',

    // Unescape underscores in reference commands
    // LaTeX references (label names) don't require escaped underscores
    // We use multiple unique patterns (with subtle regex variations) to handle multiple underscores
    // Each pattern is applied sequentially, allowing iterative replacement
    // Pass 1: Using non-greedy match
    '(\\\\(?:cref|ref|eqref)\\{[^{}]*?)\\\\(_)': '$1$2',
    // Pass 2: Using character class for 'r'
    '(\\\\(?:c[r]ef|ref|eq[r]ef)\\{[^{}]*?)\\\\(_)': '$1$2',
    // Pass 3: Using character class for 'e'
    '(\\\\(?:cr[e]f|r[e]f|eqr[e]f)\\{[^{}]*?)\\\\(_)': '$1$2',
    // Pass 4: Using character class for 'f'
    '(\\\\(?:cre[f]|re[f]|eqre[f])\\{[^{}]*?)\\\\(_)': '$1$2',
    // Pass 5: Using redundant grouping
    '(\\\\(?:(?:cref)|(?:ref)|(?:eqref))\\{[^{}]*?)\\\\(_)': '$1$2',

    // Normalize blank lines immediately after equation environments begin
    [`\\\\begin\\{(${EQUATION_ENVIRONMENT_PATTERN})\\}([ \t]*\\r?\\n)(?:[ \t]*\\r?\\n)+`]:
      '\\begin{$1}$2',

    // Normalize blank lines immediately before equation environments end
    [`(\\r?\\n)(?:[ \t]*\\r?\\n)+([ \t]*\\\\end\\{(${EQUATION_ENVIRONMENT_PATTERN})\\})`]:
      '$1$2',

    // Fix duplicated begin/end wrappers such as \begin{begin{align}}
    [`\\\\begin\\{begin\\{(${EQUATION_ENVIRONMENT_PATTERN})\\}\\}`]:
      '\\begin{$1}',
    [`\\\\end\\{end\\{(${EQUATION_ENVIRONMENT_PATTERN})\\}\\}`]: '\\end{$1}',

    // Fix inconsistent blank lines after environments (universally preferred)
    '(\\\\end\\{(equation|align|figure|table|itemize|enumerate|description)\\})([A-Za-z])':
      '$1\n\n$3',

    // Fix space before closing braces in commands (nearly universal style)
    // '\\\\(textbf|textit|emph|underline)\\{([^{}]*)\\s+\\}': '\\\\$1{$2}', // might not working now

    // Remove spaces inside textbf/textit/emph/underline/overbrace/underbrace/label
    ...Object.fromEntries(
      [
        'textbf',
        'textit',
        'emph',
        'underline',
        'overbrace',
        'underbrace',
        'label',
      ].map((cmd) => [`\\\\${cmd}\\{\\s+([^}]*)\\s+\\}`, `\\${cmd}{$1}`]),
    ),
    // Remove spaces inside caption (only horizontal whitespace, preserving newlines for multi-line captions)
    '\\\\caption\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}':
      createCaptionTrimmer('\\caption'),
    // Remove spaces inside caption*
    '\\\\caption\\*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}':
      createCaptionTrimmer('\\caption*'),
  },
};
