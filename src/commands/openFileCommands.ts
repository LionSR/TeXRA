import * as vscode from 'vscode';
import * as logger from '../logger/logUtils';
import {
  fileExists,
  getFullPathFromWorkspace,
} from '../utils/workspaceFileUtils';

const CHANNEL = 'OpenFileCommands';
logger.initialize(CHANNEL);

export function registerOpenFileCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.openFileCompile', handleOpenFile),
  );
  return { openFileCompile: handleOpenFile };
}

async function handleOpenFile(file: string) {
  try {
    if (!(await fileExists(file))) {
      vscode.window.showErrorMessage(`File not found: ${file}`);
      return;
    }
    const fullPath = vscode.Uri.file(getFullPathFromWorkspace(file));
    const doc = await vscode.workspace.openTextDocument(fullPath);
    await vscode.window.showTextDocument(doc, { preview: false });

    if (file.endsWith('.tex')) {
      try {
        await vscode.commands.executeCommand('latex-workshop.build', fullPath);
      } catch (err) {
        logger.warn(CHANNEL, `LaTeX Workshop build failed: ${err}`);
      }
    }
  } catch (err) {
    logger.error(CHANNEL, `Error opening file: ${err}`);
  }
}
