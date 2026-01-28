// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { toErrorMessage } from '@common/errors';
// Local imports - frontend
import { fileLister } from '@frontend/files';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';

// Local imports - logging
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'openFileCommands';

function revealPosition(
  editor: vscode.TextEditor,
  pos: vscode.Position,
): void {
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

export async function openLabel(label: string): Promise<void> {
  const escape = label.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\\\label\\{${escape}\\}`, 'm');
  const candidates = new Set([
    ...(await fileLister.list('input')),
    ...(await fileLister.list('reference')),
  ]);

  for (const file of candidates) {
    try {
      const content = await WorkspaceFS.read(file);
      const match = content.match(pattern);
      if (match && match.index !== undefined) {
        const doc = await vscode.workspace.openTextDocument(
          WorkspaceFS.toAbsolute(file),
        );
        const editor = await vscode.window.showTextDocument(doc, {
          preview: true,
        });
        revealPosition(editor, doc.positionAt(match.index));
        return;
      }
    } catch (error) {
      logger.debug(
        CHANNEL,
        `Could not read file ${file}: ${toErrorMessage(error)}`,
      );
    }
  }

  vscode.window.showInformationMessage(`Label "${label}" not found.`);
}

export function registerOpenFileCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.openFileCompile',
      openBuildDisplayIfTex,
    ),
    vscode.commands.registerCommand('texra.openFile', openFile),
    vscode.commands.registerCommand('texra.openLabel', openLabel),
  );
}
