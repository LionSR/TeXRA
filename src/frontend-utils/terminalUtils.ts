// Third-party imports
import * as vscode from 'vscode';

let terminal: vscode.Terminal | undefined;

export function getOrCreateTerminal(name: string): vscode.Terminal {
  const existingTerminal = vscode.window.terminals.find(
    (t) => t.name === name,
  );
  if (existingTerminal) {
    terminal = existingTerminal;
  } else if (!terminal || terminal.exitStatus !== undefined) {
    terminal = vscode.window.createTerminal(name);
  }
  return terminal;
}
