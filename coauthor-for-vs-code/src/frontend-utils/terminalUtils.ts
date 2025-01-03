// Third-party imports
import * as vscode from 'vscode';

let terminal: vscode.Terminal | undefined;

export function ensureTerminal() {
  const existingTerminal = vscode.window.terminals.find(
    (t) => t.name === 'housekeeping',
  );
  if (existingTerminal) {
    terminal = existingTerminal;
  } else if (!terminal || terminal.exitStatus !== undefined) {
    terminal = vscode.window.createTerminal('housekeeping');
  }
  return terminal;
}
