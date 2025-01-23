/**
 * Utilities for managing text replacements in the codebase.
 */

// Local imports - log
import * as logger from '../logger/logUtils';

const CHANNEL = 'Utils';
logger.initialize(CHANNEL);

interface ReplacementCategory {
  name: string;
  description: string;
  patterns: { [key: string]: string };
  isRegex?: boolean;
  flags?: string; // Optional regex flags
}

// ===== LaTeX Content Formatting =====

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

    // Fix backslash spacing
    ' \\;': ' ',
    ' \\; ': ' ',
    ' \\,\\': ' \\',
    '\\,\n': '\n',
    '\n    \\\\': '\\\\',

    // Fix operator spacing
    '\\;+\\;': '+',
    '\\;-\\;': '-',
    '\\;*\\;': '*',
    '\\;/\\;': '/',
    '\\;=\\;': '=',
    '+\\;': '+',
    '-\\;': '-',
    '=\\;': '=',
    '\\!\\!': '',
    // Standardize parentheses sizing
    '\\bigl(': '(',
    '\\bigr)': ')',
    '\\bigl[': '[',
    '\\bigr]': ']',
    '\\Bigl(': '\\left(',
    '\\Bigr)': '\\right)',
    '\\Bigl[': '\\left[',
    '\\Bigr]': '\\right]',
    '\\Bigl\\{': '\\left\\{',
    '\\Bigr\\}': '\\right\\}',
    '\\biggl(': '\\left(',
    '\\biggr(': '\\right(',
    '\\biggl[': '\\left[',
    '\\biggr]': '\\right]',
    '\\biggl\\{': '\\left\\{',
    '\\biggr\\}': '\\right\\}',
    '\\Biggl(': '\\left(',
    '\\Biggr)': '\\right)',
    '\\Biggl[': '\\left[',
    '\\Biggr[': '\\right[',
    '\\Biggl\\{': '\\left\\{',
    '\\Biggr\\}': '\\right\\}',

    // Align environment formatting
    '\n    \\nonumber\\\\': '\\nonumber\\\\',
    '\n    +': ' +',
    '\n    \n&=': '\n    &=',
    '\n    ,\n': ',\n',
    '\!\n    ': '\n    ',
    '\n    =\n': ' =',
    '\n     &\n    -': '\n    & -',
    '(\n    ': '(',
    '\n    )': ')',

    // Fix extra spacing in specific contexts
    'e^{\\,i\\,': 'e^{i ',
    'e^{\\,': 'e^{',
    '-\\,i\\, ': '-i ',
    '-\\,i\\,': '-i',
    '\\,i\\,': ' i ',
    '-\\,': '-',
    '\\,&': ' &',
    '{-\\,0}': '{0}',
    '{-\\,1}': '{1}',
    // Remove unnecessary skip commands
    '\\medskip\n': '',
    '\\smallskip\n': '',
    '\\bigskip\n': '',

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

    // Max's writing style preferences
    '\\dd\\bze\\,': '\\dd\\bze~',
    '\\dd\\bxi\\,': '\\dd\\bxi~',
    '\\dd\\beta\\,': '\\dd\\beta~',
    '\\dd\\tau\\,': '\\dd\\tau~',
    '\\dd\\t\\,': '\\dd\\t~',
    '\\dd\\bx\\,': '\\dd\\bx~',
    '\\dd\\bz\\,': '\\dd\\bz~',
    // Fix dollar signs: 40: You should put punctuation outside inner math mode.
    '.$': '$.',
    ',$': '$,',
    '$-\\,': '$-',
    '.  ': '. ',
    // Single fix for extra \;, \, etc: aggressive
    '\\;': ' ',
    '\\,': ' ',
    '\\left[\\dots\\right]': '[\\dots]',
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
    // LaTeX to XML conversions
    '\\end{scratchpad}': '</scratchpad>',
    '\\end\n': '\\end{document}\n',
    '</figure>\n': '\\end{figure}\n',
    '\\begin{latex_document}': '<latex_document>',
    'Here is the revised \\LaTeX document.\n\n```latex':
      'Here is the revised \\LaTeX document.\n\n<latex_document>',
    // Scratchpad and latex_document handling
    '<scratchpad>\n<scratchpad>\n': '<scratchpad>\n',
    '<scratchpad>\n```latex\n': '<scratchpad>\n<latex_document>\n',
    '```\n</scratchpad>\n</latex_document>': '</latex_document>',
    '</latex_document>\n```\n</latex_document>': '</latex_document>\n',
    '</latex_document>\n</latex_document>': '</latex_document>\n',
    '</latex_document>\n\n</latex_document>': '</latex_document>\n',
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
    // Special cases for monologue handling
    '</monologue><monologue>': '</monologue>\\n<monologue>', // Add newline between monologues
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
    'delving into': 'discussing',
    "It's important to note": 'Note that',
    'our exploration': 'our discussion',
    embark: 'start',
    realm: 'area',
    intricate: 'complex',
    '"exact"': "``exact''",
  },
};

// ===== Regex replacements =====

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
    '\\\\hspace\\[-?\\d+pt\\]': '', // Remove \hspace[Npt] commands with arbitrary integers
    '\\\\hspace\\{-?\\d+pt\\}': '',
  },
};

const AUTO_CONFIRM_REPLACEMENTS: ReplacementCategory = {
  name: 'autoConfirmation',
  description: 'Fixes for auto confirmation writing with regex patterns',
  isRegex: true,
  flags: 'gms',
  patterns: {
    // Match the entire confirmation message block and reformat
    '<latex_code>\\s*<monologue>\\[Due to length limits,[^\\n]*\\n(.*?)</monologue>':
      '<monologue>[Due to length limits,$1</monologue>\\n<latex_code>',
    // Handle case where latex_document tag precedes the monologue
    '<latex_code>\\s*<monologue>\\[I apologize, but I notice this is a very long document,[^\\n]*\\n(.*?)</monologue>':
      '<monologue>[I apologize, but I notice this is a very long document$1</monologue><latex_code>',
    // Handle truncated request messages
    '<latex_code>\\s*(<monologue>\\[Previous request was truncated due to length,[^\\n]*\\n(.*?)</monologue>)':
      '$1',
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
    // XML/Structural Formatting
    LATEX_XML_REPLACEMENTS,
    SCRATCHPAD_XML_REPLACEMENTS,
    STYLE_REPLACEMENTS,
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
    autoConfirmation: AUTO_CONFIRM_REPLACEMENTS,
    inlineMath: INLINE_MATH_REPLACEMENTS,
  };

  return categories[categoryName];
}

/**
 * Get all regex replacement categories in order of application.
 */
export function getAllReplacementsRegex(): ReplacementCategory[] {
  return [INLINE_MATH_REPLACEMENTS, TIKZ_REPLACEMENTS];
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
