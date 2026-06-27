export interface ClipboardHost {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface DiffSource {
  filePath: string;
}

export interface DiffSession {
  original: DiffSource;
  proposed: DiffSource;
  title: string;
}

export interface DiffOptions {
  preserveFocus?: boolean;
}

export interface DiffViewHost {
  openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
    options?: DiffOptions,
  ): Promise<DiffSession>;
  closeDiff(session: DiffSession): Promise<void>;
  revealFirstChange(session: DiffSession, line: number): Promise<void>;
  readProposedContent(
    session: DiffSession,
    fallbackContent: string,
  ): Promise<string>;
}

export interface ExternalOpener {
  openExternal(url: string): Promise<void>;
  openPath(filePath: string): Promise<void>;
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
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface PromptInputOptions {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  password?: boolean;
  ignoreFocusOut?: boolean;
  validateInput?: (
    value: string,
  ) => string | undefined | null | Promise<string | undefined | null>;
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
  confirm(message: string, options?: PromptConfirmOptions): Promise<boolean>;
  input(options: PromptInputOptions): Promise<string | undefined>;
}

export interface TerminalOptions {
  name: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface TerminalRunRequest extends TerminalOptions {
  command: string;
  /** Hard cap on how long to wait for captured execution. */
  timeoutMs: number;
}

/**
 * Length cap (chars) for {@link TerminalRunResult.output}. Every host's
 * `TerminalRunner` keeps the same sliding-window tail so agents see identical
 * truncation regardless of where a setup command ran.
 */
export const TERMINAL_OUTPUT_MAX_CHARS = 12_000;

export interface TerminalRunResult {
  /** Undefined when the host cannot observe the command exit code. */
  exitCode: number | undefined;
  /** ANSI-stripped, length-capped tail of command output when available. */
  output: string;
  timedOut: boolean;
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

export interface UIHosts {
  readonly prompt: PromptHost;
  readonly externalOpener: ExternalOpener;
  readonly diff: DiffViewHost;
  readonly terminal: TerminalHost;
  readonly clipboard: ClipboardHost;
}
