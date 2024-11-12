import * as vscode from 'vscode';
import { registerAgentEditorCommands } from './agentEditorCommands';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext) {
  registerCommands(context);
  registerAgentEditorCommands(context);
}

export function deactivate() {}
