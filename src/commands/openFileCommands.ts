import * as vscode from 'vscode';

// Local imports - utilities
import { openBuildDisplayIfTex } from '../utils/openBuildUtils';

export function registerOpenFileCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.openFileCompile',
      openBuildDisplayIfTex,
    ),
  );
  return { openFileCompile: openBuildDisplayIfTex };
}
