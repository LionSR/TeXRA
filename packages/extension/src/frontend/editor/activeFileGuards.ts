// Third-party imports
import { Cause, Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports - utils
import type { SessionHandle } from '@agent/runtime';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import { createLog } from '@logger/logUtils';
import { workspaceRelativePath } from '@utils/files/workspaceFS';

const CHANNEL = 'ActiveFileGuards';

/**
 * Single owner of the reason -> message mapping for guard failures. Both the
 * user-facing warning (surfaced in {@link getActiveLatexEditor}) and the
 * standardized log line (in {@link runGuardedLatexCommand}) derive from here,
 * so adding a guard reason means editing this table, not two switches.
 */
const GUARD_FAILURE_MESSAGES = {
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
} satisfies Record<
  string,
  { user: string; logTail: string; level: 'warn' | 'error' }
>;

type ActiveFileGuardFailureReason = keyof typeof GUARD_FAILURE_MESSAGES;

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
const getActiveLatexEditor = (
  session: SessionHandle,
  saveDocument: boolean,
): Effect.Effect<ActiveFileGuardResult> =>
  Effect.gen(function* () {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      yield* Effect.promise(async () => {
        await vscode.window.showWarningMessage(
          GUARD_FAILURE_MESSAGES.noEditor.user,
        );
      });
      return { status: 'noEditor' } satisfies ActiveFileGuardResult;
    }

    if (!editor.document.fileName.toLowerCase().endsWith('.tex')) {
      yield* Effect.promise(async () => {
        await vscode.window.showWarningMessage(
          GUARD_FAILURE_MESSAGES.unsupportedExtension.user,
        );
      });
      return { status: 'unsupportedExtension' } satisfies ActiveFileGuardResult;
    }

    if (saveDocument && editor.document.isDirty) {
      const saved = yield* Effect.promise(async () => editor.document.save());
      if (!saved) {
        yield* showLoggedMessage(
          CHANNEL,
          GUARD_FAILURE_MESSAGES.saveFailed.user,
        );
        return { status: 'saveFailed' } satisfies ActiveFileGuardResult;
      }
    }

    const relativePath = workspaceRelativePath(
      session.roots.workspace,
      editor.document.fileName,
    );

    return {
      status: 'ok',
      editor,
      relativePath,
    } satisfies ActiveFileGuardResult;
  });

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
export function runGuardedLatexCommand(
  session: SessionHandle,
  options: GuardedLatexCommandOptions,
  operation: (guardResult: ActiveFileGuardSuccess) => Promise<void>,
): Effect.Effect<void> {
  const { channel, action, saveDocument = false, errorMessage } = options;

  const log = createLog(channel);

  return Effect.gen(function* () {
    const guardResult = yield* getActiveLatexEditor(session, saveDocument);

    if (guardResult.status !== 'ok') {
      const failure = GUARD_FAILURE_MESSAGES[guardResult.status];
      const logLine = `Cannot ${action}: ${failure.logTail}`;
      if (failure.level === 'error') {
        log.error(logLine);
      } else {
        log.warn(logLine);
      }
      return;
    }

    yield* Effect.promise(() => operation(guardResult));
  }).pipe(
    // The command's one terminal boundary, as the `try`/`catch` it replaces
    // was: a rejected guard step and a rejected operation alike are squashed
    // back to the value the `catch` clause bound.
    Effect.catchCause((cause) =>
      showLoggedErrorMessage(channel, errorMessage, Cause.squash(cause)).pipe(
        Effect.asVoid,
      ),
    ),
  );
}
