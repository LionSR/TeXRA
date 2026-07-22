import {
  getCodexStatus,
  isPreferCodexSubscription,
  setPreferCodexSubscription,
} from '@auth/codex';
import { apiKeyExists } from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { platform } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  getPreferKimiCode,
  setPreferKimiCode,
} from '@utils/config/providerConfig';

import {
  chatGptAccountLabel,
  shouldUseChatGptDeviceCode,
  signInCliChatGpt,
} from './chatgptLogin';
import {
  effectiveCliApiMode,
  setCliApiMode,
  type CliApiMode,
} from './apiAccessMode';
import {
  formatCliModelAccessRoute,
  type CliModelAccessRoute,
  type CliModelAccessStatus,
} from './modelAccessRoute';
import type { CliContext } from './cliContext';

export interface CliModelAccessSelectionResult {
  /** API fallback retained beneath subscription-based access. */
  readonly apiMode: CliApiMode;
  readonly message: string;
}

/** Apply a launcher access choice to the context used by the selected session. */
export function contextForCliModelAccess(
  context: CliContext,
  apiMode: CliApiMode | undefined,
): CliContext {
  return apiMode ? { ...context, apiMode } : context;
}

export async function readCliModelAccessStatus(
  apiMode: CliApiMode,
): Promise<CliModelAccessStatus> {
  const [chatGpt, kimiCodeKeySet] = await Promise.all([
    getCodexStatus(),
    apiKeyExists(platform().secrets, 'kimiCode'),
  ]);
  const chatGptActive = chatGpt.signedIn && isPreferCodexSubscription();
  // The Kimi Code route is a personal-key route: it only describes the active
  // access while the API fallback mode is personal and the prefer switch is on.
  const kimiCodeActive =
    !chatGptActive &&
    apiMode === 'personal' &&
    getPreferKimiCode() &&
    kimiCodeKeySet;
  let active: CliModelAccessStatus['active'] = apiMode;
  if (chatGptActive) active = 'chatgpt';
  else if (kimiCodeActive) active = 'kimi-code';
  return {
    active,
    chatGptSignedIn: chatGpt.signedIn,
    chatGptAccountLabel: chatGpt.email ?? chatGpt.accountId,
    kimiCodeKeySet,
  };
}

/** Select an API-backed route and stop preferring ChatGPT subscription use. */
export async function selectCliApiModelAccessRoute(
  route: CliApiMode,
): Promise<CliModelAccessSelectionResult> {
  const update = await setPreferCodexSubscription(false);
  // An explicit "personal keys" choice leaves the Kimi Code route; the prefer
  // switch stays available under /config → Models and providers.
  if (route === 'personal') await setPreferKimiCode(false);
  await setCliApiMode(route);
  return {
    apiMode: route,
    message: update.effective
      ? `Model access remains on ChatGPT subscription because a more specific setting overrides ${update.target} config.`
      : `Model access: ${formatCliModelAccessRoute(route)}.`,
  };
}

export async function selectCliModelAccessRoute(
  context: CliContext,
  route: CliModelAccessRoute,
  options: {
    readonly writeProgress: (message: string) => void;
    readonly signal?: AbortSignal;
  },
): Promise<CliModelAccessSelectionResult> {
  if (route === 'included' || route === 'personal') {
    return selectCliApiModelAccessRoute(route);
  }

  if (route === 'kimi-code') {
    // The Kimi Code API key is the subscription credential — there is no
    // separate sign-in flow.
    if (!(await apiKeyExists(platform().secrets, 'kimiCode'))) {
      return {
        apiMode: effectiveCliApiMode(context),
        message:
          'No Kimi Code API key configured — add one with /key or /config → API keys (get one at https://www.kimi.com/code/console).',
      };
    }
    await setPreferCodexSubscription(false);
    await setPreferKimiCode(true);
    // Dual-backend Kimi routing requires the OpenRouter toggle off.
    await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
    // Non-Moonshot models fall back to the other personal keys.
    await setCliApiMode('personal');
    invalidateModelOptionsCache();
    return {
      apiMode: 'personal',
      message:
        'Prefer Kimi Code subscription enabled for Kimi models · fallback: personal API keys.',
    };
  }

  const status = await getCodexStatus();
  let accountLabel = status.email ?? status.accountId ?? 'your account';
  if (!status.signedIn) {
    const init = { device: false, noBrowser: false };
    const session = await signInCliChatGpt(
      {
        ...init,
        device: shouldUseChatGptDeviceCode(context, init),
      },
      options,
    );
    accountLabel = chatGptAccountLabel(session);
  }

  const update = await setPreferCodexSubscription(true);
  await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
  invalidateModelOptionsCache();
  return {
    apiMode: effectiveCliApiMode(context),
    message: update.effective
      ? `Prefer ChatGPT subscription enabled for Codex models (${accountLabel}).`
      : 'ChatGPT sign-in succeeded, but a more specific setting keeps subscription access disabled.',
  };
}
