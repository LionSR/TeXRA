import { WorkspaceStateKey } from '@shared/state/stateKeys';

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
export interface NumericRange {
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
export type LatexdiffMathMarkupValue =
  (typeof LATEXDIFF_MATH_MARKUP_VALUES)[number];

/** Allowed values for the LaTeX formatter selector. */
export const LATEX_FORMATTER_VALUES = [
  'latexindent',
  'tex-fmt',
  'none',
] as const;
export type LatexFormatterValue = (typeof LATEX_FORMATTER_VALUES)[number];

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
 * Webview-facing field name → WorkspaceStateKey. Single source of truth for
 * both read and write paths, replacing per-handler maps that previously
 * duplicated this list.
 */
export const LATEX_FIELD_TO_KEY = {
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
} as const;
export type LatexConfigField = keyof typeof LATEX_FIELD_TO_KEY;

/**
 * Replacement-related webview field name → core config key (`texra.latex.*`).
 * Unlike {@link LATEX_FIELD_TO_KEY} these live in core config, not
 * WorkspaceState. Shared by the settings-view frontend (LaTeXTab) and the
 * backend persistence controller so the two sides of the wire can't drift.
 */
export const LATEX_REPLACEMENT_FIELD_TO_CONFIG_KEY = {
  wrapCritiqueInAlign: 'texra.latex.wrapCritiqueInAlign',
  enabledReplacements: 'texra.latex.enabledReplacements',
  enabledReplacementsRegex: 'texra.latex.enabledReplacementsRegex',
  customReplacementsRegex: 'texra.latex.customReplacementsRegex',
  customReplacements: 'texra.latex.customReplacements',
} as const;
