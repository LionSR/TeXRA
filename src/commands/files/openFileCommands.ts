import * as vscode from 'vscode';
// Local imports - utilities
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { resolveFilePath } from '@utils/files';

export async function openFile(file: string): Promise<void> {
  const uri = vscode.Uri.file(resolveFilePath(file));
  await vscode.commands.executeCommand('vscode.open', uri);
}

export function registerOpenFileCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.openFileCompile',
      openBuildDisplayIfTex,
    ),
    vscode.commands.registerCommand('texra.openFile', openFile),
  );
  return { openFileCompile: openBuildDisplayIfTex, openFile };
}
