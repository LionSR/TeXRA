// Shared constants for replacement engine

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

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const FENCED_LATEX_ENVIRONMENTS = [
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

export const FENCED_LATEX_ENVIRONMENT_PATTERN =
  FENCED_LATEX_ENVIRONMENTS.map(escapeRegExp).join('|');

const LINE_BREAK_PATTERN = String.raw`\r?\n`;

export const FENCED_LATEX_BLOCK_PATTERN = String.raw`(^|${LINE_BREAK_PATTERN})([ \t]*):::\s*(${FENCED_LATEX_ENVIRONMENT_PATTERN})(?:[^\S\r\n]*(?:${LINE_BREAK_PATTERN}([\s\S]*?))?${LINE_BREAK_PATTERN}[ \t]*|[^\S\r\n]*([^\r\n]*?))[ \t]*:::(?=${LINE_BREAK_PATTERN}|$)`;

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
