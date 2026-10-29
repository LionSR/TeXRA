/**
 * Pick a transcript format, then open the written result and report it.
 * The writer is loaded only after the picker succeeds, so cancellation
 * reads no run records and window startup loads no export formatters.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports - export presentation
import { withLogChannel } from '@texra-ai/harness/host';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import type { ExternalOpenFailed, MessageHost } from '@texra/hosts/uiHosts';
import { TranscriptExportFailed } from './transcriptExportFailure';
import type { RunId } from '@texra-ai/harness/schemas';
import type { writeTranscript } from './ChatExportController';

export type TranscriptExportFormat = Parameters<typeof writeTranscript>[1];

export type TranscriptExportOpenKind = 'text' | 'pdf' | 'external';

export const TRANSCRIPT_EXPORT_FORMAT_CHOICES = [
  {
    format: 'html',
    label: 'HTML',
    description: 'Shareable webpage',
  },
  {
    format: 'md',
    label: 'Markdown',
    description: 'Plain-text conversation',
  },
  {
    format: 'tex',
    label: 'PDF',
    description: 'Formatted via LaTeX',
  },
] as const satisfies ReadonlyArray<{
  readonly format: TranscriptExportFormat;
  readonly label: string;
  readonly description: string;
}>;

type TranscriptExportPorts = Parameters<typeof writeTranscript>[2] & {
  /** A cancelled format picker answers `undefined`. */
  readonly pickFormat: Effect.Effect<
    TranscriptExportFormat | undefined,
    TranscriptExportFailed
  >;
  openPath(
    filePath: string,
    kind: TranscriptExportOpenKind,
  ): Effect.Effect<void, ExternalOpenFailed>;
  showInfo: MessageHost['showInfoMessage'];
  showWarning: MessageHost['showWarningMessage'];
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
        step: 'openController',
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
    yield* ports.showInfo(
      `Transcript exported: ${path.basename(result.storagePath)}`,
    );
    return;
  }
  if (result.pdfPath) {
    const pdfFilename = path
      .basename(result.storagePath)
      .replace(/\.tex$/, '.pdf');
    yield* ports.openPath(result.pdfPath, 'pdf');
    yield* ports.showInfo(`Transcript exported and compiled: ${pdfFilename}`);
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
  yield* ports.showWarning(
    'LaTeX compilation failed. The .tex source file has been opened instead.',
  );
});
