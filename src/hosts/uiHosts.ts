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

/**
 * The operating system would not open what it was handed: no handler for the
 * URL's scheme or the file's type, or the shell refusing the request.
 *
 * This is the tag {@link ExternalOpener.openExternal} fails with. The
 * desktop's sibling `openPath` keeps its `Promise` shape — it is bound in the
 * desktop's browser-view, shell, settings, tooling and credential surfaces, a
 * permanent face by owner ruling — so the Effect-side callers of that fan-out
 * raise this tag from their own `Effect.tryPromise`. `kind` says whether a
 * URL or a local path was refused.
 */
export class ExternalOpenFailed extends Data.TaggedError('ExternalOpenFailed')<{
  readonly kind: 'url' | 'path';
  readonly target: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * Open a URL in the host's default browser. The member is an `Effect`, so a
 * host that could not open it reaches the caller as {@link ExternalOpenFailed}
 * rather than as `unknown`. Neither VS Code's `env.openExternal` nor
 * Electron's `shell.openExternal` has a cancellation channel, so an
 * interrupted fiber detaches from the wait — the foreign-API limitation the
 * port retains. The desktop's shell-facing fan-out behind this port keeps
 * its `Promise` shape by ruling; the desktop composition root adapts it here.
 */
export interface ExternalOpener {
  openExternal(url: string): Effect.Effect<void, ExternalOpenFailed>;
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
 * A notification never reached the user: VS Code's `window.show*Message` or
 * the desktop's `dialog.showMessageBox` rejected, which they do only when the
 * host's own dialog machinery faults or the window a box is anchored to is
 * already gone. A user who ignores a notification is not a failure — these
 * members answer nothing.
 *
 * This is the one tag every {@link MessageHost} member fails with, so a
 * caller matches `NotificationFailed` rather than catching `unknown`.
 * `message` is the rejection's own text, so it survives being shown through a
 * reporting surface that renders only the message.
 */
export class NotificationFailed extends Data.TaggedError('NotificationFailed')<{
  readonly member:
    'showInfoMessage' | 'showWarningMessage' | 'showErrorMessage';
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * A host capable of surfacing simple, non-blocking notifications to the
 * user. Distinct from {@link PromptHost}, which additionally supports
 * action items and awaits the user's choice; this is fire-and-forget
 * status reporting (a saved credential, a failed operation, a caveat).
 *
 * Every member is an `Effect`: a host that could not present reaches the
 * caller as {@link NotificationFailed} rather than as `unknown`, and a
 * caller that does not want to wait for the dialog forks the member instead
 * of `void`-ing a promise. Awaiting or forking is the caller's choice; the
 * member itself never reports a dismissal as an error, because there is
 * nothing to answer.
 */
export interface MessageHost {
  showInfoMessage(message: string): Effect.Effect<void, NotificationFailed>;
  showWarningMessage(message: string): Effect.Effect<void, NotificationFailed>;
  showErrorMessage(message: string): Effect.Effect<void, NotificationFailed>;
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
