import * as vscode from 'vscode';

// Local imports - utilities
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';

/**
 * Open a file without triggering LaTeX compilation
 */
async function openResource(filePath: string): Promise<void> {
  try {
    const uri = vscode.Uri.file(filePath);
    await vscode.window.showTextDocument(uri);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
  }
}

export function registerOpenFileCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.openFileCompile',
      openBuildDisplayIfTex,
    ),
    vscode.commands.registerCommand('texra.openResource', openResource),
  );
  return {
    openFileCompile: openBuildDisplayIfTex,
    openResource,
  };
}
