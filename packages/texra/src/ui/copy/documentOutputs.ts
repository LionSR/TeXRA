/**
 * How a document task's rounds read in every renderer (the progress view's
 * generated-files list and the terminal's run details): each alert's words
 * and tone, and how a latexdiff comparison's status is painted, so one
 * round cannot read two ways.
 */
import type { LatexdiffEntry } from '@texra/shared/plugins/documentOutputs';
import type { RunTone, StatusLook } from '@ui/copy/runStatus';

/** The heading over a run's outputs. */
export const GENERATED_FILES_LABEL = 'Generated files';

/** A round's alerts: what each says and the tone it paints with. A failed
 *  compile check is an error to fix; a round that wrote nothing, or not
 *  everything it was asked for, is a caution. */
export const ROUND_ALERT = Object.freeze({
  noDocuments: Object.freeze({
    text: 'Wrote no documents',
    tone: 'warning',
  }),
  /** The words before the missing output's name. */
  missingOutput: Object.freeze({ text: 'Missing output', tone: 'warning' }),
  compileFailed: Object.freeze({
    text: 'Compile check failed',
    tone: 'danger',
  }),
} as const satisfies Record<
  string,
  { readonly text: string; readonly tone: RunTone }
>);

/** How a latexdiff entry's status is painted, and its label where the
 *  status is otherwise a glyph only. */
export const LATEXDIFF_STATUS: Readonly<
  Record<LatexdiffEntry['status'], StatusLook & { readonly label: string }>
> = Object.freeze({
  ok: Object.freeze({ tone: 'success', label: 'Comparison succeeded' }),
  failed: Object.freeze({ tone: 'danger', label: 'Comparison failed' }),
});
