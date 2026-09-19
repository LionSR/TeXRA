// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import {
  NotificationFailed,
  PromptFailed,
  type MessageHost,
  type PromptConfirmOptions,
  type PromptHost,
  type PromptInputOptions,
  type PromptMessageItem,
  type PromptMessageOptions,
} from '@hosts/uiHosts';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Each entry calls through `vscode.window` at call time rather than holding
 * the function it read at import: the message keeps its receiver, and a host
 * that swaps the window surface (a test double, a reloaded API) is the one
 * that answers the call.
 */
const SHOW_OF_MEMBER: Record<
  NotificationFailed['member'],
  (
    message: string,
    options: vscode.MessageOptions,
    ...items: vscode.MessageItem[]
  ) => Thenable<vscode.MessageItem | undefined>
> = {
  showInfoMessage: (message, options, ...items) =>
    vscode.window.showInformationMessage(message, options, ...items),
  showWarningMessage: (message, options, ...items) =>
    vscode.window.showWarningMessage(message, options, ...items),
  showErrorMessage: (message, options, ...items) =>
    vscode.window.showErrorMessage(message, options, ...items),
};

/**
 * VS Code's message and dialog surfaces behind the host-neutral
 * {@link MessageHost} and {@link PromptHost}.
 *
 * Both ports end in the same three `vscode.window.show*Message` calls — a
 * toast is that call with no items and no answer — so this holds one wrap of
 * them, in `showMessage`. The fire-and-forget members are that program with
 * the answer voided, which is why they raise the same
 * {@link NotificationFailed} an answerable message does.
 *
 * Notifications and modal message boxes have no cancellation channel in the
 * VS Code API, so an interrupted fiber detaches from them and the dialog stays
 * on screen until the user dismisses it. The input box does have one: it takes
 * a `CancellationToken`, so an interrupted `input` closes the box the run
 * opened instead of leaving it waiting for an answer nobody will read.
 */
export class VscodeUiHost implements MessageHost, PromptHost {
  showInfoMessage(message: string): Effect.Effect<void, NotificationFailed> {
    return Effect.asVoid(this.info(message));
  }

  showWarningMessage(message: string): Effect.Effect<void, NotificationFailed> {
    return Effect.asVoid(this.warning(message));
  }

  showErrorMessage(message: string): Effect.Effect<void, NotificationFailed> {
    return Effect.asVoid(this.error(message));
  }

  info<T extends string = string>(
    message: string,
    options: PromptMessageOptions<T> = {},
  ): Effect.Effect<T | undefined, NotificationFailed> {
    return this.showMessage('showInfoMessage', message, options);
  }

  warning<T extends string = string>(
    message: string,
    options: PromptMessageOptions<T> = {},
  ): Effect.Effect<T | undefined, NotificationFailed> {
    return this.showMessage('showWarningMessage', message, options);
  }

  error<T extends string = string>(
    message: string,
    options: PromptMessageOptions<T> = {},
  ): Effect.Effect<T | undefined, NotificationFailed> {
    return this.showMessage('showErrorMessage', message, options);
  }

  /**
   * A confirmation is a warning message carrying the two buttons this port
   * mandates, so it runs the same wrap. It keeps {@link PromptFailed}: the
   * desktop answers this member with a native confirmation dialog rather than
   * with a `show*Message` call, so the tag names the member neither host could
   * present rather than a call only one of them makes.
   */
  confirm(
    message: string,
    options: PromptConfirmOptions,
  ): Effect.Effect<boolean, PromptFailed> {
    const confirmLabel = options.confirmLabel;
    const cancelLabel = options.cancelLabel ?? 'Cancel';
    return this.showMessage('showWarningMessage', message, {
      detail: options.detail,
      modal: options.modal ?? true,
      items: [confirmLabel, { label: cancelLabel, isCloseAffordance: true }],
    }).pipe(
      Effect.mapError(
        (failure) =>
          new PromptFailed({
            reason: 'presentation-failed',
            member: 'confirm',
            message: 'VS Code would not show the confirmation dialog.',
            cause: failure.cause,
          }),
      ),
      Effect.map((selected) => selected === confirmLabel),
    );
  }

  /**
   * Ask for one line of text. The box is opened with a cancellation token this
   * program owns: the token source is disposed on every path — the answer, a
   * host fault, and interruption — and cancelling it is what closes an input
   * box the user never answered.
   */
  input(
    options: PromptInputOptions,
  ): Effect.Effect<string | undefined, PromptFailed> {
    return Effect.callback<string | undefined, PromptFailed>((resume) => {
      const tokens = new vscode.CancellationTokenSource();
      let settled = false;
      const dispose = () => {
        if (settled) return false;
        settled = true;
        tokens.dispose();
        return true;
      };
      void Promise.resolve(
        vscode.window.showInputBox(options, tokens.token),
      ).then(
        (value) => {
          dispose();
          resume(Effect.succeed(value));
        },
        (cause: unknown) => {
          dispose();
          resume(
            Effect.fail(
              new PromptFailed({
                reason: 'presentation-failed',
                member: 'input',
                message: 'VS Code would not show the input box.',
                cause,
              }),
            ),
          );
        },
      );
      return Effect.sync(() => {
        if (settled) return;
        tokens.cancel();
        dispose();
      });
    });
  }

  /** The one wrap of `vscode.window.show*Message` this host holds. */
  private showMessage<T extends string>(
    member: NotificationFailed['member'],
    message: string,
    options: PromptMessageOptions<T>,
  ): Effect.Effect<T | undefined, NotificationFailed> {
    return Effect.tryPromise({
      try: async () =>
        SHOW_OF_MEMBER[member](
          message,
          { detail: options.detail, modal: options.modal },
          ...this.toVscodeItems(options.items),
        ),
      catch: (cause) =>
        new NotificationFailed({
          member,
          message: toErrorMessage(cause),
          cause,
        }),
    }).pipe(Effect.map((selected) => selected?.title as T | undefined));
  }

  private toVscodeItems<T extends string>(
    items: readonly PromptMessageItem<T>[] = [],
  ): vscode.MessageItem[] {
    return items.map((item) => {
      if (typeof item === 'string') {
        return { title: item };
      }
      return {
        title: item.label,
        isCloseAffordance: item.isCloseAffordance,
      };
    });
  }
}
