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
 * The value type each LaTeX field renders, as `LatexConfigValues` below
 * projects it. Restated here rather than derived because the catalog is
 * runtime-typed (`settingSchemaWithoutPrefault` returns `unknown`) — the same
 * bargain the 26 other catalog-backed signals strike in `settingsState.ts`,
 * where `settingSignal<T>` names the value type beside the key. The values
 * themselves are validated by each row's own catalog schema at the snapshot
 * wire boundary (`snapshotMessage` in `@shared/schemas/settingsViewMessages`),
 * so this type describes what already arrived rather than guarding it.
 */
interface LatexConfigValueTypes {
  workflowAutoCompile: boolean;
  workflowAutoCompileTimeoutMs: number;
  workflowAutoOpenPdf: boolean;
  workflowRejectOnCompileFailure: boolean;
  latexdiffBetweenRounds: boolean;
  latexdiffTimeoutMs: number;
  latexdiffMathMarkup: LatexdiffMathMarkupValue;
  latexdiffChangesOnly: boolean;
  latexFormatter: LatexFormatterValue;
  wrapCritiqueInAlign: boolean;
  enabledReplacements: NonRegexReplacementCategory[];
  enabledReplacementsRegex: RegexReplacementCategory[];
  customReplacementsRegex: Record<string, string>;
  customReplacements: Record<string, string>;
}

/**
 * Frontend field projection of the catalog-derived LaTeX snapshot. Partial
 * because the signal starts empty and fills in when the snapshot lands.
 */
export type LatexConfigValues = Partial<LatexConfigValueTypes>;

/**
 * Every frontend-facing LaTeX field → its canonical catalog key. This map is
 * the field set: the `satisfies` below fails to compile if a field is added to
 * (or removed from) {@link LatexConfigValueTypes} without a matching entry
 * here, in either direction. `miscSettingsSlice` uses the map to re-key the
 * snapshot at the wire boundary; `LaTeXTab` uses it for catalog-driven writes
 * and for the `latex-setting-<field>` control ids. `stateSettings.vitest.ts`
 * checks that every key here still names a catalog row.
 */
export const LATEX_CONFIG_FIELD_TO_KEY = {
  workflowAutoCompile: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
  workflowAutoCompileTimeoutMs:
    WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
  workflowAutoOpenPdf: WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF,
  workflowRejectOnCompileFailure:
    WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
  latexdiffBetweenRounds: WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS,
  latexdiffTimeoutMs: WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS,
  latexdiffMathMarkup: WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
  latexdiffChangesOnly: WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY,
  latexFormatter: WorkspaceStateKey.LATEX_FORMATTER,
  wrapCritiqueInAlign: 'texra.latex.wrapCritiqueInAlign',
  enabledReplacements: 'texra.latex.enabledReplacements',
  enabledReplacementsRegex: 'texra.latex.enabledReplacementsRegex',
  customReplacementsRegex: 'texra.latex.customReplacementsRegex',
  customReplacements: 'texra.latex.customReplacements',
} as const satisfies Record<keyof LatexConfigValueTypes, string>;
