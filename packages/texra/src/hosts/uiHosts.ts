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

/** How much a notice matters to the user. */
export type NoticeLevel = 'info' | 'warning' | 'error';

/** A modal question that names the action it confirms. */
export interface ConfirmQuestion {
  readonly message: string;
  /** The confirm button's label: the action, never a content-free "OK". */
  readonly action: string;
  readonly detail?: string;
}

/** One line of text the user types. */
export interface InputField {
  readonly prompt: string;
  readonly placeholder?: string;
  /** Mask what is typed (an API key, a token). */
  readonly secret?: boolean;
}

/**
 * The host's dialogs, in the app's words: a notice nobody answers, a modal
 * confirmation, and a text input.
 *
 * Every member is an `Effect`. A notice never fails: a host that could not
 * show it logs the cause at warn, since a run or a page must not fail
 * because a toast did not appear. It finishes when the host's call does (VS
 * Code's toast when it is dismissed), so a caller that must not wait forks
 * it. A confirmation or an input the host could not present fails with
 * {@link HostFailed}; the user's own answer, a dismissal included, is a value.
 * Interrupting the fiber that waits on an input closes it where the host has
 * a cancellation channel (VS Code's input box) and detaches from it where it
 * has none (native message boxes).
 */
export interface Dialogs {
  notify(level: NoticeLevel, message: string): Effect.Effect<void>;
  /** `false` on cancel. */
  confirm(question: ConfirmQuestion): Effect.Effect<boolean, HostFailed>;
  /** `undefined` on cancel. */
  input(field: InputField): Effect.Effect<string | undefined, HostFailed>;
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
