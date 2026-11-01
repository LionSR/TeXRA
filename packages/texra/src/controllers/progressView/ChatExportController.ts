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
import { Rejected } from '@texra-ai/harness';
import { StorageFs, pathToLocationIn } from '@texra-ai/harness/host';
import { absentReason, readNormalizedFile } from '@texra-ai/harness/node';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { compileLatex2Pdf } from '@latex/texTools';
import { formatChatAsMarkdown } from '@texra/agent/export/chatExport/markdownSpec';
import { formatChatAsLatex } from '@texra/agent/export/chatExport/latexSpec';
import { generateExportFilename } from '@texra/agent/export/chatExport/filenames';
import type {
  ChatExportInputUnreadable,
  ChatExportLoadResult,
} from '@texra/agent/export/loadChatExportInput';
import type { TaskRecordsFailed } from '@texra/controllers/server/protocol';
import { injectStandaloneTrace } from '@texra/agent/export/standaloneTraceHtml';
import { TranscriptExportFailed } from './transcriptExportFailure';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { AssembleTraceResult } from '@texra-ai/harness/host';
import type { RunId } from '@texra-ai/harness/schemas';

/** The host-supplied trace-viewer bundle is unusable. Preserve its own
 *  message as the cause a host presents. */
function bundleFailure(
  message: string,
): Effect.Effect<never, TranscriptExportFailed> {
  return Effect.fail(
    new TranscriptExportFailed({
      step: 'traceViewerBundle',
      message,
      cause: new Error(message),
    }),
  );
}

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
    readonly templatePath: string;
    /** Records come from the local session or the service that owns it. */
    readonly records: {
      readonly input: (
        runId: RunId,
      ) => Effect.Effect<
        Pick<ChatExportLoadResult, 'config' | 'exportInput'>,
        ChatExportInputUnreadable | TaskRecordsFailed
      >;
      readonly trace: (
        runId: RunId,
      ) => Effect.Effect<AssembleTraceResult, Error>;
    };
  },
) {
  if (format === 'html') {
    const traceResult = yield* options.records.trace(runId).pipe(
      Effect.mapError(
        (cause) =>
          new TranscriptExportFailed({
            step: 'assembleTrace',
            message: toErrorMessage(cause),
            cause,
          }),
      ),
    );
    if (traceResult.status !== 'ok')
      return yield* new Rejected({
        reason: {
          config_missing: 'This run has no saved data to export.',
          streamLogs_missing:
            'No transcript was saved for this run, so there is nothing to export. Try exporting a more recent run.',
        }[traceResult.status],
      });
    const { trace, record } = traceResult;

    // The bundle path is absolute and host-supplied, so the process
    // filesystem reads it. Missing bundles give the host a rebuild hint.
    const fs = yield* FileSystem.FileSystem;
    if (!path.isAbsolute(options.templatePath))
      return yield* bundleFailure(
        `Trace-viewer standalone bundle path must be absolute: ${options.templatePath}`,
      );
    const template = yield* readNormalizedFile(fs, options.templatePath).pipe(
      Effect.catchIf(absentReason, () =>
        bundleFailure(
          `Trace-viewer standalone bundle missing at ${options.templatePath}: ` +
            'rebuild the extension (npm run package:fast) so packages/trace-viewer builds.',
        ),
      ),
    );
    const html = injectStandaloneTrace(template, trace);
    const filename = generateExportFilename(
      {
        // The assembler guarantees a non-empty document whose first row,
        // the creation row when the run has one, carries the launch time.
        timestamp: new Date(trace.events[0]!.at).toISOString(),
        config: record,
      },
      'html',
    );
    return { ...(yield* writeExport(runId, filename, html)), format };
  }

  const { config, exportInput } = yield* options.records.input(runId);
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
  );
  return {
    ...result,
    format,
    pdfPath: compiled.ok ? compiled.pdfPath : undefined,
    logTail: compiled.ok ? undefined : compiled.logTail,
  };
});
