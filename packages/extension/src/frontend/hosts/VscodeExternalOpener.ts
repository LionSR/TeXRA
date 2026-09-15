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
      try: () => vscode.env.openExternal(vscode.Uri.parse(url)),
      catch: (cause) =>
        new ExternalOpenFailed({
          kind: 'url',
          target: url,
          message: 'VS Code would not open the URL in the default browser.',
          cause,
        }),
    }).pipe(
      // openExternal resolves `false` — does not throw — when VS Code
      // declines the URI, its documented path for an unhandled scheme. That
      // refusal is the same failure as a rejection, so it reaches the caller
      // as ExternalOpenFailed too, not as a successful open.
      Effect.filterOrFail(
        (opened) => opened,
        () =>
          new ExternalOpenFailed({
            kind: 'url',
            target: url,
            message: 'VS Code declined to open the URL: no handler took it.',
            // The refusal is the answer itself; there is no underlying fault.
            cause: undefined,
          }),
      ),
      Effect.asVoid,
    );
  }
}
