// Local imports - replacement
import { ReplacementCategory } from '@replacement/types';

/**
 * Single source of truth for `<latex_document>`-related normalization.
 *
 * The unified output protocol uses `<documents><document name="...">` (see
 * `extractDocuments` in `src/utils/text/xmlExtraction.ts`). `<latex_document>`
 * is the legacy single-document wrapper; the extractor still recognizes it as
 * a fallback so any rewrite that lands on a clean `<latex_document>` shape
 * remains parseable. Add new `<latex_document>` quirks here only — do not
 * scatter them across `latex_xml` or `scratchpad_xml`.
 */
export const LATEX_DOCUMENT_REPLACEMENTS: ReplacementCategory = {
  name: 'latex_document',
  description:
    'Normalize legacy <latex_document> wrappers (markdown fences, ' +
    '\\begin/\\end{latex_document}, scratchpad transitions, brace fixes).',
  isRegex: false,
  patterns: {
    // ===== Fenced ```latex blocks → <latex_document> =====
    '```latex\n\\documentclass{lecture}':
      '<latex_document>\n\\documentclass{lecture}',
    '```latex\n\\documentclass[': '<latex_document>\n\\documentclass[',
    '<latex_document>\n```latex': '<latex_document>\n',
    'Here is the revised \\LaTeX document.\n\n```latex':
      'Here is the revised \\LaTeX document.\n\n<latex_document>',
    '```latex\n<latex_document>\n': '\n<latex_document>\n',

    // ===== Scratchpad ↔ <latex_document> transitions =====
    // (Moved from scratchpad_xml so all <latex_document> handling lives here.)
    '<scratchpad>\n```latex\n': '<scratchpad>\n<latex_document>\n',
    '<scratchpad>```latex': '<scratchpad>\n<latex_document>',
    '<scratchpad>\n<latex_document>':
      '<scratchpad>\n</scratchpad>\n<latex_document>',
    '<scratchpad><latex_document>':
      '<scratchpad>\n</scratchpad>\n<latex_document>',
    '<scratchpad>\n```latex\n<latex_document>':
      '<scratchpad>\n</scratchpad>\n<latex_document>',
    '</scratchpad>\n```latex': '</scratchpad>\n<latex_document>',
    '</scratchpad>\n\n```latex': '</scratchpad>\n\n<latex_document>',
    '</scratchpad>\n    \n```latex': '</scratchpad>\n\n<latex_document>',
    '</scratchpad>\n\\section{':
      '</scratchpad>\n\\<latex_document>\n\\section{',
    '</scratchpad>\n\\begin{document}':
      '</scratchpad>\n\\<latex_document>\n\\begin{document}',
    'null\n</latex_document>': '\n</latex_document>',

    // ===== Duplicate-tag cleanup =====
    '<latex_document>\n<latex_document>': '<latex_document>',
    '</latex_document>\n</latex_document>': '</latex_document>\n',
    '</latex_document>\n\n</latex_document>': '</latex_document>\n',

    // ===== \begin{latex_document}/\end{latex_document} → tag form =====
    // (Moved out of generated latex_xml conversions so the legacy tag has a
    // single owner.)
    '\\begin{latex_document}': '<latex_document>',
    '\\end{latex_document}': '</latex_document>',
    '\\begin{latex_document>}': '<latex_document>',
    '\\begin{latex_document>': '<latex_document>',
    '\\end{latex_document>}': '</latex_document>',
    '\\end{latex_document>': '</latex_document>',
    '\\end{latex_document}\n</latex_document>':
      '\\end{document}\n</latex_document>',

    // ===== Brace-fix variants (moved out of latex_xml pureXmlTags loop) =====
    '<latex_document}': '<latex_document>',
    '</latex_document}': '</latex_document>',

    // ===== Stray-tag patches inside math environments =====
    '\\begin{<latex_document>\nalign': '\\begin{align',
    '\\begin{<latex_document>\nequation': '\\begin{equation',
    '\\begin{<latex_document>\nitemize': '\\begin{itemize',
    '\\begin{<latex_document>\nenumerate': '\\begin{enumerate}',
    '\\begin{<latex_document>\nfigure': '\\begin{figure}',
    '\\begin{<latex_document>\ntikzpicture': '\\begin{tikzpicture}',
    '<latex_document>\n```xml<latex_document>': '<latex_document>\n',

    // ===== Generic LaTeX whitespace fixes (kept here for back-compat) =====
    '\\end {': '\\end{',
    '\\begin {': '\\begin{',
  },
};
