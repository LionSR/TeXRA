/**
 * The transcript export's own failure tag.
 *
 * It lives beside the writer because the GUI loads that writer lazily,
 * after a format is selected: a host that words a failed export names this
 * tag, and naming it must not pull the writer's module graph (the formatters,
 * the LaTeX compiler) into the app's startup.
 */

import { Schema } from 'effect';

/**
 * A step of the transcript export could not be carried out.
 *
 * The chain enters four surfaces that can fail outside its own typed
 * channels — the host's format picker, the export writer's load, the trace
 * assembler, and the host-supplied trace-viewer bundle the export itself
 * finds unusable. `step` says which one; `cause` is the value that step
 * produced, carried unchanged so a host's dialog classifies and words it
 * exactly as it did when that value reached the dispatcher bare. A step that
 * mints the fact itself carries the minted error, so the wording is the same
 * either way. The picker and lazy import each tag their own boundary failure.
 */
export class TranscriptExportFailed extends Schema.TaggedError<TranscriptExportFailed>()(
  'TranscriptExportFailed',
  {
    step: Schema.Literals([
      'assembleTrace',
      'openController',
      'pickFormat',
      'traceViewerBundle',
    ]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}
