import { ReplacementCategory } from './replacementTypes';

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

// TikZ picture fixes
// Using ECMAScript 2018 named capture groups (?<name>pattern)
// Similar to Python's (?P<name>pattern)
// { and } needs to be \\{ and \\}?
export const TIKZ_REPLACEMENTS: ReplacementCategory = {
  name: 'tikz',
  description: 'Fixes for TikZ picture formatting and structure',
  isRegex: true,
  flags: 'gms',
  patterns: {
    '\\end{document}\\s*\\chapter': '\\chapter',
    '\\end{document}\\s*\\addcontentsline': '\\addcontentsline',
    '(?<indent>[\\t ]*)}\s*\\end{tikzpicture};\s*\\end{tikzpicture}':
      '${indent}\\end{tikzpicture}\n${indent}};\n${indent}\\end{tikzpicture}',
    '}(\\s*)\\end{tikzpicture};': '};$1\\end{tikzpicture}',
    '}(\\s*)\\end{tikzpicture}\\DIFaddendFL ;':
      '$1\\end{tikzpicture}};\\DIFaddendFL',
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
      '\n\\end{$1$2}%DIFAUXCMD',
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
    '([Aa]ppendix|[Pp]roblem|[Ss]olution|[Cc]hapter|[Aa]lgorithm|[Ff]igure|[Tt]able|[Ss]ection|[Ee]quation|[Ll]emma|[Cc]orollary|[Pp]roposition|[Tt]heorem)~?\\s*\\ref':
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
