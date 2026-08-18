/**
 * Host-neutral transcript export from a progress-view run.
 *
 * Picks a format, writes through {@link ChatExportController}, then tells the
 * host which file to open and what to say. Format picking and file opening
 * stay on the host because VS Code and desktop present those differently.
 */

// Node imports
import * as path from 'node:path';

// Local imports
import {
  ChatExportController,
  type ChatExportInput,
  type ExportInputStatus,
  type HtmlExportOutcome,
  type LatexExportResult,
} from './ChatExportController';

const TRANSCRIPT_EXPORT_FORMATS = ['html', 'md', 'tex'] as const;
export type TranscriptExportFormat = (typeof TRANSCRIPT_EXPORT_FORMATS)[number];

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

export const NO_TRANSCRIPT_TO_EXPORT_MESSAGE =
  'This run has no saved transcript to export yet.';

export interface TranscriptExportPorts {
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

type LatexExportOutcome =
  | {
      readonly kind: 'compiled';
      readonly pathToOpen: string;
      readonly message: string;
    }
  | {
      readonly kind: 'compileFailed';
      readonly pathToOpen: string;
      readonly message: string;
      readonly logDetail?: string;
    };

/** Decide which file to open and what to say for a LaTeX export result. */
function describeLatexExportResult(
  result: LatexExportResult,
): LatexExportOutcome {
  if (result.pdfPath) {
    const pdfFilename = path
      .basename(result.storagePath)
      .replace(/\.tex$/, '.pdf');
    return {
      kind: 'compiled',
      pathToOpen: result.pdfPath,
      message: `Transcript exported and compiled: ${pdfFilename}`,
    };
  }
  return {
    kind: 'compileFailed',
    pathToOpen: result.absolutePath,
    message:
      'LaTeX compilation failed. The .tex source file has been opened instead.',
    logDetail: result.logTail
      ? `LaTeX export compilation failed for ${result.storagePath}:\n${result.logTail}`
      : undefined,
  };
}

/**
 * Ask the host for a format, write the export, and open the result.
 *
 * A cancelled picker is a no-op. Missing run data is reported through
 * `showError` rather than thrown so a missing transcript is not an
 * unexpected failure.
 */
export async function exportStreamTranscript(
  executionId: string,
  ports: TranscriptExportPorts,
): Promise<void> {
  const format = await ports.pickFormat();
  if (!format) return;
  const controller = await ports.getController();
  if (format === 'html') {
    await exportHtml(controller, executionId, ports);
    return;
  }
  const result = await controller.buildExportInput(executionId);
  if (result.status !== 'ok') {
    await ports.showError(exportInputErrorMessage(result.status));
    return;
  }
  if (format === 'md') {
    await exportMarkdown(controller, executionId, result.exportInput, ports);
    return;
  }
  await exportLatex(controller, executionId, result.exportInput, ports);
}

async function exportMarkdown(
  controller: ChatExportController,
  executionId: string,
  input: ChatExportInput,
  ports: TranscriptExportPorts,
): Promise<void> {
  const result = await controller.exportAsMarkdown(executionId, input);
  await ports.openPath(result.absolutePath, 'text');
  await ports.showInfo(exportedFileMessage(result.storagePath));
}

async function exportLatex(
  controller: ChatExportController,
  executionId: string,
  input: ChatExportInput,
  ports: TranscriptExportPorts,
): Promise<void> {
  const result = await controller.exportAsLatex(executionId, input);
  const outcome = describeLatexExportResult(result);
  if (outcome.kind === 'compileFailed' && outcome.logDetail) {
    ports.reportDetail?.(outcome.logDetail, {
      storagePath: result.storagePath,
      logTail: result.logTail,
    });
  }
  await ports.openPath(
    outcome.pathToOpen,
    outcome.kind === 'compiled' ? 'pdf' : 'text',
  );
  await (outcome.kind === 'compiled'
    ? ports.showInfo(outcome.message)
    : ports.showWarning(outcome.message));
}

async function exportHtml(
  controller: ChatExportController,
  executionId: string,
  ports: TranscriptExportPorts,
): Promise<void> {
  const outcome = await controller.exportAsHtml(
    executionId,
    ports.getTraceViewerTemplate(),
  );
  if (outcome.status !== 'ok') {
    await ports.showError(htmlExportErrorMessage(outcome.status));
    return;
  }
  await ports.openPath(outcome.result.absolutePath, 'external');
  await ports.showInfo(exportedFileMessage(outcome.result.storagePath));
}
