// Third-party imports
import * as vscode from 'vscode';

// Local imports - utils
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'ActiveFileGuards';

type ActiveFileGuardFailureReason =
  'noEditor' | 'unsupportedExtension' | 'saveFailed';

interface ActiveFileGuardOptions {
  allowedExtensions: string[];
  resourceName: string;
  saveDocument: boolean;
}

interface ActiveFileGuardSuccess {
  status: 'ok';
  editor: vscode.TextEditor;
  relativePath: string;
}

type ActiveFileGuardResult =
  ActiveFileGuardSuccess | { status: ActiveFileGuardFailureReason };

/**
 * Retrieve the active text editor when available and ensure the document
 * matches the required extension list. Optionally saves dirty documents.
 */
async function getActiveEditorWithGuards(
  options: ActiveFileGuardOptions,
): Promise<ActiveFileGuardResult> {
  const { allowedExtensions, resourceName, saveDocument } = options;

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.window.showWarningMessage(
      `No active editor found. Open a ${resourceName} file in the editor and try again.`,
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
    await vscode.window.showWarningMessage(
      `This command only works with ${resourceName} files (${normalizedExtensions.join(', ')}).`,
    );
    return { status: 'unsupportedExtension' };
  }

  if (saveDocument && editor.document.isDirty) {
    const saved = await editor.document.save();
    if (!saved) {
      await showLoggedMessage(
        CHANNEL,
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
 * @param resourceType - Resource type (e.g., "LaTeX", "XML", "YAML") for context
 */
function logGuardFailure(
  channel: string,
  action: string,
  reason: ActiveFileGuardFailureReason,
  resourceType: string,
): void {
  const prefix = `Cannot ${action}:`;

  switch (reason) {
    case 'noEditor':
      logger.warn(channel, `${prefix} no active editor found.`);
      break;
    case 'unsupportedExtension':
      logger.warn(
        channel,
        `${prefix} active document is not a ${resourceType} file.`,
      );
      break;
    case 'saveFailed':
      logger.error(
        channel,
        `${prefix} failed to save ${resourceType} document before running command.`,
      );
      break;
  }
}

interface GuardedFileCommandOptions {
  /** The logging channel to use */
  channel: string;
  /** Description of the action being performed (e.g. "parse YAML"). */
  action: string;
  /** Human-readable resource label used in guard warnings and failure logs. */
  resourceName: string;
  /** Extensions the active document must match, dot-prefixed. */
  allowedExtensions: string[];
  /** Whether to save the document before proceeding (default: false) */
  saveDocument?: boolean;
  /** Message surfaced and logged when the operation throws. */
  errorMessage: string;
}

/**
 * Run a command against the active editor under the active-file guard: the
 * document must exist and match `allowedExtensions`, guard failures are logged
 * through the command's channel, and anything the operation throws is surfaced
 * once through that same channel.
 */
async function runGuardedFileCommand(
  options: GuardedFileCommandOptions,
  operation: (guardResult: ActiveFileGuardSuccess) => Promise<void>,
): Promise<void> {
  const {
    channel,
    action,
    resourceName,
    allowedExtensions,
    saveDocument = false,
    errorMessage,
  } = options;

  try {
    const guardResult = await getActiveEditorWithGuards({
      allowedExtensions,
      resourceName,
      saveDocument,
    });

    if (guardResult.status !== 'ok') {
      logGuardFailure(channel, action, guardResult.status, resourceName);
      return;
    }

    await operation(guardResult);
  } catch (err) {
    await showLoggedErrorMessage(channel, errorMessage, err);
  }
}

type GuardedLatexCommandOptions = Omit<
  GuardedFileCommandOptions,
  'resourceName' | 'allowedExtensions'
>;

/** {@link runGuardedFileCommand} bound to `.tex` documents. */
export function runGuardedLatexCommand(
  options: GuardedLatexCommandOptions,
  operation: (guardResult: ActiveFileGuardSuccess) => Promise<void>,
): Promise<void> {
  return runGuardedFileCommand(
    { ...options, resourceName: 'LaTeX', allowedExtensions: ['.tex'] },
    operation,
  );
}
