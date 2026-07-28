import { getCodexStatus } from '@auth/codex';
import { apiKeyExists } from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import {
  isPreferCodexSubscription,
  setPreferCodexSubscription,
} from '@model/codex/codexPreference';
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
  getCliApiMode,
  setCliApiMode,
  type CliApiMode,
} from './apiAccessMode';
import {
  formatCliModelAccessRoute,
  type CliModelAccessSelection,
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
  const preferences = {
    chatGpt: isPreferCodexSubscription() ? 'on' : 'off',
    kimiCode: getPreferKimiCode() ? 'on' : 'off',
  } as const;
  return {
    apiFallback: apiMode,
    preferences,
    chatGptSignedIn: chatGpt.signedIn,
    chatGptAccountLabel: chatGpt.email ?? chatGpt.accountId,
    kimiCodeKeySet,
  };
}

function selectedApiFallback(context: CliContext | undefined): CliApiMode {
  return context ? effectiveCliApiMode(context) : getCliApiMode();
}

/** Apply one declarative preference or fallback transition. */
export async function updateCliModelAccess(
  context: CliContext | undefined,
  selection: CliModelAccessSelection,
  options: {
    readonly writeProgress: (message: string) => void;
    readonly signal?: AbortSignal;
  } = { writeProgress: () => undefined },
): Promise<CliModelAccessSelectionResult> {
  if (selection.kind === 'api-fallback') {
    await setCliApiMode(selection.apiMode);
    return {
      apiMode: selection.apiMode,
      message: `API fallback: ${formatCliModelAccessRoute(selection.apiMode)}.`,
    };
  }

  const apiMode = selectedApiFallback(context);
  if (selection.provider === 'kimi-code') {
    if (selection.state === 'off') {
      await setPreferKimiCode(false);
      invalidateModelOptionsCache();
      return {
        apiMode,
        message: 'Prefer Kimi Code subscription disabled for Kimi models.',
      };
    }

    // The Kimi Code API key is the subscription credential — there is no
    // separate sign-in flow.
    if (!(await apiKeyExists(platform().secrets, 'kimiCode'))) {
      return {
        apiMode,
        message:
          'No Kimi Code API key configured — add one with /key or /config → API keys (get one at https://www.kimi.com/code/console).',
      };
    }
    await setPreferKimiCode(true);
    // Dual-backend Kimi routing requires the OpenRouter toggle off.
    await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
    invalidateModelOptionsCache();
    return {
      apiMode,
      message: `Prefer Kimi Code subscription enabled for Kimi models · API fallback remains ${formatCliModelAccessRoute(apiMode)}.`,
    };
  }

  if (selection.state === 'off') {
    const update = await setPreferCodexSubscription(false);
    invalidateModelOptionsCache();
    return {
      apiMode,
      message: update.effective
        ? `ChatGPT subscription preference remains enabled because a more specific setting overrides ${update.target} config.`
        : 'Prefer ChatGPT subscription disabled for Codex models.',
    };
  }

  const status = await getCodexStatus();
  let accountLabel = status.email ?? status.accountId ?? 'your account';
  if (!status.signedIn) {
    const init = { device: false, noBrowser: false };
    const session = await signInCliChatGpt(
      {
        ...init,
        device:
          context == null ? false : shouldUseChatGptDeviceCode(context, init),
      },
      options,
    );
    accountLabel = chatGptAccountLabel(session);
  }

  const update = await setPreferCodexSubscription(true);
  await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
  invalidateModelOptionsCache();
  return {
    apiMode,
    message: update.effective
      ? `Prefer ChatGPT subscription enabled for Codex models (${accountLabel}).`
      : 'ChatGPT sign-in succeeded, but a more specific setting keeps subscription access disabled.',
  };
}
