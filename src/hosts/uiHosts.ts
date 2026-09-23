// Third-party imports
import { Data, type Effect } from 'effect';

export interface DiffSource {
  filePath: string;
}

/**
 * The host's diff surface: showing a diff, the one verb the two windowed
 * hosts answer. The terminal has no second surface to show one in — its
 * tool-edit modal renders the diff inline, and no CLI action names the
 * `openDiff` host arm — so this port stays at two implementations.
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
 * command rejection, an `ExternalOpenFailed`, a filesystem error), and the
 * callers that need a tag map it into their own.
 */
export interface DiffViewHost {
  /** Show the diff. The caller already holds the session it described. */
  openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
  ): Effect.Effect<void, Error>;
}

/**
 * The operating system would not open what it was handed: no handler for the
 * URL's scheme or the file's type, or the shell refusing the request. All
 * three hosts raise it — VS Code's `env.openExternal`, Electron's
 * `shell.openExternal`, and the CLI's platform opener (`open`, `rundll32`,
 * `xdg-open`).
 *
 * This is the tag {@link ExternalOpener.openExternal} fails with. The
 * desktop's sibling `openPath` is an Effect as well (owner ruling 2026-09-18,
 * which retires the earlier "permanent Promise face" for that fan-out), so a
 * caller wording its own report raises this tag by mapping that member's
 * failure rather than by lifting a promise. `kind` says whether a URL or a
 * local path was refused.
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
 * port retains. The desktop's shell-facing fan-out behind this port is
 * Effect-typed too (ruling 2026-09-18); the composition root only words the
 * failure, it no longer crosses a promise to reach it.
 */
export interface ExternalOpener {
  openExternal(url: string): Effect.Effect<void, ExternalOpenFailed>;
}

/**
 * Why a confirmation or an input box never reached the user.
 *
 * Read off what the implementations raise, and nothing else: the desktop's
 * `dialog.showMessageBox(window, …)` rejects once the window it anchors to is
 * gone (`host-unavailable`), and VS Code's `showInputBox` rejects when the
 * host's own dialog machinery faults (`presentation-failed`). The CLI's Ink
 * dialog raises neither: it is a form in the app's own foreground slot, so
 * there is no foreign dialog to fault. Its onboarding wizard, which renders
 * no such slot, raises `host-unavailable` for the two members it has no
 * surface for, so a caller that reached them there sees the fault rather than
 * a dismissal the user never made.
 *
 * The message members answer to {@link NotificationFailed} instead: a message
 * the host would not show is the same fault whether or not it carried buttons,
 * so there is one tag for it rather than one per shape. This tag is what is
 * left — the two members whose dialog is not a `show*Message` call on any
 * host.
 *
 * A user who dismisses a prompt is **not** a failure: `input` answers
 * `undefined` and `confirm` answers `false`, exactly as they did before this
 * port was typed. Neither is an interruption — a fiber interrupted while a
 * prompt is open dismisses or detaches from the wait and the interruption
 * propagates, so no caller reads it as a host fault.
 */
export class PromptFailed extends Data.TaggedError('PromptFailed')<{
  readonly reason: 'host-unavailable' | 'presentation-failed';
  /** The port member that could not present, for the caller's own report. */
  readonly member: 'confirm' | 'input';
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A message never reached the user: VS Code's `window.show*Message` or the
 * desktop's `dialog.showMessageBox` rejected, which they do only when the
 * host's own dialog machinery faults or the window a box is anchored to is
 * already gone. The CLI writes a local transcript notice, which cannot fail,
 * so it never raises this tag — the failure channel is what the two windowed
 * hosts need, not a cost the terminal pays. A user who ignores a message, or
 * dismisses one that offered buttons, is not a failure — that is an answer,
 * or the absence of one.
 *
 * This is the one tag both message surfaces fail with: every
 * {@link MessageHost} member and {@link PromptHost}'s `info`/`warning`/
 * `error`. The two shapes are the same host call with and without items, so
 * they raise the same tag and `member` names the call rather than the shape.
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
 * caller through the failure channel rather than as `unknown`, and
 * interrupting the fiber that awaits a prompt dismisses it where the host has
 * a cancellation channel (VS Code's input box) and detaches from it where it
 * has none (native message boxes). The user's own answer — a dismissal
 * included — is a value, never an error.
 *
 * `info`/`warning`/`error` are {@link MessageHost}'s members with items and an
 * answer, so they fail with {@link NotificationFailed}, the same tag that
 * surface raises; `confirm` and `input` open a dialog that is not a
 * `show*Message` call on any host and keep {@link PromptFailed}.
 */
export interface PromptHost {
  info<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Effect.Effect<T | undefined, NotificationFailed>;
  warning<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Effect.Effect<T | undefined, NotificationFailed>;
  error<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Effect.Effect<T | undefined, NotificationFailed>;
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
 * The one failure of a terminal run. Callers match the tag and read
 * `reason` instead of a message, so "this host would not give us a
 * terminal" and "the command's shell execution faulted" stay
 * distinguishable at the call site.
 */
export class TerminalRunFailed extends Data.TaggedError('TerminalRunFailed')<{
  readonly reason: TerminalRunFailureReason;
  readonly message: string;
  readonly command: string;
  readonly cause?: unknown;
}> {}
