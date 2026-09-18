// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { getFileLister } from '@frontend/files/fileLister';
import { openFirstLabelMatch } from '@latex/labelSearch';
import { createLog } from '@logger/logUtils';
import type { ProcessRuntime } from '@platform/processRuntime';
import { withSessionFs, WorkspaceFs } from '@platform/rootedFs';
import { workspaceAbsolutePath } from '@utils/files/workspaceFS';
import { normalizeLineEndings } from '@utils/text/stringUtils';

const log = createLog('openFileCommands');

function revealPosition(editor: vscode.TextEditor, pos: vscode.Position): void {
  const range = new vscode.Range(pos, pos);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(pos, pos);
}

async function openFile(
  session: SessionHandle,
  file: string,
  line?: number,
): Promise<void> {
  const uri = vscode.Uri.file(
    workspaceAbsolutePath(session.roots.workspace, file),
  );

  if (line !== undefined && line > 0) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    revealPosition(editor, new vscode.Position(line - 1, 0));
  } else {
    await vscode.commands.executeCommand('vscode.open', uri);
  }
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
            Effect.sync(() => {
              log.debug(`Could not read file ${file}: ${error.message}`);
            }),
          ),
        ),
      (file, index) =>
        Effect.tryPromise({
          try: async () => {
            const doc = await vscode.workspace.openTextDocument(
              workspaceAbsolutePath(roots.workspace, file),
            );
            const editor = await vscode.window.showTextDocument(doc, {
              preview: true,
            });
            revealPosition(editor, doc.positionAt(index));
          },
          catch: (error) => error,
        }),
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
      handler: (file: string, line?: number) => openFile(session, file, line),
    },
    {
      id: 'texra.openLabel',
      handler: (label: string) => runtime.runPromise(openLabel(session, label)),
    },
  ]);
}
