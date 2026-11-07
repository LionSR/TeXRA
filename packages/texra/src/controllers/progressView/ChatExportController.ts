/**
 * Write a transcript in the chosen format. The GUI loads this module only
 * after a format is selected, keeping formatters and the LaTeX compiler out
 * of window startup. File opening and notices belong to the caller.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports - export data and storage
import { Rejected } from '@texra-ai/harness';
import { StorageFs, pathToLocationIn } from '@texra-ai/harness/host';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { compileLatex2Pdf } from '@latex/texTools';
import { formatChatAsMarkdown } from '@texra/agent/export/chatExport/markdownSpec';
import { formatChatAsLatex } from '@texra/agent/export/chatExport/latexSpec';
import { generateExportFilename } from '@texra/agent/export/chatExport/filenames';
import { loadChatExportInput } from '@texra/agent/export/loadChatExportInput';
import {
  traceHtml,
  TraceUnavailable,
  TraceViewerMissing,
} from '@texra/agent/export/standaloneTraceHtml';
import { TranscriptExportFailed } from './transcriptExportFailure';
import type { Session, WorkspaceRoots } from '@texra-ai/harness';
import type { RunId } from '@texra-ai/harness/schemas';

/** Write one export beneath its run's storage directory. */
const writeExport = Effect.fn('writeTranscript.writeExport')(function* (
  runId: RunId,
  filename: string,
  content: string,
) {
  const storagePath = `executions/${runId}/${filename}`;
  const storageFs = yield* StorageFs;
  yield* storageFs.makeDirectory(`executions/${runId}`, { recursive: true });
  yield* storageFs.writeFile(storagePath, new TextEncoder().encode(content));
  return {
    storagePath,
    absolutePath: yield* storageFs.resolve(storagePath),
  };
});

/**
 * Load the run's records, write its transcript, and compile a LaTeX export.
 * Missing records reject with the reason the surface presents. A failed
 * compilation preserves the written source and its log for the caller.
 */
export const writeTranscript = Effect.fn('writeTranscript')(function* (
  runId: RunId,
  format: 'html' | 'md' | 'tex',
  options: {
    readonly roots: WorkspaceRoots;
    /** The preamble is a host asset, independent of its installation path. */
    readonly latexPreamble: string;
    /** The host's resources directory, which holds the trace-viewer bundle. */
    readonly resourcesPath: string;
    /** The run's session, whose records the export reads: this process's
     *  own, or the service's. */
    readonly session: Session;
  },
) {
  if (format === 'html') {
    const { html, trace, record } = yield* traceHtml(
      options.session,
      runId,
      options.resourcesPath,
    ).pipe(
      Effect.catch(
        (error): Effect.Effect<never, Rejected | TranscriptExportFailed> => {
          if (error instanceof TraceUnavailable)
            return Effect.fail(
              new Rejected({
                reason: {
                  config_missing: 'This run has no saved data to export.',
                  streamLogs_missing:
                    'No transcript was saved for this run, so there is nothing to export. Try exporting a more recent run.',
                }[error.status],
              }),
            );
          if (error instanceof TraceViewerMissing) {
            const cause = new Error(
              `Trace-viewer standalone bundle missing at ${error.path}: ` +
                'rebuild the extension (npm run package:fast) so packages/trace-viewer builds.',
            );
            return Effect.fail(
              new TranscriptExportFailed({ message: cause.message, cause }),
            );
          }
          return Effect.fail(
            new TranscriptExportFailed({
              message: toErrorMessage(error),
              cause: error,
            }),
          );
        },
      ),
    );
    // The first row, the creation row when the run has one, carries the
    // launch time the filename is stamped with.
    const firstEvent = trace.events.at(0);
    if (firstEvent === undefined) {
      const cause = new Error(`The assembled trace of run ${runId} is empty.`);
      return yield* new TranscriptExportFailed({
        message: cause.message,
        cause,
      });
    }
    const filename = generateExportFilename(
      {
        timestamp: new Date(firstEvent.at).toISOString(),
        config: record,
      },
      'html',
    );
    return { ...(yield* writeExport(runId, filename, html)), format };
  }

  const { config, exportInput } = yield* loadChatExportInput(
    runId,
    options.session,
  );
  if (!config)
    return yield* new Rejected({
      reason: 'This run has no saved data to export.',
    });
  if (!exportInput)
    return yield* new Rejected({
      reason: 'No conversation was saved for this run.',
    });

  const result = yield* writeExport(
    runId,
    generateExportFilename(exportInput, format),
    format === 'md'
      ? formatChatAsMarkdown(exportInput)
      : formatChatAsLatex(exportInput, options.latexPreamble),
  );
  if (format === 'md') return { ...result, format };

  const compiled = yield* compileLatex2Pdf(
    pathToLocationIn(options.roots.workspace, result.absolutePath),
    options.roots,
  ).pipe(
    // No compiler still leaves the written source; the reason is its log.
    Effect.catchTag('ToolMissing', (missing) =>
      Effect.succeed({ ok: false, logTail: missing.message } as const),
    ),
  );
  return {
    ...result,
    format,
    pdfPath: compiled.ok ? compiled.pdfPath : undefined,
    logTail: compiled.ok ? undefined : compiled.logTail,
  };
});
