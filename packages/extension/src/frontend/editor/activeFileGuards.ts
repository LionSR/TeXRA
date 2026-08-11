// Third-party imports
import * as vscode from 'vscode';

// Local imports - utils
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files/workspaceFS';

const CHANNEL = 'ActiveFileGuards';

type ActiveFileGuardFailureReason =
  'noEditor' | 'unsupportedExtension' | 'saveFailed';

interface ActiveFileGuardSuccess {
  status: 'ok';
  editor: vscode.TextEditor;
  relativePath: string;
}

type ActiveFileGuardResult =
  ActiveFileGuardSuccess | { status: ActiveFileGuardFailureReason };

/**
 * Retrieve the active text editor when it holds a `.tex` document, optionally
 * saving it first when dirty.
 */
async function getActiveLatexEditor(
  saveDocument: boolean,
): Promise<ActiveFileGuardResult> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.window.showWarningMessage(
      'No active editor found. Open a LaTeX file in the editor and try again.',
    );
    return { status: 'noEditor' };
  }

  if (!editor.document.fileName.toLowerCase().endsWith('.tex')) {
    await vscode.window.showWarningMessage(
      'This command only works with LaTeX files (.tex).',
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
 * @param action - Description of the action being performed (e.g., "indent LaTeX document")
 * @param reason - Reason for guard failure
 */
function logGuardFailure(
  channel: string,
  action: string,
  reason: ActiveFileGuardFailureReason,
): void {
  const prefix = `Cannot ${action}:`;

  switch (reason) {
    case 'noEditor':
      logger.warn(channel, `${prefix} no active editor found.`);
      break;
    case 'unsupportedExtension':
      logger.warn(channel, `${prefix} active document is not a LaTeX file.`);
      break;
    case 'saveFailed':
      logger.error(
        channel,
        `${prefix} failed to save LaTeX document before running command.`,
      );
      break;
  }
}

interface GuardedLatexCommandOptions {
  /** The logging channel to use */
  channel: string;
  /** Description of the action being performed (e.g. "indent LaTeX document"). */
  action: string;
  /** Whether to save the document before proceeding (default: false) */
  saveDocument?: boolean;
  /** Message surfaced and logged when the operation throws. */
  errorMessage: string;
}

/**
 * Run a command against the active editor under the active-file guard: the
 * document must exist and be a `.tex` file, guard failures are logged through
 * the command's channel, and anything the operation throws is surfaced once
 * through that same channel.
 */
export async function runGuardedLatexCommand(
  options: GuardedLatexCommandOptions,
  operation: (guardResult: ActiveFileGuardSuccess) => Promise<void>,
): Promise<void> {
  const { channel, action, saveDocument = false, errorMessage } = options;

  try {
    const guardResult = await getActiveLatexEditor(saveDocument);

    if (guardResult.status !== 'ok') {
      logGuardFailure(channel, action, guardResult.status);
      return;
    }

    await operation(guardResult);
  } catch (err) {
    await showLoggedErrorMessage(channel, errorMessage, err);
  }
}
