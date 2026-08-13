// Shared constants for replacement engine

import escapeRegExp from 'escape-string-regexp';

// Greek letters used for pattern generation
// prettier-ignore
export const GREEK_LETTERS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(' ');

// Section commands for LaTeX documents
export const SECTION_TYPES = [
  'chapter',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
];

// Common math operator names
// prettier-ignore
export const MATH_OPERATORS = [
  'cos',
  'sin',
  'tan',
  'arctan',
  'arccos',
  'arcsin',
  'log',
  'ln',
  'exp',
  'sqrt',
  'max',
  'min',
  'sup',
  'inf',
  'lim',
  'csc',
  'ker',
  'limsup',
  'deg',
  'gcd',
  'lg',
  'Pr',
  'cot',
  'det',
  'hom',
  'sec',
  'arg',
  'coth',
  'dim',
  'liminf',
];

const FENCED_LATEX_ENVIRONMENTS = [
  'align',
  'align*',
  'aligned',
  'aligned*',
  'alignat',
  'alignat*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'equation',
  'equation*',
  'cases',
  'cases*',
  'split',
  'pmatrix',
  'bmatrix',
  'vmatrix',
  'matrix',
  'smallmatrix',
];

const FENCED_LATEX_ENVIRONMENT_PATTERN =
  FENCED_LATEX_ENVIRONMENTS.map(escapeRegExp).join('|');

const LINE_BREAK_PATTERN = String.raw`\r?\n`;

// Multiline and inline bodies are parsed with distinct patterns so the intent of
// each branch stays readable. Both patterns capture the same groups:
// 1. Leading break (if present)
// 2. Block indentation
// 3. LaTeX environment name
// 4. Multiline body content (empty for inline matches)
// 5. Inline body content (empty for multiline matches)
export const FENCED_LATEX_BLOCK_PATTERN_MULTILINE = String.raw`(^|${LINE_BREAK_PATTERN})([ \t]*):::\s*(${FENCED_LATEX_ENVIRONMENT_PATTERN})[^\S\r\n]*(?:${LINE_BREAK_PATTERN}([\s\S]*?))?${LINE_BREAK_PATTERN}[ \t]*():::(?=${LINE_BREAK_PATTERN}|$)`;

// The inline pattern needs an explicit boundary after the environment name:
// without it, alternation order lets a prefix win (e.g. `::: aligned x :::`
// would match `align` and leak `ed ` into the body) because the catch-all
// inline body can absorb the leftover characters. The multiline pattern is
// immune since it requires a line break right after the name.
export const FENCED_LATEX_BLOCK_PATTERN_INLINE = String.raw`(^|${LINE_BREAK_PATTERN})([ \t]*):::\s*(${FENCED_LATEX_ENVIRONMENT_PATTERN})(?![\w*])[^\S\r\n]*()([^\r\n]*)[ \t]*:::(?=${LINE_BREAK_PATTERN}|$)`;

// Union of common LaTeX environments used across rules
// prettier-ignore
const BASE_LATEX_ENVIRONMENTS = [
  'figure',
  'figure*',
  'tikzpicture',
  'itemize',
  'enumerate',
  'tabular',
  'abstract',
  'theorem',
  'proof',
  'definition',
  'corollary',
  'lemma',
  'proposition',
  'remark',
  'example',
  'exercise',
  'problem',
  'solution',
  'acknowledgment',
  'minipage',
  'column',
  'columns',
  'verbatim',
  'lstlisting',
  'minted',
  'algorithm',
  'tcolorbox',
  'frame',
  'alertblock',
  'exampleblock',
  'axis',
  'scope',
  'response',
  'overpic',
  'overpic*',
  'section',
  'subsection',
  'referee',
  'letter',
  'array',
];

export const LATEX_ENVIRONMENTS = [
  ...BASE_LATEX_ENVIRONMENTS,
  ...FENCED_LATEX_ENVIRONMENTS,
];
