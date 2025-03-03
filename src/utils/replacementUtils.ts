/**
 * Utilities for managing text replacements in the codebase.
 */

// Local imports - log
import * as logger from '../logger/logUtils';

const CHANNEL = 'ReplacementUtils';
logger.initialize(CHANNEL);

interface ReplacementCategory {
  name: string;
  description: string;
  patterns: { [key: string]: string };
  isRegex?: boolean;
  flags?: string; // Optional regex flags
}

// ===== LaTeX Content Formatting =====

// LaTeX spacing and punctuation fixes
const LATEX_SPACING_REPLACEMENTS: ReplacementCategory = {
  name: 'latex_spacing',
  description:
    'Fixes for LaTeX spacing, punctuation, and formatting [for O1 model]',
  isRegex: false,
  patterns: {
    // Basic spacing fixes
    ', \\;': ', ',
    ' \\;': ' ',
    ' \\; ': ' ',
    ' \\,\\nn': ' \\nn',
    ',\\,\\': ', ',
    ')\\,\\': ') \\',
    '}\\,\\': '} \\',
    '|\\,\\': '| \\',
    ' \\,\\': ' \\',
    '\\,\n': '\n',
    '\n    \\\\': '\\\\',
    '\\!\\!': '',
    '.  ': '. ',
    ' nn\n': ' \\nn\n',

    // Operator spacing
    '\\;+\\;': '+',
    '\\;-\\;': '-',
    '\\;*\\;': '*',
    '\\;/\\;': '/',
    '\\;=\\;': '=',
    '+\\;': '+',
    '-\\;': '-',
    '=\\;': '=',

    // Align environment formatting
    '\n    \\nonumber\\\\': '\\nonumber\\\\',
    '\n    +': ' +',
    '\n    \n&=': '\n    &=',
    '\n    ,\n': ',\n',
    '\!\n    ': '\n    ',
    '\n    =\n': ' =',
    '\n    \propto\n': ' =',
    '\n     &\n    -': '\n    & -',
    '(\n    ': '(',
    '\n    )': ')',
    '\n     &\n    \\times': '\n    & \\times',

    // Specific context spacing
    'e^{\\,i\\,': 'e^{i ',
    'e^{\\,': 'e^{',
    '-\\,i\\, ': '-i ',
    '-\\,i\\,': '-i',
    '\\,i\\,': ' i ',
    '-\\,': '-',
    '\\,&': ' &',
    '{-\\,0}': '{0}',
    '{-\\,1}': '{1}',

    // Skip commands
    '\\medskip\n': '',
    '\\smallskip\n': '',
    '\\bigskip\n': '',

    // Punctuation in math mode
    '.$': '$.',
    // ',$': '$,', // this is problematic for eg. tikz figure xticklabels={$-\Sig$,0$,\Sig$},
    '$-\\,': '$-',

    // Simplify delimiters
    '\\left[\\dots\\right]': '[\\dots]',

    //
    '\\displaystyle': '',
    '\\Longleftrightarrow': '\\LRa',

    // for o1/o3 but at last:
    '=    \\': '= \\',
    ' rho_': '  \\rho_',
    ' rho^': '  \\rho^',
    ' rho\\': '  \\rho\\',

    '\\sum\\limits_': '\\sum_',
  },
};

// Common LaTeX equation spacing fixes
const EQUATION_REPLACEMENTS: ReplacementCategory = {
  name: 'equations',
  description: 'Fixes for LaTeX equation spacing and formatting',
  isRegex: false,
  patterns: {
    // Environment spacing fixes
    '\n\n\\begin{align}': '\n\\begin{align}',
    '\\end{align}\n\n': '\\end{align}\n',
    '\n\n\\begin{equation}': '\n\\begin{equation}',
    '\\end{equation}\n\n': '\\end{equation}\n',
    // Fix reference numbering
    'figure \\ref{': 'figure~\\ref{',
    'table \\ref{': 'table~\\ref{',
    'equation \\ref{': 'equation~\\ref{',
    'Fig. \\ref{': 'Fig.~\\ref{',
    'Table \\ref{': 'Table~\\ref{',
    'Equation \\ref{': 'Equation~\\ref{',
    'eq. \\ref{': 'eq.~\\ref{',
    'eqn. \\ref{': 'eqn.~\\ref{',
    'Eq. \\ref{': 'Eq.~\\ref{',
    'Eqs. \\ref{': 'Eqs.~\\ref{',

    // Fix incorrect math operator commands
    '\\\\cos': '\\cos',
    '\\\\sin': '\\sin',
    '\\\\tan': '\\tan',
    '\\\\log': '\\log',
    '\\\\ln': '\\ln',
    '\\\\exp': '\\exp',
    '\\\\sqrt': '\\sqrt',
    '\\\\pi': '\\pi',
    '\\\\alpha': '\\alpha',
    '\\\\beta': '\\beta',
    '\\\\gamma': '\\gamma',
    '\\\\mathbf': '\\mathbf',
    '\\\\mathbb': '\\mathbb',
    '\\\\mathcal': '\\mathcal',
    '\\\\der': '\\der',
    '\\\\text{': '\\text{',
    '\\\\tilde{': '\\tilde',
    '\\\\textit{': '\\textit',
    '\\\\textbf{': '\\textbf',
    '\\\\underline{': '\\underline',
    '\\\\overbrace{': '\\overbrace',
    '\\\\underbrace{': '\\underbrace',
    '\\e^{': 'e^{',
    '\\\\label{': '\\label{',
    '\\\nlabel{': '\\label{',

    // latex ending separators
    '\n\\\nend{align}': '\n\\end{align}',
    '\n\\\nend{equation}': '\n\\end{equation}',
    '\n\\\nend{itemize}': '\n\\end{itemize}',
    '\n\\\nend{enumerate}': '\n\\end{enumerate}',
    '\n\\\nend{figure}': '\n\\end{figure}',
    '\n\\\nend{tikzpicture}': '\n\\end{tikzpicture}',
    '\n\\\nend{document}': '\n\\end{document}',

    // Unusal line/paragraph separators (Gemini problem)
    '/[\u2028\u2029]/g': '\n',
    '\\frac12': '\\ha',
  },
};

// Section spacing fixes
const SECTION_REPLACEMENTS: ReplacementCategory = {
  name: 'sections',
  description: 'Fixes for section spacing in LaTeX documents',
  isRegex: false,
  patterns: {
    '\\end{align}\n\\section': '\\end{align}\n\n\n\\section',
    '\\end{equation}\n\\section': '\\end{equation}\n\n\n\\section',
    '\\end{align}\n\\subsection': '\\end{align}\n\n\n\\subsection',
    '\\end{equation}\n\\subsection': '\\end{equation}\n\n\n\\subsection',
    '\\end{align}\n\\paragraph': '\\end{align}\n\n\n\\paragraph',
    '\\end{equation}\n\\paragraph': '\\end{equation}\n\n\n\\paragraph',
  },
};

// Special character replacements
const CHARACTER_REPLACEMENTS: ReplacementCategory = {
  name: 'characters',
  description: 'Fixes for special characters and diacritics',
  isRegex: false,
  patterns: {
    ansätze: 'ans{\\"a}tze',
    Rényi: "R{\\'e}nyi",
    Schrödinger: 'Schr{\\"o}dinger',
  },
};

// ===== XML/Structural Formatting =====

// XML structure fixes specifically for output processing
const LATEX_XML_REPLACEMENTS: ReplacementCategory = {
  name: 'latex_xml',
  description: 'Fixes specific to XML output processing',
  isRegex: false,
  patterns: {
    // random tag fixes
    '<ctrl96>': '',
    // Basic tag fixes
    // \end{document> etc is a real mistake that need to be fixed!!! Do not change these
    '\\end{document>': '\\end{document}',
    '\\end{figure>': '\\end{figure}',
    '\\end{tikzpicture>': '\\end{tikzpicture}',
    '\\end{revised_statement>': '</revised_statement>',
    '\\end{scope>': '\\end{scope}',
    '\\end{latex_document>': '</latex_document>\n',
    '\\end{output>': '\\end{output}',
    '\\end{response>': '\\end{response}',
    '\\end{scratchpad>': '</scratchpad>',
    '\\end{itemize>': '\\end{itemize}',
    // Gemini problems
    '</minipage>': '\\end{minipage}',
    '\\begin{figure*}}': '\\begin{figure*}',
    '\\begin{figure}}': '\\begin{figure}',
    '\n\\minipage}': '\n\\end{minipage}',
    '\\minipage}': '\\end{minipage}',
    // LaTeX to XML conversions
    '\\end{idea}': '</idea>',
    '\\end{scratchpad}': '</scratchpad>',
    '\\end\n': '\\end{document}\n',
    '</figure>\n': '\\end{figure}\n',
    '</enumerate>': '\\end{enumerate}',
    '</enumerate}': '\\end{enumerate}',

    '\\begin{latex_document}': '<latex_document>',
    '\\end{latex_document}': '</latex_document>',
    // the following logic is tricky, we might have to use some regex to match the tags
    '```latex\n\\documentclass[': '<latex_document>\n\\documentclass[',
    '<latex_document>\n```latex': '<latex_document>\n',
    'Here is the revised \\LaTeX document.\n\n```latex':
      'Here is the revised \\LaTeX document.\n\n<latex_document>',
    // Scratchpad and latex_document handling
    '<scratchpad>\n<scratchpad>\n': '<scratchpad>\n',
    '<scratchpad>\n```latex\n': '<scratchpad>\n<latex_document>\n',
    '<scratchpad>```latex': '<scratchpad>\n<latex_document>',
    '```\n</scratchpad>\n</latex_document>': '</latex_document>',
    '</latex_document>\n```\n</latex_document>': '</latex_document>\n',
    '</latex_document>\n</latex_document>': '</latex_document>\n',
    '</latex_document>\n\n</latex_document>': '</latex_document>\n',
    // ```latex
    '```latex\n<latex_document>\n': '\n<latex_document>\n',
    '<latex_document>\n<latex_document>': '<latex_document>',
    // Document nesting and structure
    '\\end{document}\\n\\n\\<document name=':
      '\\end{document}\\n</document>\\n\\<document name=',
    '\\end{document}\\n\\<document name=':
      '\\end{document}\\n</document>\\n\\<document name=',
    '\\end{latex_document}\\n</latex_document>':
      '\\end{document}\\n</latex_document>',
    '\\end{document}\\n</latex_documents>':
      '\\end{document}\\n</document>\\n</latex_documents>',
    '\\end{document}\\n\\n<document name':
      '\\end{document}\\n</document>\\n\\n<document name',
    '\\end{document}\\n<document name':
      '\\end{document}\\n</document>\\n<document name',
    '\\end{document}\\n</rebuttal_package>':
      '\\end{document}\\n</document>\\n</rebuttal_package>',
    // Special cases
    '{\\today}\\n\\n[Previous':
      '{\\today}\\n\\n\\begin{document}\\n\\makeheader[Previous', // Add document and header
    // empty xml document tag
    '<document name="">': '<document name="unknown">',
    // for Gemini:
    '<?xml version="1.0" encoding="UTF-8"?>': '',
  },
};

const SCRATCHPAD_XML_REPLACEMENTS: ReplacementCategory = {
  name: 'scratchpad_xml',
  description: 'Fixes for scratchpad XML processing',
  isRegex: false,
  patterns: {
    // Duplicate scratchpad tag fixes - remove redundant tags
    '<scratchpad><scratchpad>': '<scratchpad>',
    '<scratchpad> <scratchpad>': '<scratchpad>',
    '<scratchpad>\n<scratchpad>': '<scratchpad>',
    // Scratchpad to latex_document transitions - ensure proper nesting
    '<scratchpad>\n<latex_document>':
      '<scratchpad>\n</scratchpad>\n<latex_document>',
    '<scratchpad><latex_document>':
      '<scratchpad>\n</scratchpad>\n<latex_document>',
    '<scratchpad><cover_letter>': '<scratchpad>\n</scratchpad>\n<cover_letter>',
    '<scratchpad>\n<cover_letter>':
      '<scratchpad>\n</scratchpad>\n<cover_letter>',
    // Code block to latex_document conversions - handle markdown code blocks
    '<scratchpad>\n```latex\n<latex_document>':
      '<scratchpad>\n</scratchpad>\n<latex_document>',
    '</scratchpad>\n```latex': '</scratchpad>\n<latex_document>',
    '</scratchpad>\n\n```latex': '</scratchpad>\n\n<latex_document>',
    '</scratchpad>\n    \n```latex': '</scratchpad>\n\n<latex_document>',
    '```\n</latex_document>': '</latex_document>',
    // Special LaTeX content handling
    '</scratchpad>\n\\section{':
      '</scratchpad>\n\\<latex_document>\n\\section{',
    '</scratchpad>\n\\begin{document}':
      '</scratchpad>\n\\<latex_document>\n\\begin{document}',
    // Rebuttal package fixes
    '<rebuttal_package><scratchpad>\n\\n<rebuttal_package><scratchpad>':
      '<rebuttal_package><scratchpad>',
  },
};

// ===== Style and Content Improvements =====

const STYLE_REPLACEMENTS: ReplacementCategory = {
  name: 'style',
  description: 'Style improvements and word choice fixes',
  isRegex: false,
  patterns: {
    delve: 'discuss',
    embark: 'start',
    realm: 'area',
    intricate: 'complex',
    '"exact"': "``exact''",
    'delving into': 'discussing',
    "It's important to note": 'Note that',
    'our exploration': 'our discussion',
    'inter-layer': 'interlayer',
    'Near the 50\\%': 'Near 50\\%',
    'on the order of': 'of the order of',
    'improves consistently': 'consistently improves',
    'with results shown': 'with the results shown',
    'imaginary time evolution': 'imaginary-time evolution',
    // 'underscores': ''
    showcasing: 'showing',
    'paradigm shift': 'big change',
    envisage: 'imagine',
    // typos
    parameterizing: 'parametrizing',
    Normalizing: 'Normalizing',
    // thermodynamical: 'thermodynamic', // problematic with thermodynamically
    conditon: 'condition',
    necessitates: 'requires',
    '’': "'",
  },
};

// Personal writing style preferences
const PERSONAL_STYLE_REPLACEMENTS: ReplacementCategory = {
  name: 'personal_style',
  description:
    'Personal writing style preferences for specific LaTeX commands and spacing',
  isRegex: false,
  patterns: {
    // Differential spacing preferences
    '\\dd s\\,': '\\dd s~',
    '\\dd\\bze\\,': '\\dd\\bze~',
    '\\dd\\bxi\\,': '\\dd\\bxi~',
    '\\dd\\beta\\,': '\\dd\\beta~',
    '\\dd\\tau\\,': '\\dd\\tau~',
    '\\dd\\t\\,': '\\dd\\t~',
    '\\dd\\bx\\,': '\\dd\\bx~',
    '\\dd\\bz\\,': '\\dd\\bz~',
    '\\dd\\bze_{\\tauf}\\,': '\\dd\\bze_{\\tauf}~',
    '\\dd x ': '\\dd x~ ',
    "\\dd x'": "\\dd x'~",
    '\\quad\\Ra': '~~~\\Ra',
    // Spacing cleanup preferences
    '\\;': ' ',
    ' \\, d\\': '~ d\\',
    ' \\,|': ' |',
    '|\\, ': '| ',
    ' \\,  ': ' ',
    '  \\, ': ' ',
    ' \\, ': ' \\',
    '\\, \\,': ' \\,',
    // '\\,': ' ',

    // Hyphenation preferences of physical review style
    nonnegative: 'non-negative',
    finitetime: 'finite-time',
    'one–step': 'one-step',
    'multi-scale': 'multiscale',
    'area law scaling': 'area-law scaling',
    'machine learning model': 'machine-learning model',
    'machine learning task': 'machine-learning task',
    // UK vs US spelling
    analogue: 'analog',
  },
};

// ===== Regex replacements =====

// Parentheses sizing standardization
const PARENTHESES_REPLACEMENTS: ReplacementCategory = {
  name: 'parentheses',
  description: 'Standardize parentheses sizing using regex patterns',
  isRegex: true,
  flags: 'g',
  patterns: {
    // Regular parentheses
    '\\\\big\\(([^\\n]*?)\\\\big\\)': '($1)',
    '\\\\big\\[([^\\n]*?)\\\\big\\]': '[$1]',
    '\\\\bigl\\(([^\\n]*?)\\\\bigr\\)': '($1)',
    '\\\\bigl\\[([^\\n]*?)\\\\bigr\\]': '[$1]',

    // Big to \left \right
    '\\\\Big\\(([^\\n]*?)\\\\Big\\)': '\\left($1\\right)',
    '\\\\Big\\[([^\\n]*?)\\\\Big\\]': '\\left[$1\\right]',
    '\\\\Big\\{([^\\n]*?)\\\\Big\\}': '\\left\\{$1\\right\\}',

    // Big parentheses to \left \right

    '\\\\Bigl\\(([^\\n]*?)\\\\Bigr\\)': '\\left($1\\right)',
    '\\\\Bigl\\[([^\\n]*?)\\\\Bigr\\]': '\\left[$1\\right]',
    '\\\\Bigl\\\\{([^\\n]*?)\\\\Bigr\\\\}': '\\left\\{$1\\right\\}',

    // Bigger parentheses
    '\\\\biggl\\(([^\\n]*?)\\\\biggr\\)': '\\left($1\\right)',
    '\\\\biggl\\[([^\\n]*?)\\\\biggr\\]': '\\left[$1\\right]',
    '\\\\biggl\\\\{([^\\n]*?)\\\\biggr\\\\}': '\\left\\{$1\\right\\}',

    // Biggest parentheses
    '\\\\Biggl\\(([^\\n]*?)\\\\Biggr\\)': '\\left($1\\right)',
    '\\\\Biggl\\[([^\\n]*?)\\\\Biggr\\]': '\\left[$1\\right]',
    '\\\\Biggl\\\\{([^\\n]*?)\\\\Biggr\\\\}': '\\left\\{$1\\right\\}',
  },
};

// TikZ picture fixes
// Using ECMAScript 2018 named capture groups (?<name>pattern)
// Similar to Python's (?P<name>pattern)
const TIKZ_REPLACEMENTS: ReplacementCategory = {
  name: 'tikz',
  description: 'Fixes for TikZ picture formatting and structure',
  isRegex: true,
  flags: 'gms',
  patterns: {
    '(?<indent>[\\t ]*)}\s*\\end{tikzpicture};\s*\\end{tikzpicture}':
      '${indent}\\end{tikzpicture}\n${indent}};\n${indent}\\end{tikzpicture}',
    '\\end{document}\\s*\\chapter': '\\chapter',
    '\\end{document}\\s*\\addcontentsline': '\\addcontentsline',
    '}(\\s*)\\end{tikzpicture};': '};$1\\end{tikzpicture}',
    '}(\\s*)\\end{tikzpicture}\\DIFaddendFL ;':
      '$1\\end{tikzpicture}};\DIFaddendFL',
  },
};

// LaTeX inline math formatting fixes
const INLINE_MATH_REPLACEMENTS: ReplacementCategory = {
  name: 'inlineMath',
  description: 'Fixes for LaTeX inline math formatting',
  isRegex: true,
  flags: 'g',
  patterns: {
    '\\\\\\(\\s*(.*?)\\s*\\\\\\)': '$$$1$',
    '\\[-?\\d+pt\\]': '', // Remove [Npt] spacing commands with arbitrary integers
    '\\[-?\\d+mm\\]': '', // Remove [Nmm] spacing commands with arbitrary integers
    '\\[-?\\d+ex\\]': '', // Remove [Nex] spacing commands with arbitrary integers
    '\\[0\\.-?\\d+mm\\]': '', // Remove [0.Nmm] spacing commands with arbitrary integers
    '\\[0\\.-?\\d+ex\\]': '', // Remove [0.Nex] spacing commands with arbitrary integers
    '\\\\hspace\\[-?\\d+pt\\]': '', // Remove \hspace[Npt] commands with arbitrary integers
    '\\\\hspace\\{-?\\d+mm\\}': '', // Remove \hspace{Nmm} commands with arbitrary integers
    '\\\\hspace\\{-?\\d+ex\\}': '', // Remove \hspace{Nex} commands with arbitrary integers
    '\\\\vspace\\{-?\\d+pt\\}': '', // Remove \vspace[Npt] commands with arbitrary integers
    '\\\\vspace\\{-?\\d+mm\\}': '', // Remove \vspace{Nmm} commands with arbitrary integers
    '\\\\vspace\\{-?\\d+ex\\}': '\n', // Remove \vspace{Nex} commands with arbitrary integers
    // '“([a-zA-Z0-9_]+)”': '``$1''',
  },
};

/**
 * Get all non-regex replacements combined into a single category.
 */
export function getAllReplacements(): ReplacementCategory {
  const allPatterns: { [key: string]: string } = {};
  const categories = [
    // LaTeX Content Formatting
    EQUATION_REPLACEMENTS,
    SECTION_REPLACEMENTS,
    CHARACTER_REPLACEMENTS,
    LATEX_SPACING_REPLACEMENTS,
    // XML/Structural Formatting
    LATEX_XML_REPLACEMENTS,
    SCRATCHPAD_XML_REPLACEMENTS,
    STYLE_REPLACEMENTS,
    // Personal Style
    PERSONAL_STYLE_REPLACEMENTS,
  ];

  for (const category of categories) {
    if (!category.isRegex) {
      Object.assign(allPatterns, category.patterns);
    }
  }

  return {
    name: 'all',
    description: 'Combined non-regex replacements',
    isRegex: false,
    patterns: allPatterns,
  };
}

/**
 * Get replacement patterns for a specific category.
 */
export function getReplacementsByCategory(
  categoryName: string,
): ReplacementCategory | undefined {
  const categories: { [key: string]: ReplacementCategory } = {
    equations: EQUATION_REPLACEMENTS,
    sections: SECTION_REPLACEMENTS,
    tikz: TIKZ_REPLACEMENTS,
    characters: CHARACTER_REPLACEMENTS,
    latex_xml: LATEX_XML_REPLACEMENTS,
    scratchpad_xml: SCRATCHPAD_XML_REPLACEMENTS,
    style: STYLE_REPLACEMENTS,
    inlineMath: INLINE_MATH_REPLACEMENTS,
    personal_style: PERSONAL_STYLE_REPLACEMENTS,
    latex_spacing: LATEX_SPACING_REPLACEMENTS,
  };

  return categories[categoryName];
}

/**
 * Get all regex replacement categories in order of application.
 */
export function getAllReplacementsRegex(): ReplacementCategory[] {
  return [
    INLINE_MATH_REPLACEMENTS,
    TIKZ_REPLACEMENTS,
    PARENTHESES_REPLACEMENTS,
  ];
}

// maybe i can even do this for strings<some length...

/**
 * Apply replacements to text, handling both regex and non-regex patterns.
 */
export function applyReplacements(
  text: string,
  replacements: ReplacementCategory | ReplacementCategory[],
): string {
  // Convert single category to array for unified handling
  const replacementArray = Array.isArray(replacements)
    ? replacements
    : [replacements];

  // Process all replacements in order
  for (const category of replacementArray) {
    if (category.isRegex) {
      for (const [pattern, repl] of Object.entries(category.patterns)) {
        try {
          text = text.replace(
            new RegExp(pattern, category.flags),
            repl as string,
          );
        } catch (regexErr) {
          logger.error(
            CHANNEL,
            `Error with regex pattern "${pattern}": ${regexErr instanceof Error ? regexErr.message : String(regexErr)}`,
          );
        }
      }
    } else {
      for (const [old, newText] of Object.entries(category.patterns)) {
        text = text.replaceAll(old, newText as string);
      }
    }
  }
  return text;
}
