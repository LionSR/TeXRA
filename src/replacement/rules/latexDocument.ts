// Local imports - replacement
import { ReplacementCategory } from '@replacement/types';

export const LATEX_DOCUMENT_REPLACEMENTS: ReplacementCategory = {
  name: 'latex_document',
  description: 'Fixes for LaTeX document structure, code blocks, and cleanup',
  isRegex: false,
  patterns: {
    '\\end {': '\\end{',
    '\\begin {': '\\begin{',
    // ===== 7. CODE BLOCK AND DOCUMENT HANDLING =====
    '```latex\n\\documentclass{lecture}':
      '<latex_document>\n\\documentclass{lecture}',
    '```latex\n\\documentclass[': '<latex_document>\n\\documentclass[',
    '<latex_document>\n```latex': '<latex_document>\n',
    'Here is the revised \\LaTeX document.\n\n```latex':
      'Here is the revised \\LaTeX document.\n\n<latex_document>',
    '```latex\n<latex_document>\n': '\n<latex_document>\n',
    '<latex_document>\n<latex_document>': '<latex_document>',
    '<scratchpad>\n<scratchpad>\n': '<scratchpad>\n',
    '<scratchpad>\n```latex\n': '<scratchpad>\n<latex_document>\n',
    '<scratchpad>```latex': '<scratchpad>\n<latex_document>',
    // '```\n</scratchpad>\n</latex_document>': '</latex_document>',
    // '</latex_document>\n```\n</latex_document>': '</latex_document>\n',
    '</latex_document>\n</latex_document>': '</latex_document>\n',
    '</latex_document>\n\n</latex_document>': '</latex_document>\n',

    // ===== 9. DOCUMENT STRUCTURE FIXES =====
    // '\\end{document}\n\n\\<document name=':
    //   '\\end{document}\\n</document>\\n\\<document name=',
    '\\end{document}nd{document}': '\\end{document}\n</document>',
    '\\end{document}\n\\end{document}\n<document name=':
      '\\end{document}\n</document>\n<document name=',
    // '\\end{document}\n\\<document name=':
    //   '\\end{document}\n</document>\n\\<document name=',
    '\\end{latex_document}\n</latex_document>':
      '\\end{document}\n</latex_document>',
    '\\end{document}\n\\end{document}\n</latex_documents>':
      '\\end{document}\n</document>\n</latex_documents>',
    // The following two might be aggressive
    '\\end{document}\n</latex_documents>':
      '\\end{document}\n</document>\n</latex_documents>',
    '\\end{document}\n\n<document name':
      '\\end{document}\n</document>\n\n<document name',
    '\\end{document}\n<document name':
      '\\end{document}\n</document>\n<document name',
    '\\end{document}\n</rebuttal_package>':
      '\\end{document}\n</document>\n</rebuttal_package>',
    '<latex_document>\n```xml<latex_document>': '<latex_document>\n',
    '{\\today}\n\n[Previous':
      '{\\today}\n\n\\begin{document}\n\\makeheader[Previous',

    // ===== 11. CLEANUP AND MISCELLANEOUS =====
    '<ctrl96>': '',
    '<document name="">': '<document name="unknown">',
    '<?xml version="1.0" encoding="UTF-8"?>': '',
    '% 1ST_UPDATED_LATEX_DOCUMENT HERE\n': '',
    '% 2ND_UPDATED_LATEX_DOCUMENT HERE\n': '',
    '\\begin{<latex_document>\nalign': '\\begin{align',
    '\\begin{<latex_document>\nequation': '\\begin{equation',
    '\\begin{<latex_document>\nitemize': '\\begin{itemize',
    '\\begin{<latex_document>\nenumerate': '\\begin{enumerate}',
    '\\begin{<latex_document>\nfigure': '\\begin{figure}',
    '\\begin{<latex_document>\ntikzpicture': '\\begin{tikzpicture}',
    '<xml:documents>': '<latex_documents>',
    '</xml:documents>': '</latex_documents>',
    '```xml\n': '',
    '</xml>': '',
    '\\end{document>': '\\end{document}',
    '\\end{document>\n': '\\end{document}\n',
    '\\end\n': '\\end{document}\n',

    // ===== Debtable one-offs =====
  },
};
