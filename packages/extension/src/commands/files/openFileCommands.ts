// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { registerCommands } from '@commands/_shared/registerCommands';
import { toErrorMessage } from '@common/errors';
// Local imports - frontend
import { getFileLister } from '@frontend/files';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';

// Local imports - latex
import { findLabelLocation } from '@latex/labelSearch';

// Local imports - logging
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'openFileCommands';
logger.initialize(CHANNEL);

export const openFileCommands = {
  openFileCompile: 'texra.openFileCompile',
  openFile: 'texra.openFile',
  openLabel: 'texra.openLabel',
};

export interface OpenLabelOptions {
  notifyNotFound?: boolean;
}

function revealPosition(editor: vscode.TextEditor, pos: vscode.Position): void {
  const range = new vscode.Range(pos, pos);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(pos, pos);
}

export async function openFile(file: string, line?: number): Promise<void> {
  const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(file));

  if (line !== undefined && line > 0) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    revealPosition(editor, new vscode.Position(line - 1, 0));
  } else {
    await vscode.commands.executeCommand('vscode.open', uri);
  }
}

export async function openLabel(
  label: string,
  options: OpenLabelOptions = {},
): Promise<boolean> {
  const candidates = new Set([
    ...(await getFileLister().list('input')),
    ...(await getFileLister().list('context')),
  ]);

  const located = await findLabelLocation(label, candidates, async (file) => {
    try {
      return await WorkspaceFS.read(file);
    } catch (error) {
      logger.debug(
        CHANNEL,
        `Could not read file ${file}: ${toErrorMessage(error)}`,
      );
      throw error;
    }
  });
  if (located) {
    const doc = await vscode.workspace.openTextDocument(
      WorkspaceFS.toAbsolute(located.file),
    );
    const editor = await vscode.window.showTextDocument(doc, {
      preview: true,
    });
    revealPosition(editor, doc.positionAt(located.index));
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
  registerCommands(context, [
    { id: openFileCommands.openFileCompile, handler: openBuildDisplayIfTex },
    { id: openFileCommands.openFile, handler: openFile },
    { id: openFileCommands.openLabel, handler: openLabel },
  ]);
}
