// Local imports - replacement
import { ReplacementCategory } from '@replacement/types';

export const SCRATCHPAD_XML_REPLACEMENTS: ReplacementCategory = {
  name: 'scratchpad_xml',
  description: 'Fixes for scratchpad XML processing',
  isRegex: false,
  patterns: {
    // For Deepseek models:
    'null<scratchpad>': '<scratchpad>',
    '\\end{document}null': '\\end{document}',
    // gemini
    '\\begin{document}t}': '\\begin{document}',
    '\\end{document}t}': '\\end{document}',
    'null\n</latex_document>': '\n</latex_document>',
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
    // '```\n</latex_document>': '</latex_document>',
    // Special LaTeX content handling
    '</scratchpad>\n\\section{':
      '</scratchpad>\n\\<latex_document>\n\\section{',
    '</scratchpad>\n\\begin{document}':
      '</scratchpad>\n\\<latex_document>\n\\begin{document}',
    // Rebuttal package fixes
    '<rebuttal_package><scratchpad>\n\n<rebuttal_package><scratchpad>':
      '<rebuttal_package><scratchpad>',
  },
};
