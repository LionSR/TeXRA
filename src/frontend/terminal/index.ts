// Third-party imports
import * as vscode from 'vscode';

/**
 * Get an existing terminal by name or create a new one.
 * Only returns terminals that haven't exited.
 */
export function getOrCreateTerminal(name: string): vscode.Terminal {
  const existing = vscode.window.terminals.find(
    (t) => t.name === name && t.exitStatus === undefined,
  );
  return existing ?? vscode.window.createTerminal(name);
}
