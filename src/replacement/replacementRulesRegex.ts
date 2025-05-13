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
