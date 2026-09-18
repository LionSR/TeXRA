/**
 * Host-neutral transcript export from a progress-view run.
 *
 * Picks a format, writes through {@link ChatExportController}, then tells the
 * host which file to open and what to say. Format picking and file opening
 * stay on the host because VS Code and desktop present those differently.
 */

// Node imports
import * as path from 'node:path';

import { Effect, type FileSystem, type PlatformError } from 'effect';

// Local imports
import type { ChatExportInputUnreadable } from '@agent/export/loadChatExportInput';
import type { ChatExportInput } from '@agent/export/schemas';
import type {
  ExternalOpenFailed,
  MessageHost,
  NotificationFailed,
} from '@hosts/uiHosts';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import type { RunId } from '@shared/schemas';
import type { Rejected } from '@shared/session/requestErrors';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { TranscriptExportFailed } from './transcriptExportFailure';
import type {
  ChatExportController,
  ExportInputStatus,
  HtmlExportOutcome,
} from './ChatExportController';

export type TranscriptExportFormat = 'html' | 'md' | 'tex';

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

interface TranscriptExportPorts {
  pickFormat(): Promise<TranscriptExportFormat | undefined>;
  /** Open what was just written. The member is a program: both hosts' open
   *  verbs are Effects, so nothing is lifted on the way through here, and
   *  each host words its own refusal into the port's one tag. */
  openPath(
    filePath: string,
    kind: TranscriptExportOpenKind,
  ): Effect.Effect<void, ExternalOpenFailed>;
  showInfo: MessageHost['showInfoMessage'];
  showWarning: MessageHost['showWarningMessage'];
  /** The error notice. A host may answer it by refusing the request instead:
   *  the desktop's failure is the `Rejected` the surface presents with this
   *  message, so the channel admits it beside `NotificationFailed`. */
  showError(
    message: string,
  ): Effect.Effect<void, NotificationFailed | Rejected>;
  reportDetail?(message: string, data?: unknown): void;
  getController(): Promise<ChatExportController>;
  getTraceViewerTemplate(): string;
}

const RUN_NOT_FOUND_MESSAGE = 'This run has no saved data to export.';

/**
 * Every way a transcript export fails. Each member is a tag: the export's own
 * steps ({@link TranscriptExportFailed}), the run read
 * ({@link ChatExportInputUnreadable}), the storage write
 * (`PlatformError`), the host's open verb ({@link ExternalOpenFailed}), and
 * the host's notices ({@link NotificationFailed}, or the {@link Rejected} a
 * host answers an error notice with).
 */
type TranscriptExportFailure =
  | ChatExportInputUnreadable
  | ExternalOpenFailed
  | NotificationFailed
  | PlatformError.PlatformError
  | Rejected
  | TranscriptExportFailed;

/** Message for a failed {@link ChatExportController.buildExportInput} status. */
function exportInputErrorMessage(
  status: Exclude<ExportInputStatus, 'ok'>,
): string {
  switch (status) {
    case 'config_missing':
      return RUN_NOT_FOUND_MESSAGE;
    case 'conversation_missing':
      return 'No conversation was saved for this run.';
  }
}

/** Message for a failed {@link ChatExportController.exportAsHtml} status. */
function htmlExportErrorMessage(
  status: Exclude<HtmlExportOutcome['status'], 'ok'>,
): string {
  switch (status) {
    case 'config_missing':
      return RUN_NOT_FOUND_MESSAGE;
    case 'streamLogs_missing':
      return 'No transcript was saved for this run, so there is nothing to export. Try exporting a more recent run.';
  }
}

/** Success message for a Markdown or HTML export. */
function exportedFileMessage(storagePath: string): string {
  return `Transcript exported: ${path.basename(storagePath)}`;
}

/**
 * Ask the host for a format, write the export, and open the result.
 *
 * A cancelled picker is a no-op. Missing run data is reported through
 * `showError` rather than thrown so a missing transcript is not an
 * unexpected failure.
 */
export const exportRunTranscript = Effect.fn('exportRunTranscript')(function* (
  runId: RunId,
  ports: TranscriptExportPorts,
): Effect.fn.Return<
  void,
  TranscriptExportFailure,
  FileSystem.FileSystem | StorageFs | WorkspaceFs
> {
  const format = yield* Effect.tryPromise({
    try: async () => ports.pickFormat(),
    catch: (cause) =>
      new TranscriptExportFailed({
        step: 'pickFormat',
        message: toErrorMessage(cause),
        cause,
      }),
  });
  if (!format) return;
  // The host's memo is behind this promise: a failed load clears it there, so
  // the next export retries. Lifted once, here, under its own step.
  const controller = yield* Effect.tryPromise({
    try: async () => ports.getController(),
    catch: (cause) =>
      new TranscriptExportFailed({
        step: 'openController',
        message: toErrorMessage(cause),
        cause,
      }),
  });
  if (format === 'html') {
    yield* exportHtml(controller, runId, ports);
    return;
  }
  const result = yield* controller.buildExportInput(runId);
  if (result.status !== 'ok') {
    yield* ports.showError(exportInputErrorMessage(result.status));
    return;
  }
  if (format === 'md') {
    yield* exportMarkdown(controller, runId, result.exportInput, ports);
    return;
  }
  yield* exportLatex(controller, runId, result.exportInput, ports);
});

const exportMarkdown = Effect.fn('exportMarkdown')(function* (
  controller: ChatExportController,
  runId: RunId,
  input: ChatExportInput,
  ports: TranscriptExportPorts,
): Effect.fn.Return<
  void,
  ExternalOpenFailed | NotificationFailed | PlatformError.PlatformError,
  StorageFs
> {
  const result = yield* controller.exportAsMarkdown(runId, input);
  yield* ports.openPath(result.absolutePath, 'text');
  yield* ports.showInfo(exportedFileMessage(result.storagePath));
});

const exportLatex = Effect.fn('exportLatex')(function* (
  controller: ChatExportController,
  runId: RunId,
  input: ChatExportInput,
  ports: TranscriptExportPorts,
): Effect.fn.Return<
  void,
  ExternalOpenFailed | NotificationFailed | PlatformError.PlatformError,
  FileSystem.FileSystem | StorageFs | WorkspaceFs
> {
  const result = yield* controller.exportAsLatex(runId, input);
  if (result.pdfPath) {
    const pdfPath = result.pdfPath;
    const pdfFilename = path
      .basename(result.storagePath)
      .replace(/\.tex$/, '.pdf');
    yield* ports.openPath(pdfPath, 'pdf');
    yield* ports.showInfo(`Transcript exported and compiled: ${pdfFilename}`);
    return;
  }
  if (result.logTail) {
    ports.reportDetail?.(
      `LaTeX export compilation failed for ${result.storagePath}:\n${result.logTail}`,
      { storagePath: result.storagePath, logTail: result.logTail },
    );
  }
  yield* ports.openPath(result.absolutePath, 'text');
  yield* ports.showWarning(
    'LaTeX compilation failed. The .tex source file has been opened instead.',
  );
});

const exportHtml = Effect.fn('exportHtml')(function* (
  controller: ChatExportController,
  runId: RunId,
  ports: TranscriptExportPorts,
): Effect.fn.Return<
  void,
  | ExternalOpenFailed
  | NotificationFailed
  | PlatformError.PlatformError
  | Rejected
  | TranscriptExportFailed,
  FileSystem.FileSystem | StorageFs
> {
  const outcome = yield* controller.exportAsHtml(
    runId,
    ports.getTraceViewerTemplate(),
  );
  if (outcome.status !== 'ok') {
    yield* ports.showError(htmlExportErrorMessage(outcome.status));
    return;
  }
  yield* ports.openPath(outcome.result.absolutePath, 'external');
  yield* ports.showInfo(exportedFileMessage(outcome.result.storagePath));
});
