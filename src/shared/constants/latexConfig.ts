import { WorkspaceStateKey } from '@shared/state/stateKeys';

import type {
  NonRegexReplacementCategory,
  RegexReplacementCategory,
} from './replacementCategories';

/**
 * LaTeX/compile/diff configuration — single source of truth.
 *
 * These constants are imported by:
 *   - readers in src/agent/, src/latex/, src/housekeeping/, src/commands/
 *   - the inbound/outbound message schemas in src/shared/schemas/
 *   - the native LaTeX settings handlers and tab UI
 * so changing a default or range here propagates everywhere with no rot.
 * Split out of the old `@shared/constants/latex` dumping ground.
 */

/** Numeric range for a setting (used by Zod schemas and UI inputs). */
interface NumericRange {
  readonly min: number;
  readonly max?: number;
}

/** Allowed values for the `latexdiff` math-markup mode. */
export const LATEXDIFF_MATH_MARKUP_VALUES = [
  'off',
  'whole',
  'coarse',
  'fine',
] as const;
type LatexdiffMathMarkupValue = (typeof LATEXDIFF_MATH_MARKUP_VALUES)[number];

/** Allowed values for the LaTeX formatter selector. */
export const LATEX_FORMATTER_VALUES = [
  'latexindent',
  'tex-fmt',
  'none',
] as const;
type LatexFormatterValue = (typeof LATEX_FORMATTER_VALUES)[number];

/** Documented defaults — match the values that used to live in package.json. */
export const LATEX_CONFIG_DEFAULTS = {
  workflowAutoCompile: true,
  workflowAutoCompileTimeoutMs: 120000,
  workflowAutoOpenPdf: true,
  workflowRejectOnCompileFailure: true,
  latexdiffBetweenRounds: false,
  latexdiffTimeoutMs: 10000,
  latexdiffMathMarkup: 'coarse' as LatexdiffMathMarkupValue,
  latexdiffChangesOnly: true,
  latexFormatter: 'latexindent' as LatexFormatterValue,
} as const;

/** Numeric ranges (used by Zod schemas and UI inputs). */
export const LATEX_CONFIG_RANGES = {
  workflowAutoCompileTimeoutMs: { min: 10000 } satisfies NumericRange,
  latexdiffTimeoutMs: { min: 1000, max: 80000 } satisfies NumericRange,
} as const;

/**
 * The value type each LaTeX setting renders, keyed by its canonical `texra.*`
 * catalog key — the same key the snapshot arrives under and the same key a
 * write posts back, so the tab addresses a setting exactly one way. Restated
 * here rather than derived because the catalog is runtime-typed
 * (`settingSchemaWithoutPrefault` returns `unknown`) — the same bargain the 26
 * other catalog-backed signals strike in `settingsState.ts`, where
 * `settingSignal<T>` names the value type beside the key. The values
 * themselves are validated by each row's own catalog schema at the snapshot
 * wire boundary (`snapshotMessage` in `@shared/schemas/settingsViewMessages`),
 * so this type describes what already arrived rather than guarding it.
 */
interface LatexConfigValueTypes {
  [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE]: boolean;
  [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS]: number;
  [WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF]: boolean;
  [WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE]: boolean;
  [WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS]: boolean;
  [WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS]: number;
  [WorkspaceStateKey.LATEXDIFF_MATH_MARKUP]: LatexdiffMathMarkupValue;
  [WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY]: boolean;
  [WorkspaceStateKey.LATEX_FORMATTER]: LatexFormatterValue;
  'texra.latex.wrapCritiqueInAlign': boolean;
  'texra.latex.enabledReplacements': NonRegexReplacementCategory[];
  'texra.latex.enabledReplacementsRegex': RegexReplacementCategory[];
  'texra.latex.customReplacementsRegex': Record<string, string>;
  'texra.latex.customReplacements': Record<string, string>;
}

/**
 * Catalog-keyed projection of the LaTeX snapshot the settings view renders.
 * Partial because the signal starts empty and fills in when the snapshot
 * lands.
 */
export type LatexConfigValues = Partial<LatexConfigValueTypes>;

/**
 * Every LaTeX setting the tab renders, by canonical catalog key. Declared as a
 * key set rather than a list so the `satisfies` checks both directions, the way
 * the deleted `LATEX_CONFIG_FIELD_TO_KEY` did: a key added to
 * {@link LatexConfigValueTypes} with no entry here fails `Record`, and an entry
 * here that is not a rendered field fails the excess-property check.
 *
 * The message dispatcher reports a snapshot whose rows disagree with this set,
 * and `stateSettings.vitest.ts` checks each key still names a catalog row. The
 * five `texra.latex.*` literals need that check; the nine `WorkspaceStateKey`
 * members are already the catalog's own spelling.
 */
export const LATEX_CONFIG_KEYS = {
  [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE]: true,
  [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS]: true,
  [WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF]: true,
  [WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE]: true,
  [WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS]: true,
  [WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS]: true,
  [WorkspaceStateKey.LATEXDIFF_MATH_MARKUP]: true,
  [WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY]: true,
  [WorkspaceStateKey.LATEX_FORMATTER]: true,
  'texra.latex.wrapCritiqueInAlign': true,
  'texra.latex.enabledReplacements': true,
  'texra.latex.enabledReplacementsRegex': true,
  'texra.latex.customReplacementsRegex': true,
  'texra.latex.customReplacements': true,
} as const satisfies Record<keyof LatexConfigValueTypes, true>;
