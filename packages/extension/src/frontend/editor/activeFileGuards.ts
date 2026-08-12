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
 * Single owner of the reason -> message mapping for guard failures. Both the
 * user-facing warning (surfaced in {@link getActiveLatexEditor}) and the
 * standardized log line (in {@link runGuardedLatexCommand}) derive from here,
 * so adding a guard reason means editing this table, not two switches.
 */
const GUARD_FAILURE_MESSAGES: Record<
  ActiveFileGuardFailureReason,
  { user: string; logTail: string; level: 'warn' | 'error' }
> = {
  noEditor: {
    user: 'No active editor found. Open a LaTeX file in the editor and try again.',
    logTail: 'no active editor found.',
    level: 'warn',
  },
  unsupportedExtension: {
    user: 'This command only works with LaTeX files (.tex).',
    logTail: 'active document is not a LaTeX file.',
    level: 'warn',
  },
  saveFailed: {
    user: 'Could not save the current file. Please save and try again.',
    logTail: 'failed to save LaTeX document before running command.',
    level: 'error',
  },
};

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
      GUARD_FAILURE_MESSAGES.noEditor.user,
    );
    return { status: 'noEditor' };
  }

  if (!editor.document.fileName.toLowerCase().endsWith('.tex')) {
    await vscode.window.showWarningMessage(
      GUARD_FAILURE_MESSAGES.unsupportedExtension.user,
    );
    return { status: 'unsupportedExtension' };
  }

  if (saveDocument && editor.document.isDirty) {
    const saved = await editor.document.save();
    if (!saved) {
      await showLoggedMessage(CHANNEL, GUARD_FAILURE_MESSAGES.saveFailed.user);
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
      const failure = GUARD_FAILURE_MESSAGES[guardResult.status];
      const logLine = `Cannot ${action}: ${failure.logTail}`;
      if (failure.level === 'error') {
        logger.error(channel, logLine);
      } else {
        logger.warn(channel, logLine);
      }
      return;
    }

    await operation(guardResult);
  } catch (err) {
    await showLoggedErrorMessage(channel, errorMessage, err);
  }
}
