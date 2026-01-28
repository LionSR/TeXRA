// Third-party imports
import * as vscode from 'vscode';

// Local imports - utils
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

export type ActiveFileGuardFailureReason =
  | 'noEditor'
  | 'unsupportedExtension'
  | 'saveFailed';

export interface ActiveFileGuardOptions {
  allowedExtensions: string[];
  resourceName?: string;
  saveDocument?: boolean;
}

export interface ActiveFileGuardSuccess {
  status: 'ok';
  editor: vscode.TextEditor;
  relativePath: string;
}

export type ActiveFileGuardResult =
  | ActiveFileGuardSuccess
  | { status: ActiveFileGuardFailureReason };

/**
 * Retrieve the active text editor when available and ensure the document
 * matches the required extension list. Optionally saves dirty documents.
 */
export async function getActiveEditorWithGuards(
  options: ActiveFileGuardOptions,
): Promise<ActiveFileGuardResult> {
  const { allowedExtensions, resourceName, saveDocument = false } = options;

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    const fileDescription = resourceName
      ? `${resourceName} file`
      : 'supported file';
    await vscode.window.showWarningMessage(
      `No active editor found. Open a ${fileDescription} in the editor and try again.`,
    );
    return { status: 'noEditor' };
  }

  // Normalize extensions: ensure dot prefix and lowercase for comparison
  const normalizedExtensions = allowedExtensions.map((ext) =>
    (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase(),
  );
  const fileName = editor.document.fileName.toLowerCase();

  if (
    normalizedExtensions.length > 0 &&
    !normalizedExtensions.some((extension) => fileName.endsWith(extension))
  ) {
    const resourceLabel = resourceName
      ? `${resourceName} files`
      : 'files with the supported extensions';
    await vscode.window.showWarningMessage(
      `This command only works with ${resourceLabel} (${normalizedExtensions.join(', ')}).`,
    );
    return { status: 'unsupportedExtension' };
  }

  if (saveDocument && editor.document.isDirty) {
    const saved = await editor.document.save();
    if (!saved) {
      await vscode.window.showErrorMessage(
        'Could not save the current file. Please save and try again.',
      );
      return { status: 'saveFailed' };
    }
  }

  const relativePath = WorkspaceFS.relativePath(editor.document.fileName);

  return {
    status: 'ok',
    editor,
    relativePath,
  };
}

/**
 * Log guard failure with standardized messages.
 * @param channel - Logger channel name
 * @param action - Description of the action being performed (e.g., "parse XML", "indent LaTeX document")
 * @param reason - Reason for guard failure
 * @param resourceType - Optional resource type (e.g., "LaTeX", "XML", "YAML") for context
 */
export function logGuardFailure(
  channel: string,
  action: string,
  reason: ActiveFileGuardFailureReason,
  resourceType?: string,
): void {
  const prefix = `Cannot ${action}:`;
  const typeLabel = resourceType ?? 'the';

  switch (reason) {
    case 'noEditor':
      logger.warn(channel, `${prefix} no active editor found.`);
      break;
    case 'unsupportedExtension':
      logger.warn(
        channel,
        `${prefix} active document is not a ${typeLabel} file.`,
      );
      break;
    case 'saveFailed':
      logger.error(
        channel,
        `${prefix} failed to save ${typeLabel} document before running command.`,
      );
      break;
  }
}

export interface LaTeXGuardOptions {
  /** The logging channel to use */
  channel: string;
  /** Description of the action being performed (e.g., "apply replacements", "indent document") */
  action: string;
  /** Whether to save the document before proceeding (default: false) */
  saveDocument?: boolean;
}

/**
 * Execute an operation with LaTeX file guards.
 *
 * Validates the active editor has a .tex file, optionally saves it,
 * logs failures, and runs the operation only if guards pass.
 */
export async function withLaTeXGuard<T>(
  options: LaTeXGuardOptions,
  operation: (guardResult: ActiveFileGuardSuccess) => Promise<T>,
): Promise<T | undefined> {
  const { channel, action, saveDocument = false } = options;

  const guardResult = await getActiveEditorWithGuards({
    allowedExtensions: ['.tex'],
    resourceName: 'LaTeX',
    saveDocument,
  });

  if (guardResult.status !== 'ok') {
    logGuardFailure(channel, action, guardResult.status, 'LaTeX');
    return undefined;
  }

  return operation(guardResult);
}
