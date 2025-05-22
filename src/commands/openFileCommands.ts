import * as vscode from 'vscode';

// Local imports - utilities
import { openAndBuildIfTex } from '../utils/openBuildUtils';

export function registerOpenFileCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.openFileCompile', openAndBuildIfTex),
  );
  return { openFileCompile: openAndBuildIfTex };
}
