// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import {
  PromptFailed,
  type PromptConfirmOptions,
  type PromptHost,
  type PromptInputOptions,
  type PromptMessageItem,
  type PromptMessageOptions,
} from '@hosts/uiHosts';

/**
 * VS Code's dialog surface behind the host-neutral {@link PromptHost}.
 *
 * Notifications and modal message boxes have no cancellation channel in the
 * VS Code API, so an interrupted fiber detaches from them and the dialog stays
 * on screen until the user dismisses it. The input box does have one: it takes
 * a `CancellationToken`, so an interrupted `input` closes the box the run
 * opened instead of leaving it waiting for an answer nobody will read.
 */
export class VscodePromptHost implements PromptHost {
  info<T extends string = string>(
    message: string,
    options: PromptMessageOptions<T> = {},
  ): Effect.Effect<T | undefined, PromptFailed> {
    return this.showMessage(
      'info',
      message,
      options,
      vscode.window.showInformationMessage,
    );
  }

  warning<T extends string = string>(
    message: string,
    options: PromptMessageOptions<T> = {},
  ): Effect.Effect<T | undefined, PromptFailed> {
    return this.showMessage(
      'warning',
      message,
      options,
      vscode.window.showWarningMessage,
    );
  }

  error<T extends string = string>(
    message: string,
    options: PromptMessageOptions<T> = {},
  ): Effect.Effect<T | undefined, PromptFailed> {
    return this.showMessage(
      'error',
      message,
      options,
      vscode.window.showErrorMessage,
    );
  }

  confirm(
    message: string,
    options: PromptConfirmOptions,
  ): Effect.Effect<boolean, PromptFailed> {
    const confirmLabel = options.confirmLabel;
    const cancelLabel = options.cancelLabel ?? 'Cancel';
    return Effect.tryPromise({
      try: async () =>
        vscode.window.showWarningMessage(
          message,
          { detail: options.detail, modal: options.modal ?? true },
          { title: confirmLabel },
          { title: cancelLabel, isCloseAffordance: true },
        ),
      catch: (cause) =>
        new PromptFailed({
          reason: 'presentation-failed',
          member: 'confirm',
          message: 'VS Code would not show the confirmation dialog.',
          cause,
        }),
    }).pipe(Effect.map((selected) => selected?.title === confirmLabel));
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

  private showMessage<T extends string>(
    member: 'info' | 'warning' | 'error',
    message: string,
    options: PromptMessageOptions<T>,
    show: (
      message: string,
      options: vscode.MessageOptions,
      ...items: vscode.MessageItem[]
    ) => Thenable<vscode.MessageItem | undefined>,
  ): Effect.Effect<T | undefined, PromptFailed> {
    return Effect.tryPromise({
      try: async () =>
        show(
          message,
          { detail: options.detail, modal: options.modal },
          ...this.toVscodeItems(options.items),
        ),
      catch: (cause) =>
        new PromptFailed({
          reason: 'presentation-failed',
          member,
          message: `VS Code would not show the ${member} message.`,
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
