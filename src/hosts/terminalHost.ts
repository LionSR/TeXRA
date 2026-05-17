export interface TerminalOptions {
  name: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface TerminalOutputChunk {
  stream: 'stdout' | 'stderr';
  chunk: string;
}

export interface TerminalRunRequest extends TerminalOptions {
  command: string;
  /** Hard cap on how long to wait for captured execution. */
  timeoutMs: number;
  /** Cancels a captured command run. */
  signal?: AbortSignal;
  /** Streams command output while the process is still running. */
  onOutput?: (chunk: TerminalOutputChunk) => void;
}

export interface TerminalRunResult {
  /** Undefined when the host cannot observe the command exit code. */
  exitCode: number | undefined;
  /** ANSI-stripped, length-capped tail of command output when available. */
  output: string;
  timedOut: boolean;
  cancelled?: boolean;
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

export interface TerminalRunner {
  runCommand(request: TerminalRunRequest): Promise<TerminalRunResult>;
}
