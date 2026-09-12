/**
 * Host-neutral transcript export from a progress-view run.
 *
 * Picks a format, writes through {@link ChatExportController}, then tells the
 * host which file to open and what to say. Format picking and file opening
 * stay on the host because VS Code and desktop present those differently.
 */

// Node imports
import * as path from 'node:path';

import { Effect } from 'effect';

// Local imports
import type { ChatExportInput } from '@agent/export/schemas';
import type { RunId } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import {
  ChatExportController,
  type ExportInputStatus,
  type HtmlExportOutcome,
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
  openPath(filePath: string, kind: TranscriptExportOpenKind): Promise<void>;
  showInfo(message: string): Promise<void> | void;
  showWarning(message: string): Promise<void> | void;
  showError(message: string): Promise<void> | void;
  reportDetail?(message: string, data?: unknown): void;
  getController(): Promise<ChatExportController>;
  getTraceViewerTemplate(): string;
}

const RUN_NOT_FOUND_MESSAGE = 'This run has no saved data to export.';

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
): Effect.fn.Return<void, Error> {
  const format = yield* Effect.tryPromise({
    try: async () => ports.pickFormat(),
    catch: ensureError,
  });
  if (!format) return;
  const controller = yield* Effect.tryPromise({
    try: async () => ports.getController(),
    catch: ensureError,
  });
  if (format === 'html') {
    yield* exportHtml(controller, runId, ports);
    return;
  }
  const result = yield* controller.buildExportInput(runId);
  if (result.status !== 'ok') {
    yield* Effect.tryPromise({
      try: async () => ports.showError(exportInputErrorMessage(result.status)),
      catch: ensureError,
    });
    return;
  }
  if (format === 'md') {
    yield* Effect.tryPromise({
      try: async () =>
        exportMarkdown(controller, runId, result.exportInput, ports),
      catch: ensureError,
    });
    return;
  }
  yield* Effect.tryPromise({
    try: async () => exportLatex(controller, runId, result.exportInput, ports),
    catch: ensureError,
  });
});

async function exportMarkdown(
  controller: ChatExportController,
  runId: RunId,
  input: ChatExportInput,
  ports: TranscriptExportPorts,
): Promise<void> {
  const result = await controller.exportAsMarkdown(runId, input);
  await ports.openPath(result.absolutePath, 'text');
  await ports.showInfo(exportedFileMessage(result.storagePath));
}

async function exportLatex(
  controller: ChatExportController,
  runId: RunId,
  input: ChatExportInput,
  ports: TranscriptExportPorts,
): Promise<void> {
  const result = await controller.exportAsLatex(runId, input);
  if (result.pdfPath) {
    const pdfFilename = path
      .basename(result.storagePath)
      .replace(/\.tex$/, '.pdf');
    await ports.openPath(result.pdfPath, 'pdf');
    await ports.showInfo(`Transcript exported and compiled: ${pdfFilename}`);
    return;
  }
  if (result.logTail) {
    ports.reportDetail?.(
      `LaTeX export compilation failed for ${result.storagePath}:\n${result.logTail}`,
      { storagePath: result.storagePath, logTail: result.logTail },
    );
  }
  await ports.openPath(result.absolutePath, 'text');
  await ports.showWarning(
    'LaTeX compilation failed. The .tex source file has been opened instead.',
  );
}

const exportHtml = Effect.fn('exportHtml')(function* (
  controller: ChatExportController,
  runId: RunId,
  ports: TranscriptExportPorts,
): Effect.fn.Return<void, Error> {
  const outcome = yield* controller.exportAsHtml(
    runId,
    ports.getTraceViewerTemplate(),
  );
  if (outcome.status !== 'ok') {
    yield* Effect.tryPromise({
      try: async () => ports.showError(htmlExportErrorMessage(outcome.status)),
      catch: ensureError,
    });
    return;
  }
  yield* Effect.tryPromise({
    try: async () => ports.openPath(outcome.result.absolutePath, 'external'),
    catch: ensureError,
  });
  yield* Effect.tryPromise({
    try: async () =>
      ports.showInfo(exportedFileMessage(outcome.result.storagePath)),
    catch: ensureError,
  });
});
