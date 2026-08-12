import { getCodexStatus } from '@auth/codex';
import { getXaiStatus, xaiAccountLabel } from '@auth/xai';
import { codexAccountLabel } from '@auth/codex/codexSessionTypes';
import { apiKeyExists, configuredApiKeyProviders } from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import type { SubscriptionPreferenceUpdate } from '@model/subscriptionPreference';
import {
  isPreferCodexSubscription,
  setPreferCodexSubscription,
} from '@model/codex/codexPreference';
import {
  isPreferXaiSubscription,
  setPreferXaiSubscription,
} from '@model/xai/xaiPreference';
import { platform } from '@platform/platform';
import { providerDisplayName } from '@shared/constants/providers';
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
import {
  shouldUseSubscriptionDeviceCode,
  type CliSubscriptionLoginOptions,
  type CliSubscriptionLoginTransportInit,
} from './subscriptionLogin';
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
    (provider) => providerDisplayName(provider),
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

// ---------------------------------------------------------------------------
// Provider adapters. The four subscription arms share two skeletons — an OAuth
// sign-in flow (Grok/ChatGPT) and a key-credential gate (Kimi Code/GLM) — so a
// fifth provider is one adapter plus a dispatch case, not another 30-line copy.
// ---------------------------------------------------------------------------

type CliSubscriptionSelection = Extract<
  CliModelAccessSelection,
  { readonly kind: 'subscription-preference' }
>;

interface SubscriptionAccessAdapter {
  readonly displayName: string;
  readonly disabledFor: string;
  readonly getStatus: () => Promise<{
    readonly signedIn: boolean;
    readonly email?: string | null;
    readonly accountId?: string | null;
  }>;
  readonly accountLabelOf: (
    account:
      | { readonly email?: string | null; readonly accountId?: string | null }
      | null
      | undefined,
  ) => string;
  readonly signIn: (
    init: CliSubscriptionLoginTransportInit,
    options: CliSubscriptionLoginOptions,
  ) => Promise<{
    readonly email?: string | null;
    readonly accountId?: string | null;
  }>;
  readonly setPreference: (
    enabled: boolean,
  ) => Promise<SubscriptionPreferenceUpdate>;
}

const GROK_ADAPTER: SubscriptionAccessAdapter = {
  displayName: 'Grok',
  disabledFor: 'xAI models',
  getStatus: getXaiStatus,
  accountLabelOf: xaiAccountLabel,
  signIn: signInCliGrok,
  setPreference: setPreferXaiSubscription,
};

const CHATGPT_ADAPTER: SubscriptionAccessAdapter = {
  displayName: 'ChatGPT',
  disabledFor: 'Codex models',
  getStatus: getCodexStatus,
  accountLabelOf: codexAccountLabel,
  signIn: signInCliChatGpt,
  setPreference: setPreferCodexSubscription,
};

interface KeyedSubscriptionAdapter {
  readonly keyName: string;
  readonly missingKeyHint: string;
  readonly disabledMessage: string;
  readonly enabledMessage: (apiMode: ApiAccessMode) => string;
  readonly setPreference: (enabled: boolean) => Promise<unknown>;
}

const KIMI_CODE_ADAPTER: KeyedSubscriptionAdapter = {
  keyName: 'kimiCode',
  missingKeyHint:
    'No Kimi Code API key configured — add one with /key or /config → API keys (get one at https://www.kimi.com/code/console).',
  disabledMessage: 'Prefer Kimi Code subscription disabled for Kimi models.',
  enabledMessage: (apiMode) =>
    `Prefer Kimi Code subscription enabled for Kimi models · other models still use ${formatCliModelAccessRouteInline(apiMode)}.`,
  setPreference: setKimiCodePreference,
};

const GLM_CODE_ADAPTER: KeyedSubscriptionAdapter = {
  keyName: 'glm',
  missingKeyHint:
    'No GLM API key configured — add one with /key or /config → API keys (get one at https://open.bigmodel.cn or https://z.ai).',
  disabledMessage: 'Prefer GLM Coding Plan disabled for GLM models.',
  enabledMessage: (apiMode) =>
    `Prefer GLM Coding Plan enabled for GLM models · other models still use ${formatCliModelAccessRouteInline(apiMode)}.`,
  setPreference: setGLMCodingPlan,
};

/** Toggle an OAuth-subscription preference (Grok/ChatGPT) with sign-in. */
async function updateSubscriptionCliModelAccess(
  context: CliContext | undefined,
  apiMode: ApiAccessMode,
  selection: CliSubscriptionSelection,
  adapter: SubscriptionAccessAdapter,
  options: CliSubscriptionLoginOptions,
): Promise<CliModelAccessSelectionResult> {
  if (selection.state === 'off') {
    const update = await adapter.setPreference(false);
    invalidateModelOptionsCache();
    return {
      apiMode,
      message: update.effective
        ? `${adapter.displayName} subscription preference remains enabled because a more specific setting overrides ${update.target} config.`
        : `Prefer ${adapter.displayName} subscription disabled for ${adapter.disabledFor}.`,
    };
  }

  const status = await adapter.getStatus();
  let accountLabel = adapter.accountLabelOf(status);
  if (!status.signedIn) {
    const init = { device: false, noBrowser: false };
    const device =
      context != null && shouldUseSubscriptionDeviceCode(context, init);
    const session = await adapter.signIn({ ...init, device }, options);
    accountLabel = adapter.accountLabelOf(session);
  }

  const update = await adapter.setPreference(true);
  await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
  invalidateModelOptionsCache();
  return {
    apiMode,
    message: update.effective
      ? `Prefer ${adapter.displayName} subscription enabled for ${adapter.disabledFor} (${accountLabel}).`
      : `${adapter.displayName} sign-in succeeded, but a more specific setting keeps subscription access disabled.`,
  };
}

/** Toggle a key-credential subscription preference (Kimi Code/GLM). */
async function updateKeyedCliModelAccess(
  apiMode: ApiAccessMode,
  selection: CliSubscriptionSelection,
  adapter: KeyedSubscriptionAdapter,
): Promise<CliModelAccessSelectionResult> {
  if (selection.state === 'off') {
    await adapter.setPreference(false);
    invalidateModelOptionsCache();
    return { apiMode, message: adapter.disabledMessage };
  }

  // The provider API key is the subscription credential — there is no
  // separate sign-in flow.
  if (!(await apiKeyExists(platform().secrets, adapter.keyName))) {
    return { apiMode, message: adapter.missingKeyHint };
  }
  await adapter.setPreference(true);
  invalidateModelOptionsCache();
  return { apiMode, message: adapter.enabledMessage(apiMode) };
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
  switch (selection.provider) {
    case 'kimi-code':
      return updateKeyedCliModelAccess(apiMode, selection, KIMI_CODE_ADAPTER);
    case 'glm-code':
      return updateKeyedCliModelAccess(apiMode, selection, GLM_CODE_ADAPTER);
    case 'grok':
      return updateSubscriptionCliModelAccess(
        context,
        apiMode,
        selection,
        GROK_ADAPTER,
        options,
      );
    case 'chatgpt':
      return updateSubscriptionCliModelAccess(
        context,
        apiMode,
        selection,
        CHATGPT_ADAPTER,
        options,
      );
  }
}
