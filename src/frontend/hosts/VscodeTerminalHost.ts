// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type {
  TerminalHandle,
  TerminalHost,
  TerminalOptions,
} from '@hosts/terminalHost';

export class VscodeTerminalHost implements TerminalHost {
  createTerminal(options: TerminalOptions): TerminalHandle {
    return new VscodeTerminalHandle(vscode.window.createTerminal(options));
  }

  findTerminal(name: string): TerminalHandle | undefined {
    const terminal = vscode.window.terminals.find(
      (candidate) =>
        candidate.name === name && candidate.exitStatus === undefined,
    );
    return terminal ? new VscodeTerminalHandle(terminal) : undefined;
  }

  getTerminals(): readonly TerminalHandle[] {
    return vscode.window.terminals
      .filter((terminal) => terminal.exitStatus === undefined)
      .map((terminal) => new VscodeTerminalHandle(terminal));
  }
}

class VscodeTerminalHandle implements TerminalHandle {
  constructor(private readonly terminal: vscode.Terminal) {}

  get name(): string {
    return this.terminal.name;
  }

  sendText(text: string, shouldExecute?: boolean): void {
    this.terminal.sendText(text, shouldExecute);
  }

  show(preserveFocus?: boolean): void {
    this.terminal.show(preserveFocus);
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
