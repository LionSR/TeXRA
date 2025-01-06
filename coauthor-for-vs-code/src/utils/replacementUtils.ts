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
}

// ===== LaTeX Content Formatting =====

// Common LaTeX equation spacing fixes
const EQUATION_REPLACEMENTS: ReplacementCategory = {
  name: 'equations',
  description: 'Fixes for LaTeX equation spacing and formatting',
  patterns: {
    '\n\n\\begin{align}': '\n\\begin{align}',
    '\\end{align}\n\n': '\\end{align}\n',
    '\n\n\\begin{equation}': '\n\\begin{equation}',
    '\\end{equation}\n\n': '\\end{equation}\n',
  },
};

// Section spacing fixes
const SECTION_REPLACEMENTS: ReplacementCategory = {
  name: 'sections',
  description: 'Fixes for section spacing in LaTeX documents',
  patterns: {
    '\\end{align}\n\\section': '\\end{align}\n\n\n\\section',
    '\\end{equation}\n\\section': '\\end{equation}\n\n\n\\section',
    '\\end{align}\n\\subsection': '\\end{align}\n\n\n\\subsection',
    '\\end{equation}\n\\subsection': '\\end{equation}\n\n\n\\subsection',
    '\\end{align}\n\\paragraph': '\\end{align}\n\n\n\\paragraph',
    '\\end{equation}\n\\paragraph': '\\end{equation}\n\n\n\\paragraph',
  },
};

// TikZ picture fixes
// Using ECMAScript 2018 named capture groups (?<name>pattern)
// Similar to Python's (?P<name>pattern)
const TIKZ_REPLACEMENTS: ReplacementCategory = {
  name: 'tikz',
  description: 'Fixes for TikZ picture formatting and structure',
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

// Special character replacements
const CHARACTER_REPLACEMENTS: ReplacementCategory = {
  name: 'characters',
  description: 'Fixes for special characters and diacritics',
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
  patterns: {
    // Basic tag fixes
    '\\end{document>}': '\\end{document}',
    '\\end{figure>}': '\\end{figure}',
    '\\end{tikzpicture>}': '\\end{tikzpicture}',
    '\\end{revised_statement>}': '</revised_statement>',
    '\\end{scope>}': '\\end{scope}',
    '\\end{latex_document>}': '</latex_document>\n',
    '\\end{output>}': '\\end{output}',
    '\\end{response>}': '\\end{response}',
    '\\end{scratchpad>}': '</scratchpad>',
    '\\end{itemize>}': '\\end{itemize}',
    // LaTeX to XML conversions
    '\\end{scratchpad}': '</scratchpad>',
    '\\end\n': '\\end{document}\n',
    '</figure>\n': '\\end{figure}\n',
    '\\begin{latex_document}': '<latex_document>',
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

const AUTO_CONFIRM_REPLACEMENTS: ReplacementCategory = {
  name: 'autoConfirmation',
  description: 'Fixes for auto confirmation writing with regex patterns',
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
 * Get all replacement patterns combined into a single dictionary.
 */
export function getAllReplacements(): { [key: string]: string } {
  const allReplacements: { [key: string]: string } = {};
  const categories = [
    // LaTeX Content Formatting
    EQUATION_REPLACEMENTS,
    SECTION_REPLACEMENTS,
    TIKZ_REPLACEMENTS,
    CHARACTER_REPLACEMENTS,
    // XML/Structural Formatting
    LATEX_XML_REPLACEMENTS,
    SCRATCHPAD_XML_REPLACEMENTS,
    // Style and Content Improvements
    STYLE_REPLACEMENTS,
    // AUTO_CONFIRM_REPLACEMENTS,
  ];

  for (const category of categories) {
    Object.assign(allReplacements, category.patterns);
  }
  return allReplacements;
}

/**
 * Get replacement patterns for a specific category.
 */
export function getReplacementsByCategory(categoryName: string): {
  [key: string]: string;
} {
  const categories: { [key: string]: ReplacementCategory } = {
    equations: EQUATION_REPLACEMENTS,
    sections: SECTION_REPLACEMENTS,
    tikz: TIKZ_REPLACEMENTS,
    characters: CHARACTER_REPLACEMENTS,
    latex_xml: LATEX_XML_REPLACEMENTS,
    scratchpad_xml: SCRATCHPAD_XML_REPLACEMENTS,
    style: STYLE_REPLACEMENTS,
    autoConfirmation: AUTO_CONFIRM_REPLACEMENTS,
  };

  return categories[categoryName]?.patterns || {};
}

/**
 * Apply a dictionary of replacements to the given text.
 */
export function applyReplacements(
  text: string,
  replacements: { [key: string]: string },
): string {
  try {
    for (const [old, newText] of Object.entries(replacements)) {
      text = text.replaceAll(old, newText);
    }
    return text;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error applying replacements: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Apply a dictionary of regex replacements to the given text.
 */
export function applyReplacementRegex(
  text: string,
  replacements: { [key: string]: string },
  flags: string = '',
): string {
  try {
    for (const [pattern, repl] of Object.entries(replacements)) {
      try {
        text = text.replace(new RegExp(pattern, flags), repl);
      } catch (regexErr) {
        // Log specific regex errors but continue with other replacements
        logger.error(
          CHANNEL,
          `Error with regex pattern "${pattern}": ${regexErr instanceof Error ? regexErr.message : String(regexErr)}`,
        );
      }
    }
    return text;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error applying regex replacements: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
