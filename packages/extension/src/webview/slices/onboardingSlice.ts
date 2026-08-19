/**
 * Onboarding slice: API-key setup, getting-started actions, and the
 * welcome-card onboarding funnel commands.
 */

import * as vscode from 'vscode';

import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import { GETTING_STARTED_COMMANDS } from '@shared/schemas';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewInboundHandlerRegistry } from '@shared/schemas';
import {
  setFirstRunDone,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';
import { getProviderKeyUrl } from '@utils/config/providerConfig';

import type { MainViewInboundHost } from '../mainViewInboundContext';

export function createOnboardingHandlers(host: MainViewInboundHost) {
  return {
    [MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY]: async () => {
      await safeExecuteCommand('texra.setApiKey');
      // SecretManager has no key-changed event, so the set-key flow's
      // completion is the explicit refresh point for the onboarding
      // funnel (welcome card → API-key entry → State 1).
      await host.refreshOnboardingFunnel?.();
    },
    [MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY]: (m) => {
      if (!m.provider) return;
      return safeExecuteCommand('texra.setApiKey', [m.provider], host.viewName);
    },
    [MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL]: async (m) => {
      const url = m.provider ? getProviderKeyUrl(m.provider) : undefined;
      if (url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    },
    [MAIN_VIEW_COMMANDS.OPEN_API_KEY_GUIDE]: async () => {
      await vscode.env.openExternal(
        vscode.Uri.parse(
          'https://texra.ai/guide/installation#setting-up-api-keys',
        ),
      );
    },

    [MAIN_VIEW_COMMANDS.GETTING_STARTED_ACTION]: async (m) => {
      await safeExecuteCommand(
        GETTING_STARTED_COMMANDS[m.action],
        [],
        host.viewName,
      );
      // runSetup changes the onboarding funnel inputs, so re-derive the
      // card state once the setup assistant returns.
      if (m.action === 'runSetup') {
        await host.refreshOnboardingFunnel?.();
      }
    },
    [MAIN_VIEW_COMMANDS.ONBOARDING_SKIP]: async () => {
      // Persist the user-scoped declined flag (same flag the CLI picker
      // writes), then re-derive so the card disappears and the normal
      // launcher renders.
      await setOnboardingDeclined(host.context.globalState, true);
      await host.refreshOnboardingFunnel?.();
    },
    [MAIN_VIEW_COMMANDS.ONBOARDING_SIGN_IN_CHATGPT]: async () => {
      await signInWithSubscription(host.channel, 'chatgpt');
      await host.refreshAfterCredentialChange();
    },
    [MAIN_VIEW_COMMANDS.ONBOARDING_RUN_SETUP]: async () => {
      await safeExecuteCommand(
        GETTING_STARTED_COMMANDS.runSetup,
        [],
        host.viewName,
      );
      await host.refreshOnboardingFunnel?.();
    },
    [MAIN_VIEW_COMMANDS.ONBOARDING_OPEN_GETTING_STARTED]: () =>
      safeExecuteCommand(
        GETTING_STARTED_COMMANDS.openWalkthrough,
        [],
        host.viewName,
      ),
    [MAIN_VIEW_COMMANDS.ONBOARDING_SKIP_SETUP]: async () => {
      await setFirstRunDone(host.context.globalState, true);
      await host.refreshOnboardingFunnel?.();
    },
  } satisfies Partial<MainViewInboundHandlerRegistry>;
}
