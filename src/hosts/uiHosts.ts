export interface DiffSource {
  filePath: string;
}

export interface DiffSession {
  original: DiffSource;
  proposed: DiffSource;
  title: string;
}

export interface DiffViewHost {
  /** Show the diff. The caller already holds the session it described. */
  openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
  ): Promise<void>;
  closeDiff(session: DiffSession): Promise<void>;
  revealFirstChange(session: DiffSession, line: number): Promise<void>;
  readProposedContent(session: DiffSession): Promise<string>;
}

export interface ExternalOpener {
  openExternal(url: string): Promise<void>;
}

/**
 * A host capable of surfacing simple, non-blocking notifications to the
 * user. Distinct from {@link PromptHost}, which additionally supports
 * action items and awaits the user's choice; this is fire-and-forget
 * status reporting (a saved credential, a failed operation, a caveat).
 */
export interface MessageHost {
  showInfoMessage(message: string): Promise<void> | void;
  showWarningMessage(message: string): Promise<void> | void;
  showErrorMessage(message: string): Promise<void> | void;
}

export type PromptMessageItem<T extends string = string> =
  | T
  | {
      label: T;
      isCloseAffordance?: boolean;
    };

export interface PromptMessageOptions<T extends string = string> {
  detail?: string;
  modal?: boolean;
  items?: readonly PromptMessageItem<T>[];
}

export interface PromptConfirmOptions {
  detail?: string;
  modal?: boolean;
  /**
   * Required so no confirmation ships with a content-free "OK"/"Yes" button:
   * every caller must name the action being confirmed.
   */
  confirmLabel: string;
  cancelLabel?: string;
}

export interface PromptInputOptions {
  prompt?: string;
  placeHolder?: string;
  password?: boolean;
}

export interface PromptHost {
  info<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Promise<T | undefined>;
  warning<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Promise<T | undefined>;
  error<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Promise<T | undefined>;
  confirm(message: string, options: PromptConfirmOptions): Promise<boolean>;
  input(options: PromptInputOptions): Promise<string | undefined>;
}

export interface TerminalRunRequest {
  name: string;
  command: string;
  /** Hard cap on how long to wait for captured execution. */
  timeoutMs: number;
}

export interface TerminalRunResult {
  /** Undefined when the host cannot observe the command exit code. */
  exitCode: number | undefined;
  /** ANSI-stripped, length-capped tail of command output when available. */
  output: string;
  timedOut: boolean;
}

/**
 * Integrated-terminal surface. The setup agent uses this for commands
 * the captured-stdio `bash` tool cannot handle: `sudo` password prompts,
 * other interactive TTY prompts, and any flow where the user must type
 * into the running process.
 *
 * Implementations should prefer VS Code's stable `Terminal.shellIntegration`
 * API (since 1.93) so the agent can read back exit code + output. When
 * shell integration is unavailable the implementation may return an
 * `undefined` exit code with empty output — the caller treats that the
 * same as "user interrupted", since neither path tells us anything
 * actionable.
 */
export interface TerminalRunner {
  runCommand(request: TerminalRunRequest): Promise<TerminalRunResult>;
}
