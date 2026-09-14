// Third-party imports
import { Data, type Effect } from 'effect';

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
 * Why a prompt never reached the user.
 *
 * Read off what the implementations raise, and nothing else: the desktop's
 * `dialog.showMessageBox(window, …)` rejects once the window it anchors to is
 * gone (`host-unavailable`), and VS Code's `window.show*Message` /
 * `showInputBox` reject when the host's own dialog machinery faults
 * (`presentation-failed`).
 *
 * A user who dismisses a prompt is **not** a failure: `info`/`warning`/
 * `error`/`input` answer `undefined` and `confirm` answers `false`, exactly as
 * they did before this port was typed. Neither is an interruption — a fiber
 * interrupted while a prompt is open dismisses or detaches from the wait and
 * the interruption propagates, so no caller reads it as a host fault.
 */
export class PromptFailed extends Data.TaggedError('PromptFailed')<{
  readonly reason: 'host-unavailable' | 'presentation-failed';
  /** The port member that could not present, for the caller's own report. */
  readonly member: 'info' | 'warning' | 'error' | 'confirm' | 'input';
  readonly message: string;
  readonly cause?: unknown;
}> {}

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

/**
 * The host's dialog surface: a message the user can answer, a confirmation,
 * and a text input.
 *
 * Every member is an `Effect`, so a host that could not present reaches the
 * caller as {@link PromptFailed} rather than as `unknown`, and interrupting
 * the fiber that awaits a prompt dismisses it where the host has a
 * cancellation channel (VS Code's input box) and detaches from it where it
 * has none (native message boxes). The user's own answer — a dismissal
 * included — is a value, never an error.
 */
export interface PromptHost {
  info<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Effect.Effect<T | undefined, PromptFailed>;
  warning<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Effect.Effect<T | undefined, PromptFailed>;
  error<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Effect.Effect<T | undefined, PromptFailed>;
  confirm(
    message: string,
    options: PromptConfirmOptions,
  ): Effect.Effect<boolean, PromptFailed>;
  input(
    options: PromptInputOptions,
  ): Effect.Effect<string | undefined, PromptFailed>;
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
 * Why an integrated-terminal run never produced a result.
 *
 * Read off what the one implementation
 * (`packages/extension/src/frontend/setupTerminalRunner.ts`) can raise:
 * the host refusing to open or reveal a terminal, and the shell execution
 * itself faulting once a terminal exists. Neither a non-zero exit code nor
 * a timeout is a failure — both are reported in {@link TerminalRunResult},
 * as they were before this port was typed.
 */
type TerminalRunFailureReason = 'terminal-unavailable' | 'execution-failed';

/**
 * The one failure of {@link TerminalRunner.runCommand}. Callers match the
 * tag and read `reason` instead of a message, so "this host would not give
 * us a terminal" and "the command's shell execution faulted" stay
 * distinguishable at the call site.
 */
export class TerminalRunFailed extends Data.TaggedError('TerminalRunFailed')<{
  readonly reason: TerminalRunFailureReason;
  readonly message: string;
  readonly command: string;
  readonly cause?: unknown;
}> {}

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
 *
 * The member is an `Effect`: a host fault reaches the caller as
 * {@link TerminalRunFailed} rather than as `unknown`, and interrupting the
 * fiber that runs it abandons the wait instead of leaving it uninterruptible.
 */
export interface TerminalRunner {
  runCommand(
    request: TerminalRunRequest,
  ): Effect.Effect<TerminalRunResult, TerminalRunFailed>;
}
