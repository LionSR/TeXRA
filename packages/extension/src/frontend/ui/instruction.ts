// Third-party imports
import { Effect } from 'effect';

// Local imports
import { askUnlessSilenced } from '@texra/controllers/session/windowNotices';
import { askNotice } from '@frontend/hosts/VscodeUiHost';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { vscodeEditorIntegration } from '@frontend/vscodeEditorIntegration';
import type { StateStore } from '@texra-ai/harness/host';

const INSTALL = 'Install';

/**
 * Prompt the user to install a VS Code extension, with a suppressible
 * "Never remind again" option. Fires the install command on confirm and
 * reports a refused install once, on the caller's log channel.
 */
export const promptExtensionInstall = Effect.fn('promptExtensionInstall')(
  function* (
    store: StateStore,
    opts: {
      suppressKey: string;
      message: string;
      extensionId: string;
    },
  ) {
    const choice = yield* askUnlessSilenced(
      askNotice,
      store,
      opts.suppressKey,
      opts.message,
      [INSTALL],
    );
    if (choice !== INSTALL) return;
    yield* vscodeEditorIntegration
      .install(opts.extensionId)
      .pipe(
        Effect.catch((err) =>
          showLoggedErrorMessage(
            `Error installing extension ${opts.extensionId}`,
            err,
          ).pipe(Effect.asVoid),
        ),
      );
  },
);
