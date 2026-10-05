/**
 * The universe of replacement-category names the persisted config accepts.
 *
 * One declaration, read two ways: `z.enum` validates persisted settings
 * against it and the LaTeX tab renders its checkboxes in this order, so the
 * order here is the settings UI's order, not the engine's.
 * `@replacement/engine` keys its rule tables by these names as a `Record`, so
 * a name here with no rules, or rules under a name that is not here, fails to
 * typecheck; the order the engine applies them in is that table's own key
 * order, and there is no third list to drift from either.
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
