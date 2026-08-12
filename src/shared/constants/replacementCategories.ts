/**
 * Replacement-category constants and their default-enabled sets.
 *
 * Shared by the `replacement` subsystem (category dispatch), the core-settings
 * schema (persisted config validation), the settings-view message schemas, and
 * the LaTeX tab UI. Split out of the old `@shared/constants/latex` dumping
 * ground.
 */

export const NON_REGEX_REPLACEMENT_CATEGORIES = [
  'latex_spacing',
  'equations',
  'sections',
  'latex_forbidden_commands',
  'characters',
  'font_commands',
  'latex_xml',
  'unicode',
  'html_entities',
  'latexdiff',
  'gptness',
  'personal_style',
  'max_style',
] as const;

export const REGEX_REPLACEMENT_CATEGORIES = [
  'fenced_latex_blocks',
  'inline_math',
  'parentheses',
  'latexdiff_markup',
  'equation_style',
  'equation_macros',
  'personal_style_contextual',
  'max_style_regex',
] as const;

export type NonRegexReplacementCategory =
  (typeof NON_REGEX_REPLACEMENT_CATEGORIES)[number];
export type RegexReplacementCategory =
  (typeof REGEX_REPLACEMENT_CATEGORIES)[number];

export const DEFAULT_ENABLED_REPLACEMENTS = [
  'latex_spacing',
  'equations',
  'sections',
  'latex_forbidden_commands',
  'characters',
  'font_commands',
  'latex_xml',
  'unicode',
  'html_entities',
  'latexdiff',
  'gptness',
] satisfies NonRegexReplacementCategory[];

export const DEFAULT_ENABLED_REGEX_REPLACEMENTS = [
  'fenced_latex_blocks',
  'inline_math',
  'parentheses',
  'latexdiff_markup',
  'equation_style',
  'personal_style_contextual',
] satisfies RegexReplacementCategory[];
