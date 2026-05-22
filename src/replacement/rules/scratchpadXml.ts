// Local imports - replacement
import { ReplacementCategory } from '@replacement/types';

/**
 * Scratchpad-only normalization. `<latex_document>` interactions live in
 * `latex_document` (see latexDocument.ts) so the legacy wrapper has a single
 * owner.
 */
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
    // Duplicate scratchpad tag fixes - remove redundant tags
    '<scratchpad><scratchpad>': '<scratchpad>',
    '<scratchpad> <scratchpad>': '<scratchpad>',
    '<scratchpad>\n<scratchpad>': '<scratchpad>',
    // Cover-letter transition (kept separate from <latex_document> handling)
    '<scratchpad><cover_letter>': '<scratchpad>\n</scratchpad>\n<cover_letter>',
    '<scratchpad>\n<cover_letter>':
      '<scratchpad>\n</scratchpad>\n<cover_letter>',
    // Rebuttal package fixes
    '<rebuttal_package><scratchpad>\n\n<rebuttal_package><scratchpad>':
      '<rebuttal_package><scratchpad>',
  },
};
