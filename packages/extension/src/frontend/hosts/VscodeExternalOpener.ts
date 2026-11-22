// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import {
  externalOpenFailed,
  type HostFailed,
  type ExternalOpener,
} from '@texra/hosts/uiHosts';
import { texraGuideUrl } from '@ui/copy/guide';

/**
 * VS Code's browser hand-off behind the host-neutral {@link ExternalOpener}.
 * `env.openExternal` is the foreign API this port adapts; it has no
 * cancellation channel, so an interrupted fiber detaches from the wait. It
 * holds no state, so every surface shares this one value.
 */
export const vscodeOpener: ExternalOpener = Object.freeze({
  openExternal(url: string): Effect.Effect<void, HostFailed> {
    return Effect.tryPromise({
      try: () => vscode.env.openExternal(vscode.Uri.parse(url)),
      catch: (cause) =>
        externalOpenFailed(
          url,
          'openExternal',
          'VS Code could not open the link.',
          cause,
        ),
    }).pipe(
      // openExternal resolves `false` — does not throw — when VS Code
      // declines the URI, its documented path for an unhandled scheme. That
      // refusal is the same failure as a rejection, so it reaches the caller
      // as HostFailed too, not as a successful open.
      Effect.filterOrFail(
        (opened) => opened,
        () =>
          // The refusal is the answer itself; there is no underlying fault.
          externalOpenFailed(
            url,
            'openExternal',
            'No application is registered to handle this link.',
            undefined,
          ),
      ),
      Effect.asVoid,
    );
  },
});

/** A page of the TeXRA guide on texra.ai, in the default browser: what
 *  every docs button in this host opens. */
export function openGuidePage(page: string): Effect.Effect<void, HostFailed> {
  return vscodeOpener.openExternal(texraGuideUrl(page));
}
