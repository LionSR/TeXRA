import { getCodexStatus } from '@auth/codex';
import { getXaiStatus, xaiAccountLabel } from '@auth/xai';
import { codexAccountLabel } from '@auth/codex/codexSessionTypes';
import {
  configuredApiKeyProviders,
  hasUsableApiKey,
} from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import {
  codingPlanSubscriptionRuntimes,
  type CodingPlanSubscriptionRuntime,
} from '@model/codingPlanSubscriptions';
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
import { GlobalStateKey } from '@shared/state/stateKeys';

import { signInCliChatGpt } from './chatgptLogin';
import { signInCliGrok } from './grokLogin';
import {
  shouldUseSubscriptionDeviceCode,
  type CliSubscriptionLoginOptions,
  type CliSubscriptionLoginTransportInit,
} from './subscriptionLogin';
import {
  formatCliModelAccessRouteInline,
  type CliModelAccessSelection,
  type CliModelAccessStatus,
} from './modelAccessRoute';
import type { CliContext } from './cliContext';

export interface CliModelAccessSelectionResult {
  readonly message: string;
}

export async function readCliModelAccessStatus(): Promise<CliModelAccessStatus> {
  const secrets = platform().secrets;
  const [chatGpt, grok, configuredProviders, codingPlanEntries] =
    await Promise.all([
      getCodexStatus(),
      getXaiStatus(),
      configuredApiKeyProviders(secrets),
      Promise.all(
        codingPlanSubscriptionRuntimes.map(
          async (runtime) =>
            [
              runtime.descriptor.id,
              {
                preferred: runtime.getEnabled(),
                keySet: await hasUsableApiKey(
                  secrets,
                  runtime.descriptor.apiProvider,
                ),
              },
            ] as const,
        ),
      ),
    ]);
  const codingPlans = Object.fromEntries(
    codingPlanEntries,
  ) as CliModelAccessStatus['codingPlans'];
  const preferences = {
    chatGpt: isPreferCodexSubscription() ? 'on' : 'off',
    grok: isPreferXaiSubscription() ? 'on' : 'off',
  } as const;
  const personalKeyProviders = configuredProviders.map((provider) =>
    providerDisplayName(provider),
  );
  return {
    preferences,
    chatGptSignedIn: chatGpt.signedIn,
    chatGptAccountLabel: chatGpt.email ?? chatGpt.accountId,
    grokSignedIn: grok.signedIn,
    grokAccountLabel: grok.email,
    codingPlans,
    personalKeyProviders,
  };
}

// ---------------------------------------------------------------------------
// Provider adapters. The four subscription arms share two skeletons — an OAuth
// sign-in flow (Grok/ChatGPT) and a key-credential gate (Kimi Code/GLM) — so a
// fifth provider is one adapter plus a dispatch case, not another 30-line copy.
// ---------------------------------------------------------------------------

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

/** Toggle an OAuth-subscription preference (Grok/ChatGPT) with sign-in. */
async function updateSubscriptionCliModelAccess(
  context: CliContext | undefined,
  selection: CliModelAccessSelection,
  adapter: SubscriptionAccessAdapter,
  options: CliSubscriptionLoginOptions,
): Promise<CliModelAccessSelectionResult> {
  if (selection.state === 'off') {
    const update = await adapter.setPreference(false);
    invalidateModelOptionsCache();
    return {
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
    message: update.effective
      ? `Prefer ${adapter.displayName} subscription enabled for ${adapter.disabledFor} (${accountLabel}).`
      : `${adapter.displayName} sign-in succeeded, but a more specific setting keeps subscription access disabled.`,
  };
}

/** Toggle a key-credential subscription preference (Kimi Code/GLM). */
async function updateKeyedCliModelAccess(
  selection: CliModelAccessSelection,
  runtime: CodingPlanSubscriptionRuntime,
): Promise<CliModelAccessSelectionResult> {
  const plan = runtime.descriptor;
  if (selection.state === 'off') {
    await runtime.setEnabled(false);
    invalidateModelOptionsCache();
    return {
      message: `${plan.preferenceLabel} disabled for ${plan.modelFamily}.`,
    };
  }

  // The provider API key is the subscription credential — there is no
  // separate sign-in flow.
  if (!(await hasUsableApiKey(platform().secrets, plan.apiProvider))) {
    return {
      message: `No ${plan.credentialName} API key configured — add one with /key or /config → API keys (get one at ${plan.credentialSetupUrl}).`,
    };
  }
  await runtime.setEnabled(true);
  invalidateModelOptionsCache();
  return {
    message: `${plan.preferenceLabel} enabled for ${plan.modelFamily} · other models still use ${formatCliModelAccessRouteInline('personal')}.`,
  };
}

/** Apply one declarative preference transition. */
export async function updateCliModelAccess(
  context: CliContext | undefined,
  selection: CliModelAccessSelection,
  options: {
    readonly writeProgress: (message: string) => void;
    readonly signal?: AbortSignal;
  } = { writeProgress: () => undefined },
): Promise<CliModelAccessSelectionResult> {
  const codingPlan = codingPlanSubscriptionRuntimes.find(
    (runtime) => runtime.descriptor.cliProvider === selection.provider,
  );
  if (codingPlan) {
    return updateKeyedCliModelAccess(selection, codingPlan);
  }
  if (selection.provider === 'grok') {
    return updateSubscriptionCliModelAccess(
      context,
      selection,
      GROK_ADAPTER,
      options,
    );
  }
  if (selection.provider === 'chatgpt') {
    return updateSubscriptionCliModelAccess(
      context,
      selection,
      CHATGPT_ADAPTER,
      options,
    );
  }
  throw new Error(
    `Coding-plan provider is missing from the runtime catalog: ${selection.provider}`,
  );
}
