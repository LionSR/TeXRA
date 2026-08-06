/**
 * Pure status-to-outcome mappings for history actions (export, delete, clear).
 *
 * Both the VS Code extension (`HistoryHandlers`) and the desktop app
 * (`DesktopHistoryHandlers`) drive the same host-neutral controllers
 * (`ChatExportController`, `deleteExecution`, `deleteAllExecutions`) and, until
 * now, each re-derived which message belongs to which result by hand. This
 * module owns that derivation once; each host still decides how to surface a
 * message (info vs. warning toast, which file to open) and whether to log
 * failures, since that part is genuinely host-specific.
 */

// Node imports
import * as path from 'node:path';

// Local imports
import type {
  DeleteAllExecutionsResult,
  DeleteExecutionResult,
} from '@agent/storage/executionListing';
import { formatExecutionHistoryRetention } from '@shared/copy/executionHistory';
import type {
  ExportInputStatus,
  HtmlExportOutcome,
  LatexExportResult,
} from './ChatExportController';

const HISTORY_ITEM_NOT_FOUND_MESSAGE = 'History item not found';

/**
 * Message for a null `readConfig()`, which cannot tell a missing execution
 * apart from a corrupt or incompatible one, so it must not claim either.
 */
export const HISTORY_CONFIG_UNREADABLE_MESSAGE =
  'History item not found or unreadable (missing, corrupt, or from an incompatible version)';

export const ACTIVE_EXECUTION_DELETE_BLOCKED_MESSAGE =
  'Cannot delete an execution that is active in TeXRA';

export const HISTORY_CLEARED_MESSAGE = 'Agent history cleared';

/**
 * Confirmation copy for the clear-all-history action, shared by the
 * extension and desktop hosts so the destructive prompt cannot drift.
 */
export const CLEAR_HISTORY_CONFIRM_MESSAGE =
  'Clear all history? This deletes every stored execution and cannot be undone.';
export const CLEAR_HISTORY_CONFIRM_LABEL = 'Clear all history';

/** Message for a failed {@link ChatExportController.buildExportInput} status. */
export function exportInputErrorMessage(
  status: Exclude<ExportInputStatus, 'ok'>,
): string {
  switch (status) {
    case 'config_missing':
      return HISTORY_ITEM_NOT_FOUND_MESSAGE;
    case 'conversation_missing':
      return 'No conversation data available for this execution';
  }
}

/** Message for a failed {@link ChatExportController.exportAsHtml} status. */
export function htmlExportErrorMessage(
  status: Exclude<HtmlExportOutcome['status'], 'ok'>,
): string {
  switch (status) {
    case 'config_missing':
      return HISTORY_ITEM_NOT_FOUND_MESSAGE;
    case 'streamLogs_missing':
      return 'No transcript was saved for this run, so there is nothing to export. Try exporting a more recent run.';
  }
}

/** Success message for a Markdown or HTML export (identical shape on both formats). */
export function exportedFileMessage(storagePath: string): string {
  return `Chat exported: ${path.basename(storagePath)}`;
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
      /** Present only when the compiler produced a log tail worth surfacing. */
      readonly logDetail?: string;
    };

/** Decide which file to open and what to say for a LaTeX export result. */
export function describeLatexExportResult(
  result: LatexExportResult,
): LatexExportOutcome {
  if (result.pdfPath) {
    const pdfFilename = path
      .basename(result.storagePath)
      .replace(/\.tex$/, '.pdf');
    return {
      kind: 'compiled',
      pathToOpen: result.pdfPath,
      message: `Chat exported and compiled: ${pdfFilename}`,
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

type DeleteExecutionOutcome =
  | { readonly kind: 'active' }
  | { readonly kind: 'not-found'; readonly message: string }
  | { readonly kind: 'deleted' };

/** Decide the outcome message for a {@link deleteExecution} result. */
export function describeDeleteExecutionResult(
  result: DeleteExecutionResult,
): DeleteExecutionOutcome {
  if (result.status === 'active') return { kind: 'active' };
  if (result.status === 'not-found') {
    return {
      kind: 'not-found',
      message: `History item not found: ${result.executionId}`,
    };
  }
  return { kind: 'deleted' };
}

type ClearHistoryOutcome =
  | { readonly kind: 'cleared' }
  | { readonly kind: 'retained'; readonly message: string };

/** Decide whether history was fully cleared, and the retention message if not. */
export function describeClearHistoryResult(
  result: DeleteAllExecutionsResult,
): ClearHistoryOutcome {
  if (result.active.length === 0 && result.failed.length === 0) {
    return { kind: 'cleared' };
  }
  return {
    kind: 'retained',
    message: formatExecutionHistoryRetention(
      result.active.length,
      result.failed.length,
    ),
  };
}
