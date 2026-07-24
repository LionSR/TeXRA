import {
  getChatGptAuthStatus,
  getCodexStatus,
  isPreferCodexSubscription,
  setPreferCodexSubscription,
} from '@auth/codex';
import { PERSONAL_API_KEY_PROVIDERS, apiKeyExists } from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { platform } from '@platform/platform';
import { ModelAccessStatusSchema } from '@shared/schemas/modelAccess';
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
  const [chatGpt, kimiCodeKeySet, personalApiKeyStates] = await Promise.all([
    getChatGptAuthStatus(),
    apiKeyExists(platform().secrets, 'kimiCode'),
    Promise.all(
      PERSONAL_API_KEY_PROVIDERS.map((provider) =>
        apiKeyExists(platform().secrets, provider),
      ),
    ),
  ]);
  return ModelAccessStatusSchema.parse({
    apiMode,
    chatGpt,
    kimiCode: {
      keySet: kimiCodeKeySet,
      preferred: getPreferKimiCode(),
    },
    personalApiKeySet: personalApiKeyStates.some(Boolean),
  });
}

/** Select the fallback used outside preferred subscription model families. */
export async function selectCliApiModelAccessRoute(
  route: CliApiMode,
): Promise<CliModelAccessSelectionResult> {
  await setCliApiMode(route);
  return {
    apiMode: route,
    message: `API fallback: ${formatCliModelAccessRoute(route)}.`,
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
    if (getPreferKimiCode()) {
      await setPreferKimiCode(false);
      invalidateModelOptionsCache();
      return {
        apiMode: effectiveCliApiMode(context),
        message: 'Kimi Code subscription preference: Off.',
      };
    }
    // The Kimi Code API key is the subscription credential — there is no
    // separate sign-in flow.
    if (!(await apiKeyExists(platform().secrets, 'kimiCode'))) {
      return {
        apiMode: effectiveCliApiMode(context),
        message:
          'No Kimi Code API key configured — add one with /key or /config → API keys (get one at https://www.kimi.com/code/console).',
      };
    }
    await setPreferKimiCode(true);
    // Dual-backend Kimi routing requires the OpenRouter toggle off.
    await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
    invalidateModelOptionsCache();
    const apiMode = effectiveCliApiMode(context);
    return {
      apiMode,
      message: `Kimi Code subscription preference: On for Kimi models · fallback: ${formatCliModelAccessRoute(apiMode)}.`,
    };
  }

  const status = await getCodexStatus();
  if (status.signedIn && isPreferCodexSubscription()) {
    const update = await setPreferCodexSubscription(false);
    invalidateModelOptionsCache();
    return {
      apiMode: effectiveCliApiMode(context),
      message: update.effective
        ? `ChatGPT subscription remains preferred because a more specific setting overrides ${update.target} config.`
        : 'ChatGPT subscription preference: Off.',
    };
  }

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
  invalidateModelOptionsCache();
  return {
    apiMode: effectiveCliApiMode(context),
    message: update.effective
      ? `ChatGPT subscription preference: On for Codex models (${accountLabel}).`
      : 'ChatGPT sign-in succeeded, but a more specific setting keeps subscription access disabled.',
  };
}
