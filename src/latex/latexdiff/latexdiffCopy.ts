/**
 * User-facing sentences for a latexdiff run's outcome.
 *
 * The VS Code command and the desktop stream-toolbar action drive the same
 * `runLatexdiffForExecution` and report the same outcomes; they differ only in
 * which dialog they route them through and how much detail they show (the
 * extension also reports partial success, which has one caller and stays
 * there). Keeping the sentences here is what stops the two hosts from
 * disagreeing about the wording of an outcome they compute identically.
 */

import type { MathMarkupOption } from './mathMarkup';

/** The run produced no diff operation to report on at all. */
export const NO_LATEXDIFF_OPERATIONS_MESSAGE =
  'No LaTeX diff operations available for this run.';

/** A single `runDiff` call returned no usable diff path. */
export const LATEXDIFF_GENERATE_FAILED_MESSAGE =
  'Failed to generate diff file.';

/**
 * Every operation in a run failed. No trailing period: this sentence belongs to
 * the markup-annotated family the extension also uses for its partial-success
 * and all-succeeded lines.
 */
export function latexdiffAllFailedMessage(
  mathMarkup: MathMarkupOption,
): string {
  return `All LaTeX diff operations failed (math markup: "${mathMarkup}")`;
}
