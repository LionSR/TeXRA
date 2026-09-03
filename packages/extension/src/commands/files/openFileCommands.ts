// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { getFileLister } from '@frontend/files/fileLister';
import { openFirstLabelMatch } from '@latex/labelSearch';
import { createLog } from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('openFileCommands');

function revealPosition(editor: vscode.TextEditor, pos: vscode.Position): void {
  const range = new vscode.Range(pos, pos);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(pos, pos);
}

async function openFile(file: string, line?: number): Promise<void> {
  const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(file));

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
async function openLabel(label: string): Promise<boolean> {
  const candidates = new Set([
    ...(await getFileLister().list('input')),
    ...(await getFileLister().list('context')),
  ]);

  return openFirstLabelMatch(
    label,
    candidates,
    async (file) => {
      try {
        return await WorkspaceFS.read(file);
      } catch (error) {
        log.debug(`Could not read file ${file}: ${toErrorMessage(error)}`);
        throw error;
      }
    },
    async (file, index) => {
      const doc = await vscode.workspace.openTextDocument(
        WorkspaceFS.toAbsolute(file),
      );
      const editor = await vscode.window.showTextDocument(doc, {
        preview: true,
      });
      revealPosition(editor, doc.positionAt(index));
    },
  );
}

export function registerOpenFileCommands(
  context: vscode.ExtensionContext,
): void {
  registerCommandEntries(context, [
    { id: 'texra.openFile', handler: openFile },
    { id: 'texra.openLabel', handler: openLabel },
  ]);
}
