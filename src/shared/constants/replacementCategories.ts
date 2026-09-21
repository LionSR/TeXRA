/**
 * The replacement categories, in the order the engine applies them.
 *
 * One declaration, read two ways: it is the universe of names the persisted
 * config accepts (`z.enum`, the LaTeX tab's checkboxes) and it is the
 * application order the engine iterates, which is behavior — a non-regex
 * category applied later wins a duplicated pattern key, and a regex category
 * applied later rewrites what an earlier one produced. `@replacement/engine`
 * keys its rule table by these names as a `Record`, so a name here with no
 * rules, or rules under a name that is not here, fails to typecheck; there is
 * no second list to drift from this one.
 *
 * Shared by the `replacement` subsystem (category dispatch), the core-settings
 * schema (persisted config validation), the settings-view message schemas, and
 * the LaTeX tab UI. Split out of the old `@shared/constants/latex` dumping
 * ground.
 */

export const NON_REGEX_REPLACEMENT_CATEGORIES = [
  'equations',
  'sections',
  'latex_forbidden_commands',
  'characters',
  'font_commands',
  'unicode',
  'html_entities',
  'latex_spacing',
  'latex_xml',
  'gptness',
  'personal_style',
  'max_style',
  'latexdiff',
] as const;

export const REGEX_REPLACEMENT_CATEGORIES = [
  'equation_macros',
  'fenced_latex_blocks',
  'inline_math',
  'parentheses',
  'latexdiff_markup',
  'equation_style',
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
