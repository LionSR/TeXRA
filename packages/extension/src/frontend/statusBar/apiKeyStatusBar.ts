// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { hasAnyUsableSetupCredential } from '@commands/setup/setupAssistantCommand';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';

/**
 * Paint the setup pill from the credential store.
 *
 * A program rather than an `async` function, and here rather than in
 * `extension.ts`: the credential read it consults is already an Effect, and
 * the host entry holds raw `catch` clauses that keep it out of the migration
 * ratchet's runtime-import row, so the one place that may name `Effect` is a
 * module of its own.
 *
 * The predicate is the setup assistant's and the onboarding funnel's, so a
 * ChatGPT subscription and a direct API key agree about whether the first-run
 * call to action should remain visible. Account sign-in is deliberately not in
 * that set: it serves the remote-agent catalog, not model access.
 */
export const refreshApiKeyStatusBar = Effect.fn('refreshApiKeyStatusBar')(
  function* (
    stores: SettingsStores,
    secrets: PlatformSecrets,
    /** The setup pill: shown only while no usable credential exists. */
    setup: vscode.StatusBarItem | undefined,
  ) {
    if (!setup) return;

    if (yield* hasAnyUsableSetupCredential(stores, secrets)) {
      setup.hide();
      return;
    }

    setup.text = '$(rocket) TeXRA: Get Started';
    setup.tooltip =
      'Connect a model: sign in with ChatGPT or add a provider API key';
    // The welcome card in the TeXRA panel is the one home for that choice.
    setup.command = 'texra.showMainView';
    setup.accessibilityInformation = { label: 'TeXRA setup, get started' };
    setup.show();
  },
);
