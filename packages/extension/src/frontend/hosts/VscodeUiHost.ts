// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { withLogChannel } from '@texra-ai/harness/plugins';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import {
  HostFailed,
  type ConfirmQuestion,
  type Dialogs,
  type InputField,
  type NoticeLevel,
} from '@texra/hosts/uiHosts';

/**
 * Each entry calls through `vscode.window` at call time rather than holding
 * the function it read at import: the message keeps its receiver, and a host
 * that swaps the window surface (a test double, a reloaded API) is the one
 * that answers the call.
 */
const SHOW_OF_LEVEL: Record<
  NoticeLevel,
  (
    message: string,
    options: vscode.MessageOptions,
    ...items: vscode.MessageItem[]
  ) => Thenable<vscode.MessageItem | undefined>
> = {
  info: (message, options, ...items) =>
    vscode.window.showInformationMessage(message, options, ...items),
  warning: (message, options, ...items) =>
    vscode.window.showWarningMessage(message, options, ...items),
  error: (message, options, ...items) =>
    vscode.window.showErrorMessage(message, options, ...items),
};

/** A button of an answerable message; the close affordance is the one VS
 *  Code also answers for Escape. */
type MessageItem<T extends string> =
  | T
  | { readonly label: T; readonly isCloseAffordance?: boolean };

/** What an answerable message takes, in VS Code's `MessageOptions` words. */
interface MessageOptions<T extends string> {
  readonly items?: readonly MessageItem<T>[];
  readonly detail?: string;
  readonly modal?: boolean;
}

/**
 * A cancellable VS Code call the calling fiber owns — a quick pick, an input
 * box, a language server request: the token source is disposed on every
 * path — the answer, a host fault, and interruption — and an interrupt
 * cancels it, which is what closes a list or box the user never answered.
 */
export const withCancellationToken = <A, E>(
  show: (token: vscode.CancellationToken) => Thenable<A>,
  failed: (cause: unknown) => E,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => new vscode.CancellationTokenSource()),
    (tokens) =>
      Effect.tryPromise({
        try: async () => show(tokens.token),
        catch: failed,
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => tokens.cancel()))),
    (tokens) => Effect.sync(() => tokens.dispose()),
  );

/**
 * VS Code's message and dialog surfaces behind the host-neutral
 * {@link Dialogs}, plus the message with buttons only VS Code's own
 * modules ask (`ask`).
 *
 * Every member ends in one of the three `vscode.window.show*Message` calls
 * (`showMessage`), except the input box. Notifications and modal message
 * boxes have no cancellation channel in the VS Code API, so an interrupted
 * fiber detaches from them and the dialog stays on screen until the user
 * dismisses it. The input box takes a `CancellationToken`, so an interrupted
 * `input` closes the box the run opened instead of leaving it waiting for
 * an answer nobody will read.
 */
class VscodeUiHost implements Dialogs {
  notify(level: NoticeLevel, message: string): Effect.Effect<void> {
    return this.showMessage(level, message, {}).pipe(
      Effect.asVoid,
      Effect.catch((failure) =>
        Effect.logWarning(
          `VS Code would not show a notice: ${failure.message}`,
        ).pipe(withLogChannel('VscodeUiHost')),
      ),
    );
  }

  /** A message with buttons, which only VS Code's own modules ask; the label
   *  chosen, or `undefined` when dismissed. */
  ask<T extends string = string>(
    level: NoticeLevel,
    message: string,
    options: MessageOptions<T> = {},
  ): Effect.Effect<T | undefined, HostFailed> {
    return this.showMessage(level, message, options);
  }

  /** A modal warning carrying the action and Cancel. */
  confirm(question: ConfirmQuestion): Effect.Effect<boolean, HostFailed> {
    return this.showMessage('warning', question.message, {
      detail: question.detail,
      modal: true,
      items: [question.action, { label: 'Cancel', isCloseAffordance: true }],
    }).pipe(
      Effect.mapError(
        (failure) =>
          new HostFailed({
            member: 'confirm',
            message: 'VS Code would not show the confirmation dialog.',
            cause: failure.cause,
          }),
      ),
      Effect.map((selected) => selected === question.action),
    );
  }

  /** Ask for one line of text in a box {@link withCancellationToken} owns. */
  input(field: InputField): Effect.Effect<string | undefined, HostFailed> {
    return withCancellationToken(
      // A secret pasted from another window must not dismiss the box.
      (token) =>
        vscode.window.showInputBox(
          {
            prompt: field.prompt,
            placeHolder: field.placeholder,
            password: field.secret,
            ignoreFocusOut: true,
          },
          token,
        ),
      (cause) =>
        new HostFailed({
          member: 'input',
          message: 'VS Code would not show the input box.',
          cause,
        }),
    );
  }

  /** The one wrap of `vscode.window.show*Message` this host holds. */
  private showMessage<T extends string>(
    level: NoticeLevel,
    message: string,
    options: MessageOptions<T>,
  ): Effect.Effect<T | undefined, HostFailed> {
    const items = (options.items ?? []).map(
      (item): vscode.MessageItem & { title: T } =>
        typeof item === 'string'
          ? { title: item }
          : { title: item.label, isCloseAffordance: item.isCloseAffordance },
    );
    return Effect.tryPromise({
      try: async () =>
        SHOW_OF_LEVEL[level](
          message,
          { detail: options.detail, modal: options.modal },
          ...items,
        ),
      catch: (cause) =>
        new HostFailed({
          member: `window.show ${level} message`,
          message: toErrorMessage(cause),
          cause,
        }),
    }).pipe(
      Effect.map(
        (selected) =>
          items.find((item) => item.title === selected?.title)?.title,
      ),
    );
  }
}

/**
 * The process's one instance. The host holds no state — every member reads
 * `vscode.window` at call time — so the surfaces that present on it share
 * this rather than each constructing a copy of the same empty object.
 */
export const vscodeUi = new VscodeUiHost();
