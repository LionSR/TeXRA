/**
 * Write a transcript in the chosen format. The GUI loads this module only
 * after a format is selected, keeping formatters and the LaTeX compiler out
 * of window startup. File opening and notices belong to the caller.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports - export data and storage
import {
  type SettingsStores,
  StorageFs,
  WorkspaceFs,
  pathToLocationIn,
  HostResources,
} from '@texra-ai/worldline/plugins';
import { toErrorMessage, Rejected } from '@texra-ai/worldline/schemas';
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
import { TranscriptExportFailed } from './exportTranscript';
import type { Session } from '@texra-ai/worldline';
import type { RunId } from '@texra-ai/worldline/schemas';

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
    /** The settings a LaTeX export's compile reads. */
    readonly roots: SettingsStores;
    /** The run's session, whose records the export reads: this process's
     *  own, or the service's. */
    readonly session: Session;
  },
) {
  // The packaged resources hold the trace-viewer bundle and the LaTeX
  // export's preamble.
  const { resourcesRoot } = yield* HostResources;
  if (resourcesRoot === undefined) {
    const cause = new Error(
      'Export assets are missing in this build, so this conversation cannot be exported.',
    );
    return yield* new TranscriptExportFailed({ message: cause.message, cause });
  }
  if (format === 'html') {
    const { html, trace, record } = yield* traceHtml(
      options.session,
      runId,
      resourcesRoot,
    ).pipe(
      Effect.catch(
        (error): Effect.Effect<never, Rejected | TranscriptExportFailed> => {
          if (error instanceof TraceUnavailable)
            return Effect.fail(
              new Rejected({
                reason: {
                  no_record: 'This task has no saved data to export.',
                  no_rows: 'No conversation was saved for this task.',
                }[error.status],
              }),
            );
          if (error instanceof TraceViewerMissing) {
            const cause = new Error(
              `HTML export template is missing (${error.path}). Reinstall or rebuild TeXRA.`,
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

  const loaded = yield* loadChatExportInput(runId, options.session);
  if (loaded._tag === 'noConfig')
    return yield* new Rejected({
      reason: 'This task has no saved data to export.',
    });
  if (loaded._tag === 'noConversation')
    return yield* new Rejected({
      reason: 'No conversation was saved for this task.',
    });
  const exportInput = loaded.input;

  const result = yield* writeExport(
    runId,
    generateExportFilename(exportInput, format),
    format === 'md'
      ? formatChatAsMarkdown(exportInput)
      : formatChatAsLatex(
          exportInput,
          yield* FileSystem.FileSystem.use((fs) =>
            fs.readFileString(
              path.join(resourcesRoot, 'templates', 'chatExport.tex'),
            ),
          ),
        ),
  );
  if (format === 'md') return { ...result, format };

  const compiled = yield* compileLatex2Pdf(
    pathToLocationIn((yield* WorkspaceFs).root, result.absolutePath),
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
