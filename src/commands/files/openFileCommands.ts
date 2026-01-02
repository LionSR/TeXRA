// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Local imports - logging
import * as logger from '@logger/logUtils';

const CHANNEL = 'openFileCommands';

// Local imports - utilities
import { fileLister } from '@frontend/files';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { WorkspaceFS } from '@utils/files';

export async function openFile(file: string): Promise<void> {
  const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(file));
  await vscode.commands.executeCommand('vscode.open', uri);
}

export async function openLabel(label: string): Promise<void> {
  const escape = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        const pos = doc.positionAt(match.index);
        const editor = await vscode.window.showTextDocument(doc, {
          preview: true,
        });
        const range = new vscode.Range(pos, pos);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(pos, pos);
        return;
      }
    } catch (error) {
      // Log but continue search - file might be inaccessible
      logger.debug(
        CHANNEL,
        `Could not read file ${file}: ${toErrorMessage(error)}`,
      );
    }
  }

  vscode.window.showInformationMessage(`Label "${label}" not found.`);
}

/** Command handlers for file operations */
export const openFileCommands = {
  openFileCompile: openBuildDisplayIfTex,
  openFile,
  openLabel,
};

export function registerOpenFileCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.openFileCompile',
      openBuildDisplayIfTex,
    ),
    vscode.commands.registerCommand('texra.openFile', openFile),
    vscode.commands.registerCommand('texra.openLabel', openLabel),
  );
  return openFileCommands;
}
