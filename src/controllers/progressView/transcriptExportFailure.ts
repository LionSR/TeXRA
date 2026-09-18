/**
 * The transcript export's own failure tag.
 *
 * It lives beside the export rather than inside `ChatExportController`
 * because the desktop loads that controller lazily, on the first export: a
 * host that words a failed export names this tag, and naming it must not
 * pull the controller's module graph (the formatters, the trace assembler,
 * the LaTeX compiler) into the app's startup.
 */

import { Data } from 'effect';

/**
 * A step of the transcript export could not be carried out.
 *
 * The chain enters four surfaces that can fail outside its own typed
 * channels — the host's format picker, the host's controller load, the trace
 * assembler, and the host-supplied trace-viewer bundle the export itself
 * finds unusable. `step` says which one; `cause` is the value that step
 * produced, carried unchanged so a host's dialog classifies and words it
 * exactly as it did when that value reached the dispatcher bare. A step that
 * mints the fact itself carries the minted error, so the wording is the same
 * either way. The two host surfaces mint the tag where they wrap their own
 * foreign edge, so the export chain lifts nothing.
 */
export class TranscriptExportFailed extends Data.TaggedError(
  'TranscriptExportFailed',
)<{
  readonly step:
    'assembleTrace' | 'openController' | 'pickFormat' | 'traceViewerBundle';
  readonly message: string;
  readonly cause: unknown;
}> {}
