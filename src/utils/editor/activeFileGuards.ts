// Third-party imports
import * as vscode from 'vscode';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';
import {
  showErrorMessage,
  showWarningMessage,
} from '@frontend/ui/messageUtils';

export type ActiveFileGuardFailureReason =
  | 'noEditor'
  | 'unsupportedExtension'
  | 'saveFailed';

export interface ActiveFileGuardOptions {
  allowedExtensions: string[];
  resourceName?: string;
  saveDocument?: boolean;
}

export type ActiveFileGuardResult =
  | {
      status: 'ok';
      editor: vscode.TextEditor;
      relativePath: string;
    }
  | {
      status: ActiveFileGuardFailureReason;
    };

const ensureLeadingDot = (extension: string): string =>
  extension.startsWith('.') ? extension : `.${extension}`;

const toLowerCase = (value: string): string => value.toLowerCase();

const formatExtensionList = (extensions: string[]): string =>
  extensions.length > 0 ? extensions.join(', ') : '';

/**
 * Retrieve the active text editor when available and ensure the document
 * matches the required extension list. Optionally saves dirty documents.
 */
export async function getActiveEditorWithGuards(
  options: ActiveFileGuardOptions,
): Promise<ActiveFileGuardResult> {
  const {
    allowedExtensions,
    resourceName,
    saveDocument = false,
  } = options;

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    const fileDescription = resourceName
      ? `${resourceName} file`
      : 'supported file';
    await showWarningMessage(
      `No active editor found. Open a ${fileDescription} in the editor and try again.`,
    );
    return { status: 'noEditor' };
  }

  const extensionsForDisplay = allowedExtensions.map(ensureLeadingDot);
  const normalizedExtensions = extensionsForDisplay.map(toLowerCase);
  const fileName = editor.document.fileName.toLowerCase();

  if (
    normalizedExtensions.length > 0 &&
    !normalizedExtensions.some((extension) => fileName.endsWith(extension))
  ) {
    const resourceLabel = resourceName
      ? `${resourceName} files`
      : 'files with the supported extensions';
    const extensionList = formatExtensionList(extensionsForDisplay);
    await showWarningMessage(
      `This command only works with ${resourceLabel} (${extensionList}).`,
    );
    return { status: 'unsupportedExtension' };
  }

  if (saveDocument && editor.document.isDirty) {
    const saved = await editor.document.save();
    if (!saved) {
      await showErrorMessage(
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
