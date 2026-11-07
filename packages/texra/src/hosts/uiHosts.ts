// Third-party imports
import { type Effect, Schema } from 'effect';

export interface DiffSource {
  filePath: string;
}

/** How a diff is named: the title its view shows, and the path the
 *  desktop's Review pane files it under. */
export interface DiffLabel {
  readonly title: string;
  readonly displayPath: string;
}

/**
 * The host's diff surface: showing a diff, the one verb the two windowed
 * hosts answer. The terminal has no second surface to show one in — its
 * tool-edit modal renders the diff inline, and no CLI action names the
 * `openDiff` host case — so this port stays at two implementations.
 * Closing a diff, revealing its first change and reading back its proposed
 * side are VS Code's alone — its tab model is what they are written against —
 * so they live on `VscodeDiffViewHost` beside the approval host that calls
 * them, and the desktop's Review workbench names its own close by preview id.
 *
 * The member is an `Effect`, so the host's own refusal — VS Code declining
 * `vscode.diff`, the desktop failing to read a side or to hand a patch file to
 * the OS editor — reaches the caller through the failure channel instead of as
 * a rejection a lift had to re-tag, and interrupting the fiber that opened a
 * diff abandons the wait instead of detaching from it. The error is any
 * `Error`: each implementation fails with what its surface raised (a VS Code
 * command rejection, a `HostFailed`, a filesystem error), and the
 * callers that need a tag map it into their own.
 */
export interface DiffViewHost {
  /** Show the diff. The caller already holds the session it described. */
  openDiff(
    original: DiffSource,
    proposed: DiffSource,
    label: DiffLabel,
  ): Effect.Effect<void, Error>;
}

/**
 * A host capability failed on a channel its caller has no other tag for: a
 * message or dialog the host's own machinery would not show (VS Code's
 * `window.show*Message`, the desktop's `dialog.showMessageBox` when the window
 * it is anchored to is gone), a URL or path the operating system would not
 * open, a promise-faced host API that rejected. `member` names the call, so
 * a report says what failed; `message` is the failure's own text, so a
 * surface that renders only the message shows it unchanged; `cause` is the
 * value it failed with, so a host that classifies a failure reads that
 * rather than this wrapper.
 *
 * A user who dismisses a prompt or ignores a message is not a failure: that
 * is an answer (`undefined`, `false`) or the absence of one. The CLI's
 * notices and Ink dialogs are its own, so it raises this tag only where it
 * calls the platform.
 */
export class HostFailed extends Schema.TaggedError<HostFailed>()('HostFailed', {
  member: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * Open a URL in the host's default browser. The member is an `Effect`, so a
 * host that could not open it reaches the caller as {@link HostFailed}
 * rather than as `unknown`. Neither VS Code's `env.openExternal` nor
 * Electron's `shell.openExternal` has a cancellation channel, so an
 * interrupted fiber detaches from the wait — the foreign-API limitation the
 * port retains. The desktop's shell-facing fan-out behind this port is
 * Effect-typed too, so the composition root only words the failure and
 * crosses no promise to reach it.
 */
export interface ExternalOpener {
  openExternal(url: string): Effect.Effect<void, HostFailed>;
}

/**
 * A host capable of surfacing simple, non-blocking notifications to the
 * user. Distinct from {@link PromptHost}, which additionally supports
 * action items and awaits the user's choice; this is fire-and-forget
 * status reporting (a saved credential, a failed operation, a caveat).
 *
 * Every member is an `Effect`: a host that could not present reaches the
 * caller as {@link HostFailed} rather than as `unknown`, and a
 * caller that does not want to wait for the dialog forks the member instead
 * of `void`-ing a promise. Awaiting or forking is the caller's choice; the
 * member itself never reports a dismissal as an error, because there is
 * nothing to answer.
 */
export interface MessageHost {
  showInfoMessage(message: string): Effect.Effect<void, HostFailed>;
  showWarningMessage(message: string): Effect.Effect<void, HostFailed>;
  showErrorMessage(message: string): Effect.Effect<void, HostFailed>;
}

export type PromptMessageItem<T extends string = string> =
  | T
  | {
      label: T;
      isCloseAffordance?: boolean;
    };

/** What a message box and a confirmation both take. */
interface BaseDialogOptions {
  detail?: string;
  modal?: boolean;
}

export interface PromptMessageOptions<
  T extends string = string,
> extends BaseDialogOptions {
  items?: readonly PromptMessageItem<T>[];
}

export interface PromptConfirmOptions extends BaseDialogOptions {
  /**
   * Required so no confirmation ships with a content-free "OK"/"Yes" button:
   * every caller must name the action being confirmed.
   */
  confirmLabel: string;
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
 * caller through the failure channel rather than as `unknown`, and
 * interrupting the fiber that awaits a prompt dismisses it where the host has
 * a cancellation channel (VS Code's input box) and detaches from it where it
 * has none (native message boxes). The user's own answer — a dismissal
 * included — is a value, never an error.
 *
 * Every member fails with {@link HostFailed}.
 */
export interface PromptHost {
  info<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Effect.Effect<T | undefined, HostFailed>;
  warning<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Effect.Effect<T | undefined, HostFailed>;
  confirm(
    message: string,
    options: PromptConfirmOptions,
  ): Effect.Effect<boolean, HostFailed>;
  input(
    options: PromptInputOptions,
  ): Effect.Effect<string | undefined, HostFailed>;
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
  /**
   * Why the output could not be captured, in whole or in part; absent when
   * `output` is everything the command printed (up to the cap). `output` then
   * holds whatever was read before the loss, which may be nothing.
   */
  outputLost?: string;
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
const TerminalRunFailureReasonSchema = Schema.Literals([
  'terminal-unavailable',
  'execution-failed',
]);

/**
 * The one failure of a terminal run. Callers match the tag and read
 * `reason` instead of a message, so "this host would not give us a
 * terminal" and "the command's shell execution faulted" stay
 * distinguishable at the call site.
 */
export class TerminalRunFailed extends Schema.TaggedError<TerminalRunFailed>()(
  'TerminalRunFailed',
  {
    reason: TerminalRunFailureReasonSchema,
    message: Schema.String,
    command: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
