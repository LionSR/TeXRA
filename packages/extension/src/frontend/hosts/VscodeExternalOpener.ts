// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { ExternalOpenFailed, type ExternalOpener } from '@hosts/uiHosts';

/**
 * VS Code's browser hand-off behind the host-neutral {@link ExternalOpener}.
 * `env.openExternal` is the foreign API this port adapts; it has no
 * cancellation channel, so an interrupted fiber detaches from the wait.
 */
export class VscodeExternalOpener implements ExternalOpener {
  openExternal(url: string): Effect.Effect<void, ExternalOpenFailed> {
    return Effect.tryPromise({
      try: async () => {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      },
      catch: (cause) =>
        new ExternalOpenFailed({
          kind: 'url',
          target: url,
          message: 'VS Code would not open the URL in the default browser.',
          cause,
        }),
    });
  }
}
