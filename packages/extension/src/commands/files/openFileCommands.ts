// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { getFileLister } from '@frontend/files/fileLister';
import { openFirstLabelMatch } from '@latex/labelSearch';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessRuntime } from '@platform/processRuntime';
import { withSessionFs, WorkspaceFs } from '@platform/rootedFs';
import { workspaceAbsolutePath } from '@utils/files/workspaceFS';
import { normalizeLineEndings } from '@utils/text/stringUtils';
import { ensureError } from '@utils/errors/errorMessage';

const CHANNEL = 'openFileCommands';

function revealPosition(editor: vscode.TextEditor, pos: vscode.Position): void {
  const range = new vscode.Range(pos, pos);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(pos, pos);
}

/**
 * Open `uri` in the preview editor and put the cursor where `at` says. The one
 * lift of the three editor calls, for a line request and a label match alike.
 */
function openInEditor(
  uri: vscode.Uri,
  at: (doc: vscode.TextDocument) => vscode.Position,
) {
  return Effect.tryPromise({
    try: async () => {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: true,
      });
      revealPosition(editor, at(doc));
    },
    catch: ensureError,
  });
}

function openFile(session: SessionHandle, file: string, line?: number) {
  const uri = vscode.Uri.file(
    workspaceAbsolutePath(session.roots.workspace, file),
  );
  const opened =
    line !== undefined && line > 0
      ? openInEditor(uri, () => new vscode.Position(line - 1, 0))
      : Effect.tryPromise({
          try: () => vscode.commands.executeCommand('vscode.open', uri),
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
function openLabel(session: SessionHandle, label: string) {
  return Effect.gen(function* () {
    const lister = getFileLister();
    const inputs = yield* lister.list('input');
    const contexts = yield* lister.list('context');
    const candidates = new Set([...inputs, ...contexts]);
    const { roots } = session;
    // The candidates are workspace-relative listings, read through the
    // session's workspace view.
    const workspaceFs = yield* withSessionFs(
      roots,
      Effect.service(WorkspaceFs),
    );

    return yield* openFirstLabelMatch(
      label,
      candidates,
      (file) =>
        workspaceFs.readFileString(file).pipe(
          Effect.map(normalizeLineEndings),
          Effect.tapError((error) =>
            Effect.logDebug(
              `Could not read file ${file}: ${error.message}`,
            ).pipe(withLogChannel(CHANNEL)),
          ),
        ),
      (file, index) =>
        openInEditor(
          vscode.Uri.file(workspaceAbsolutePath(roots.workspace, file)),
          (doc) => doc.positionAt(index),
        ),
    );
  });
}

export function registerOpenFileCommands(
  context: vscode.ExtensionContext,
  runtime: ProcessRuntime,
  session: SessionHandle,
): void {
  registerCommandEntries(context, [
    {
      id: 'texra.openFile',
      handler: (file: string, line?: number) =>
        runtime.runPromise(openFile(session, file, line)),
    },
    {
      id: 'texra.openLabel',
      handler: (label: string) => runtime.runPromise(openLabel(session, label)),
    },
  ]);
}
