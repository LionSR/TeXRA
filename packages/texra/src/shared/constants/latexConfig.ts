/**
 * The allowed values of the LaTeX settings with a fixed choice, read by the
 * setting rows (`documentsSettings.ts`, `texraSettings.ts`) and the code that
 * branches on them. Each row holds its own default and bounds.
 */

/** Allowed values for the `latexdiff` math-markup mode. */
export const LATEXDIFF_MATH_MARKUP_VALUES = [
  'off',
  'whole',
  'coarse',
  'fine',
] as const;
export type LatexdiffMathMarkupValue =
  (typeof LATEXDIFF_MATH_MARKUP_VALUES)[number];

/** Allowed values for the LaTeX formatter selector. */
export const LATEX_FORMATTER_VALUES = [
  'latexindent',
  'tex-fmt',
  'none',
] as const;
export type LatexFormatterValue = (typeof LATEX_FORMATTER_VALUES)[number];
