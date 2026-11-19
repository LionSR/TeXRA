/**
 * Pick a transcript format, then open the written result and report it.
 * The writer is loaded only after the picker succeeds, so cancellation
 * reads no run records and window startup loads no export formatters.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports - export presentation
import { withLogChannel } from '@texra-ai/harness/plugins';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import type { Dialogs, HostFailed } from '@texra/hosts/uiHosts';
import type { RunId } from '@texra-ai/harness/schemas';
import type { writeTranscript } from './ChatExportController';

export type TranscriptExportFormat = Parameters<typeof writeTranscript>[1];

/**
 * A step of the transcript export could not be carried out: the writer's
 * lazy load, the packaged resources or trace-viewer bundle it needs, or the
 * trace it assembles. `cause` is the value the failing step produced,
 * carried unchanged so a host classifies and words it exactly as it would
 * the bare value. A host's own capabilities (the format pick, the open)
 * fail with their `HostFailed`.
 */
export class TranscriptExportFailed extends Schema.TaggedError<TranscriptExportFailed>()(
  'TranscriptExportFailed',
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type TranscriptExportOpenKind = 'text' | 'pdf' | 'external';

/** How every host's format pick is titled and what it asks. */
export const TRANSCRIPT_EXPORT_PICK = Object.freeze({
  title: 'Export transcript',
  prompt: 'Choose a format',
});

export const TRANSCRIPT_EXPORT_FORMAT_CHOICES = Object.freeze([
  Object.freeze({
    format: 'html',
    label: 'HTML',
    description: 'Shareable webpage',
  }),
  Object.freeze({
    format: 'md',
    label: 'Markdown',
    description: 'Plain-text conversation',
  }),
  Object.freeze({
    format: 'tex',
    label: 'PDF',
    description: 'Formatted via LaTeX',
  }),
] as const satisfies ReadonlyArray<{
  readonly format: TranscriptExportFormat;
  readonly label: string;
  readonly description: string;
}>);

/** What a host does for a transcript export: ask for a format and open
 *  what was written. */
export interface TranscriptExportHost {
  /** A cancelled format picker answers `undefined`. */
  readonly pickFormat: Effect.Effect<
    TranscriptExportFormat | undefined,
    HostFailed
  >;
  openPath(
    filePath: string,
    kind: TranscriptExportOpenKind,
  ): Effect.Effect<void, HostFailed>;
}

type TranscriptExportPorts = Parameters<typeof writeTranscript>[2] &
  TranscriptExportHost & {
    notify: Dialogs['notify'];
  };

/** Ask for a format, write the export, and open it using the host's viewer. */
export const exportRunTranscript = Effect.fn('exportRunTranscript')(function* (
  runId: RunId,
  ports: TranscriptExportPorts,
) {
  const format = yield* ports.pickFormat;
  if (!format) return;
  const writer = yield* Effect.tryPromise({
    try: () => import('@texra/controllers/progressView/ChatExportController'),
    catch: (cause) =>
      new TranscriptExportFailed({
        message: toErrorMessage(cause),
        cause,
      }),
  });
  const result = yield* writer.writeTranscript(runId, format, ports);
  if (result.format !== 'tex') {
    yield* ports.openPath(
      result.absolutePath,
      result.format === 'html' ? 'external' : 'text',
    );
    yield* ports.notify(
      'info',
      `Transcript exported: ${path.basename(result.storagePath)}`,
    );
    return;
  }
  if (result.pdfPath) {
    const pdfFilename = path
      .basename(result.storagePath)
      .replace(/\.tex$/, '.pdf');
    yield* ports.openPath(result.pdfPath, 'pdf');
    yield* ports.notify(
      'info',
      `Transcript exported and compiled: ${pdfFilename}`,
    );
    return;
  }
  if (result.logTail) {
    yield* Effect.logError(
      `LaTeX export compilation failed for ${result.storagePath}:\n${result.logTail}`,
    ).pipe(
      Effect.annotateLogs({
        data: { storagePath: result.storagePath, logTail: result.logTail },
      }),
      withLogChannel('ExportTranscript'),
    );
  }
  yield* ports.openPath(result.absolutePath, 'text');
  yield* ports.notify(
    'warning',
    'LaTeX compilation failed. The .tex source file has been opened instead.',
  );
});
