import { getCodexStatus } from '@auth/codex';
import { getXaiStatus, xaiAccountLabel } from '@auth/xai';
import { codexAccountLabel } from '@auth/codex/codexSessionTypes';
import { apiKeyExists, configuredApiKeyProviders } from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import {
  isPreferCodexSubscription,
  setPreferCodexSubscription,
} from '@model/codex/codexPreference';
import {
  isPreferXaiSubscription,
  setPreferXaiSubscription,
} from '@model/xai/xaiPreference';
import { platform } from '@platform/platform';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import { INCLUDED_ACCESS } from '@shared/copy/modelAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { ApiAccessMode } from '@shared/schemas/settingsViewMessages';
import {
  getGLMCodingPlan,
  getPreferKimiCode,
  setGLMCodingPlan,
} from '@utils/config/providerConfig';

import { signInCliChatGpt } from './chatgptLogin';
import { signInCliGrok } from './grokLogin';
import { setKimiCodePreference } from './kimiCodePreference';
import { shouldUseSubscriptionDeviceCode } from './subscriptionLogin';
import {
  effectiveCliApiMode,
  getCliApiMode,
  setCliApiMode,
} from './apiAccessMode';
import {
  formatCliModelAccessRouteInline,
  type CliModelAccessSelection,
  type CliModelAccessStatus,
} from './modelAccessRoute';
import type { CliContext } from './cliContext';

export interface CliModelAccessSelectionResult {
  /** API fallback retained beneath subscription-based access. */
  readonly apiMode: ApiAccessMode;
  readonly message: string;
}

/** Apply a launcher access choice to the context used by the selected session. */
export function contextForCliModelAccess(
  context: CliContext,
  apiMode: ApiAccessMode | undefined,
): CliContext {
  return apiMode ? { ...context, apiMode } : context;
}

export async function readCliModelAccessStatus(
  apiMode: ApiAccessMode,
): Promise<CliModelAccessStatus> {
  const secrets = platform().secrets;
  const [chatGpt, grok, kimiCodeKeySet, glmKeySet, configuredProviders] =
    await Promise.all([
      getCodexStatus(),
      getXaiStatus(),
      apiKeyExists(secrets, 'kimiCode'),
      apiKeyExists(secrets, 'glm'),
      configuredApiKeyProviders(secrets),
    ]);
  const preferences = {
    chatGpt: isPreferCodexSubscription() ? 'on' : 'off',
    grok: isPreferXaiSubscription() ? 'on' : 'off',
    kimiCode: getPreferKimiCode() ? 'on' : 'off',
    glmCode: getGLMCodingPlan() ? 'on' : 'off',
  } as const;
  const personalKeyProviders = configuredProviders.map(
    (provider) => PROVIDER_DISPLAY_NAMES[provider] ?? provider,
  );
  return {
    apiFallback: apiMode,
    preferences,
    chatGptSignedIn: chatGpt.signedIn,
    chatGptAccountLabel: chatGpt.email ?? chatGpt.accountId,
    grokSignedIn: grok.signedIn,
    grokAccountLabel: grok.email,
    kimiCodeKeySet,
    glmKeySet,
    personalKeyProviders,
  };
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
    const update = await setCliApiMode(selection.apiMode);
    const openRouterNotice = update.openRouterDisabled
      ? ` OpenRouter has been turned off (not compatible with ${INCLUDED_ACCESS.inline}).`
      : '';
    return {
      apiMode: selection.apiMode,
      message: `Now using ${formatCliModelAccessRouteInline(selection.apiMode)}.${openRouterNotice}`,
    };
  }

  const apiMode = context ? effectiveCliApiMode(context) : getCliApiMode();
  if (selection.provider === 'kimi-code') {
    if (selection.state === 'off') {
      await setKimiCodePreference(false);
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
    await setKimiCodePreference(true);
    invalidateModelOptionsCache();
    return {
      apiMode,
      message: `Prefer Kimi Code subscription enabled for Kimi models · other models still use ${formatCliModelAccessRouteInline(apiMode)}.`,
    };
  }

  if (selection.provider === 'glm-code') {
    if (selection.state === 'off') {
      await setGLMCodingPlan(false);
      invalidateModelOptionsCache();
      return {
        apiMode,
        message: 'Prefer GLM Coding Plan disabled for GLM models.',
      };
    }

    // The GLM API key is the Coding Plan credential — there is no separate
    // sign-in flow.
    if (!(await apiKeyExists(platform().secrets, 'glm'))) {
      return {
        apiMode,
        message:
          'No GLM API key configured — add one with /key or /config → API keys (get one at https://open.bigmodel.cn or https://z.ai).',
      };
    }
    await setGLMCodingPlan(true);
    invalidateModelOptionsCache();
    return {
      apiMode,
      message: `Prefer GLM Coding Plan enabled for GLM models · other models still use ${formatCliModelAccessRouteInline(apiMode)}.`,
    };
  }

  if (selection.provider === 'grok') {
    if (selection.state === 'off') {
      const update = await setPreferXaiSubscription(false);
      invalidateModelOptionsCache();
      return {
        apiMode,
        message: update.effective
          ? `Grok subscription preference remains enabled because a more specific setting overrides ${update.target} config.`
          : 'Prefer Grok subscription disabled for xAI models.',
      };
    }

    const status = await getXaiStatus();
    let accountLabel = xaiAccountLabel(status);
    if (!status.signedIn) {
      const init = { device: false, noBrowser: false };
      const device =
        context != null && shouldUseSubscriptionDeviceCode(context, init);
      const session = await signInCliGrok({ ...init, device }, options);
      accountLabel = xaiAccountLabel(session);
    }

    const update = await setPreferXaiSubscription(true);
    await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
    invalidateModelOptionsCache();
    return {
      apiMode,
      message: update.effective
        ? `Prefer Grok subscription enabled for xAI models (${accountLabel}).`
        : 'Grok sign-in succeeded, but a more specific setting keeps subscription access disabled.',
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
  let accountLabel = codexAccountLabel(status);
  if (!status.signedIn) {
    const init = { device: false, noBrowser: false };
    const device =
      context != null && shouldUseSubscriptionDeviceCode(context, init);
    const session = await signInCliChatGpt({ ...init, device }, options);
    accountLabel = codexAccountLabel(session);
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
