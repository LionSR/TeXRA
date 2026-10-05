// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';
import { openFirstLabelMatch } from '@latex/labelSearch';
import { withLogChannel } from '@logger/effectLog';
import { WorkspaceFs } from '@platform/rootedFs';
import { listWorkspaceFilesOfType } from '@texra/controllers/session/workspaceFileOptions';
import { workspaceAbsolutePath } from '@utils/files/workspaceFS';
import { ensureError } from '@utils/errors/errorMessage';
import { normalizeLineEndings } from '@utils/text/stringUtils';

const CHANNEL = 'openFileCommands';

/**
 * Open `absolutePath` in the preview editor and put the cursor where `at`
 * says, for a line request and a label match alike.
 */
function openInEditor(
  absolutePath: string,
  at: (doc: vscode.TextDocument) => vscode.Position,
) {
  return openFileInEditor(absolutePath, { preview: true }).pipe(
    Effect.map(({ editor }) => {
      const pos = at(editor.document);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter,
      );
      editor.selection = new vscode.Selection(pos, pos);
    }),
  );
}

export function openFile(session: SessionHandle, file: string, line?: number) {
  const absolutePath = workspaceAbsolutePath(session.roots.workspace, file);
  const opened =
    line !== undefined && line > 0
      ? openInEditor(absolutePath, () => new vscode.Position(line - 1, 0))
      : Effect.tryPromise({
          try: () =>
            vscode.commands.executeCommand(
              'vscode.open',
              vscode.Uri.file(absolutePath),
            ),
          catch: ensureError,
        });
  return opened.pipe(
    Effect.tapError((error) =>
      Effect.logError(`Could not open ${file}: ${error.message}`).pipe(
        withLogChannel(CHANNEL),
      ),
    ),
    Effect.asVoid,
  );
}

/**
 * Locate a `\label{…}` across the input and context files and reveal it.
 * Returns whether a match was opened; the "not found" message belongs to the
 * caller (`ProgressWorkflowFileActionsController.openLabel`), which owns it
 * for every host.
 */
export const openLabel = Effect.fn('openFileCommands.openLabel')(function* (
  session: SessionHandle,
  label: string,
) {
  const { roots } = session;
  const [inputs, contexts] = yield* Effect.all([
    listWorkspaceFilesOfType('input', roots.workspace),
    listWorkspaceFilesOfType('context', roots.workspace),
  ]);
  // The candidates are workspace-relative listings, read through the
  // session's workspace view.
  const workspaceFs = yield* WorkspaceFs;

  return yield* openFirstLabelMatch(
    label,
    new Set([...inputs, ...contexts]),
    (file) =>
      workspaceFs.readFileString(file).pipe(
        Effect.map(normalizeLineEndings),
        Effect.tapError((error) =>
          Effect.logDebug(`Could not read file ${file}: ${error.message}`).pipe(
            withLogChannel(CHANNEL),
          ),
        ),
      ),
    (file, index) =>
      openInEditor(workspaceAbsolutePath(roots.workspace, file), (doc) =>
        doc.positionAt(index),
      ),
  );
});
