import * as vscode from 'vscode';
import * as logger from '../logger/logUtils';
import { getFullPathFromWorkspace } from '../utils/workspaceFileUtils';

const CHANNEL = 'openFileCommands';
logger.initialize(CHANNEL);

export function registerOpenFileCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.openFileCompile', openFileCompile),
  );
  return { openFileCompile };
}

async function openFileCompile(file: string) {
  try {
    const fullPath = getFullPathFromWorkspace(file);
    const uri = vscode.Uri.file(fullPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });

    if (file.toLowerCase().endsWith('.tex')) {
      await vscode.commands.executeCommand('latex-workshop.build', uri);
    }
  } catch (err) {
    logger.error(
      CHANNEL,
      `Failed to open file ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage(`Could not open ${file}`);
  }
}
