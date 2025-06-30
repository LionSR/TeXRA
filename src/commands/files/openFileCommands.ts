import * as vscode from 'vscode';
import * as path from 'path';

// Local imports - utilities
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { WorkspaceFS } from '@utils/files';

export async function openFile(file: string): Promise<void> {
  const fullPath = path.isAbsolute(file) ? file : WorkspaceFS.fullPath(file);
  const uri = vscode.Uri.file(fullPath);
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
