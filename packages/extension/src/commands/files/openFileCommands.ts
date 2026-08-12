// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { getFileLister } from '@frontend/files/fileLister';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { openFirstLabelMatch } from '@latex/labelSearch';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'openFileCommands';

interface OpenLabelOptions {
  notifyNotFound?: boolean;
}

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

async function openLabel(
  label: string,
  options: OpenLabelOptions = {},
): Promise<boolean> {
  const candidates = new Set([
    ...(await getFileLister().list('input')),
    ...(await getFileLister().list('context')),
  ]);

  const opened = await openFirstLabelMatch(
    label,
    candidates,
    async (file) => {
      try {
        return await WorkspaceFS.read(file);
      } catch (error) {
        logger.debug(
          CHANNEL,
          `Could not read file ${file}: ${toErrorMessage(error)}`,
        );
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
  if (opened) {
    return true;
  }

  if (options.notifyNotFound ?? true) {
    vscode.window.showInformationMessage(`Label "${label}" not found.`);
  }
  return false;
}

export function registerOpenFileCommands(
  context: vscode.ExtensionContext,
): void {
  registerCommandEntries(context, [
    { id: 'texra.openFileCompile', handler: openBuildDisplayIfTex },
    { id: 'texra.openFile', handler: openFile },
    { id: 'texra.openLabel', handler: openLabel },
  ]);
}
