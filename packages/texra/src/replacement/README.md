# Replacement rules

The replacement engine owns ordered, configurable normalization of LaTeX and
model-written text. `engine.ts` is the public policy boundary: callers use its
profiles rather than selecting rule tables themselves.

The files have distinct roles:

- `rules.ts` contains literal substitutions, including the focused
  `personal_style` category for prose, spacing, and preferred LaTeX forms.
- `rulesRegex.ts` contains context-sensitive substitutions. Its
  `personal_style_contextual` category complements `personal_style` where a
  literal replacement would alter macro definitions or other protected text.
- `maxRules.ts` contains the independently configurable `max_style` and
  `max_style_regex` categories. These are the comprehensive Max shorthand and
  notation preset: generated command shortcuts, manual aliases, and broader
  mathematical typography rules. They are not a second implementation of the
  focused `personal_style` category, and users may enable either preset
  independently.
- `advanced.ts` contains whole-document transformations that do not fit the
  table representation.
- `patterns.ts` (`createPatterns`, and the backslash fixes both rule files
  use) and `constants.ts` support construction of the rule tables; a
  generator one table uses is written at that table. a plain category is a bare
  `Record<string, string>` and `types.ts` defines the regex rule set.

Keep rules in their existing category when extending a preset. A rule shared
by two categories should have one generated source in `patterns.ts`, while each
category remains an explicit configuration choice. New callers should enter
through `replacementEngine` in `engine.ts`.
