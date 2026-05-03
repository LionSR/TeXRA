export interface TerminalOptions {
  name: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface TerminalHandle {
  readonly name: string;
  sendText(text: string, shouldExecute?: boolean): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface TerminalHost {
  createTerminal(options: TerminalOptions): TerminalHandle;
  findTerminal(name: string): TerminalHandle | undefined;
  getTerminals(): readonly TerminalHandle[];
}
