// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { NotificationFailed, type MessageHost } from '@hosts/uiHosts';
import { toErrorMessage } from '@utils/errors/errorMessage';

const SHOW_OF_MEMBER: Record<
  NotificationFailed['member'],
  (message: string) => Thenable<unknown>
> = {
  showInfoMessage: vscode.window.showInformationMessage,
  showWarningMessage: vscode.window.showWarningMessage,
  showErrorMessage: vscode.window.showErrorMessage,
};

/**
 * VS Code's notification surface behind the host-neutral {@link MessageHost}.
 *
 * A toast has no answer, so a user who dismisses it is not a failure; the
 * one failure is VS Code's own message machinery rejecting, which reaches the
 * caller as {@link NotificationFailed} carrying the rejection's own text.
 */
export class VscodeMessageHost implements MessageHost {
  showInfoMessage(message: string) {
    return this.notify('showInfoMessage', message);
  }

  showWarningMessage(message: string) {
    return this.notify('showWarningMessage', message);
  }

  showErrorMessage(message: string) {
    return this.notify('showErrorMessage', message);
  }

  private notify(
    member: NotificationFailed['member'],
    message: string,
  ): Effect.Effect<void, NotificationFailed> {
    return Effect.tryPromise({
      try: async () => {
        await SHOW_OF_MEMBER[member](message);
      },
      catch: (cause) =>
        new NotificationFailed({
          member,
          message: toErrorMessage(cause),
          cause,
        }),
    });
  }
}
