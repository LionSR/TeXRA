// Local imports
import { ReplacementCategory } from './types';

// ===== Regex replacements =====

// Parentheses sizing standardization
export const PARENTHESES_REPLACEMENTS: ReplacementCategory = {
  name: 'parentheses',
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
export const INLINE_MATH_REPLACEMENTS: ReplacementCategory = {
  name: 'inline_math',
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
export const LATEXDIFF_MARKUP_REPLACEMENTS: ReplacementCategory = {
  name: 'latexdiff_markup',
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

    // Pattern 1: Subscript with braces and arithmetic
    // Example: \DIFdel{_{t-1})}%DIFDELCMD → \DIFdel{$_{t-1}$}%DIFDELCMD
    // Example: \DIFdel{_{n+2}}%DIFDELCMD → \DIFdel{$_{n+2}$}%DIFDELCMD
    '\\\\DIFdel\\{_\\{([a-zA-Z][+-]?\\d*)\\}[\\)\\|]?\\}%DIFDELCMD':
      '\\DIFdel{$_{$1}$}%DIFDELCMD',

    // Pattern 2: Simple subscript with optional arithmetic
    // Example: \DIFdel{_{t}|}%DIFDELCMD → \DIFdel{$_t$}%DIFDELCMD
    // Example: \DIFdel{_{k-1})}%DIFDELCMD → \DIFdel{$_{k-1}$}%DIFDELCMD
    '\\\\DIFdel\\{_([a-zA-Z](?:[+-]\\d+)?)[\\)\\|]?\\}%DIFDELCMD':
      '\\DIFdel{$_$1$}%DIFDELCMD',

    // Pattern 3: Superscript with braces and arithmetic
    // Example: \DIFdel{^{t-1}}%DIFDELCMD → \DIFdel{$^{t-1}$}%DIFDELCMD
    // Example: \DIFdel{^{n+2})}%DIFDELCMD → \DIFdel{$^{n+2}$}%DIFDELCMD
    '\\\\DIFdel\\{\\^\\{([a-zA-Z][+-]?\\d*)\\}[\\)\\|]?\\}%DIFDELCMD':
      '\\DIFdel{$^{$1}$}%DIFDELCMD',

    // Pattern 4: Simple superscript with optional arithmetic
    // Example: \DIFdel{^t|}%DIFDELCMD → \DIFdel{$^t$}%DIFDELCMD
    // Example: \DIFdel{^{k-1}}%DIFDELCMD → \DIFdel{$^{k-1}$}%DIFDELCMD
    '\\\\DIFdel\\{\\^([a-zA-Z](?:[+-]\\d+)?)[\\)\\|]?\\}%DIFDELCMD':
      '\\DIFdel{$^$1$}%DIFDELCMD',

    // Pattern 5: Special cases for LaTeX commands as subscripts
    // Example: \DIFdel{_\tf}%DIFDELCMD → \DIFdel{$_\tf$}%DIFDELCMD
    // Example: \DIFdel{_\tauf}%DIFDELCMD → \DIFdel{$_\tauf$}%DIFDELCMD
    // Example: \DIFdel{_{\tf-1}}%DIFDELCMD → \DIFdel{$_{\tf-1}$}%DIFDELCMD
    '\\\\DIFdel\\{_\\{?(\\\\(?:tf|tauf)(?:[+-]\\d+)?)[\\}\\)\\|]?\\}%DIFDELCMD':
      '\\DIFdel{$_$1$}%DIFDELCMD',

    // Pattern 6: Fallback for simple single-letter subscripts
    // Example: \DIFdel{_I()}%DIFDELCMD → \DIFdel{$_I$}%DIFDELCMD
    // Example: \DIFdel{_x|}%DIFDELCMD → \DIFdel{$_x$}%DIFDELCMD
    '\\\\DIFdel\\{_([a-zA-Z])[\\(\\)\\|]?\\}%DIFDELCMD':
      '\\DIFdel{$_$1$}%DIFDELCMD',

    // === Fix broken math fragments with \DIFadd commands ===
    // Similar conservative patterns for \DIFadd commands

    // Example: \DIFadd{_{t-1}}%DIFADDCMD → \DIFadd{$_{t-1}$}%DIFADDCMD
    '\\\\DIFadd\\{_\\{([a-zA-Z][+-]?\\d*)\\}[\\)\\|]?\\}%DIFADDCMD':
      '\\DIFadd{$_{$1}$}%DIFADDCMD',

    // Example: \DIFadd{_{k})}%DIFADDCMD → \DIFadd{$_k$}%DIFADDCMD
    '\\\\DIFadd\\{_([a-zA-Z](?:[+-]\\d+)?)[\\)\\|]?\\}%DIFADDCMD':
      '\\DIFadd{$_$1$}%DIFADDCMD',

    // Special cases for LaTeX commands as subscripts in \DIFadd
    // Example: \DIFadd{_\tf}%DIFADDCMD → \DIFadd{$_\tf$}%DIFADDCMD
    // Example: \DIFadd{_{\tauf-1}}%DIFADDCMD → \DIFadd{$_{\tauf-1}$}%DIFADDCMD
    '\\\\DIFadd\\{_\\{?(\\\\(?:tf|tauf)(?:[+-]\\d+)?)[\\}\\)\\|]?\\}%DIFADDCMD':
      '\\DIFadd{$_$1$}%DIFADDCMD',

    // Note: For commands like \bze that should not be split, use:
    // latexdiff --append-safecmd="bze,hbze" old.tex new.tex
    // This prevents latexdiff from splitting the command and its arguments
  },
};

export const EQUATION_STYLE_REPLACEMENTS: ReplacementCategory = {
  name: 'equation_style',
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

    // Fix inconsistent blank lines after environments (universally preferred)
    '(\\\\end\\{(equation|align|figure|table|itemize|enumerate|description)\\})([A-Za-z])':
      '$1\n\n$3',

    // Remove spaces inside formatting
    '\\\\(?:textbf|textit|emph|underline|overbrace|underbrace|label|caption(?:\\*)?)\\{\\s+([^}]*)\\s+\\}':
      '\\$1{$2}',

    // Fix space before closing braces in commands (nearly universal style)
    // '\\\\(textbf|textit|emph|underline)\\{([^{}]*)\\s+\\}': '\\\\$1{$2}', // might not working now

    // Remove spaces inside textbf
    '\\\\textbf\\{\\s+([^}]*)\\s+\\}': '\\textbf{$1}',
    // Remove spaces inside textit
    '\\\\textit\\{\\s+([^}]*)\\s+\\}': '\\textit{$1}',
    // Remove spaces inside emph
    '\\\\emph\\{\\s+([^}]*)\\s+\\}': '\\emph{$1}',
    // Remove spaces inside underline
    '\\\\underline\\{\\s+([^}]*)\\s+\\}': '\\underline{$1}',
    // Remove spaces inside overbrace
    '\\\\overbrace\\{\\s+([^}]*)\\s+\\}': '\\overbrace{$1}',
    // Remove spaces inside underbrace
    '\\\\underbrace\\{\\s+([^}]*)\\s+\\}': '\\underbrace{$1}',
    // Remove spaces inside label
    '\\\\label\\{\\s+([^}]*)\\s+\\}': '\\label{$1}',
    // Remove spaces inside caption
    '\\\\caption\\{\\s+([^}]*)\\s+\\}': '\\caption{$1}',
    // Remove spaces inside caption*
    '\\\\caption\\*\\{\\s+([^}]*)\\s+\\}': '\\caption*{$1}',
  },
};
