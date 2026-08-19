import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import { hasUsableApiKey } from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import {
  codingPlanSubscriptionRuntimes,
  type CodingPlanSubscriptionRuntime,
} from '@model/codingPlanSubscriptions';
import { platform } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';

import {
  shouldUseSubscriptionDeviceCode,
  signInCliSubscription,
  type CliSubscriptionLoginOptions,
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
  const [chatGpt, grok, codingPlanEntries] = await Promise.all([
    subscriptionProvider('chatgpt').getStatus(),
    subscriptionProvider('grok').getStatus(),
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
    chatGpt: subscriptionProvider('chatgpt').isPreferSubscription()
      ? 'on'
      : 'off',
    grok: subscriptionProvider('grok').isPreferSubscription() ? 'on' : 'off',
  } as const;
  return {
    preferences,
    chatGptSignedIn: chatGpt.signedIn,
    chatGptAccountLabel: chatGpt.email ?? chatGpt.accountId,
    grokSignedIn: grok.signedIn,
    grokAccountLabel: grok.email,
    codingPlans,
  };
}

// ---------------------------------------------------------------------------
// The four subscription arms share two skeletons — an OAuth sign-in flow
// (Grok/ChatGPT, driven by the shared provider catalog) and a key-credential
// gate (Kimi Code/GLM) — so a fifth provider is a catalog row plus a dispatch
// case, not another 30-line copy.
// ---------------------------------------------------------------------------

/** Toggle an OAuth-subscription preference (Grok/ChatGPT) with sign-in. */
async function updateSubscriptionCliModelAccess(
  context: CliContext | undefined,
  selection: CliModelAccessSelection,
  providerId: SubscriptionProviderId,
  options: CliSubscriptionLoginOptions,
): Promise<CliModelAccessSelectionResult> {
  const provider = subscriptionProvider(providerId);
  const { displayName, modelFamily } = provider;
  if (selection.state === 'off') {
    const update = await provider.setPreferSubscription(false);
    invalidateModelOptionsCache();
    return {
      message: update.effective
        ? `${displayName} subscription preference remains enabled because a more specific setting overrides ${update.target} config.`
        : `Prefer ${displayName} subscription disabled for ${modelFamily}.`,
    };
  }

  const status = await provider.getStatus();
  let accountLabel = status.label;
  if (!status.signedIn) {
    const init = { device: false, noBrowser: false };
    const device =
      context != null && shouldUseSubscriptionDeviceCode(context, init);
    const account = await signInCliSubscription(
      providerId,
      { ...init, device },
      options,
    );
    accountLabel = account.label;
  }

  const update = await provider.setPreferSubscription(true);
  await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
  invalidateModelOptionsCache();
  return {
    message: update.effective
      ? `Prefer ${displayName} subscription enabled for ${modelFamily} (${accountLabel}).`
      : `${displayName} sign-in succeeded, but a more specific setting keeps subscription access disabled.`,
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
  if (selection.provider === 'grok' || selection.provider === 'chatgpt') {
    return updateSubscriptionCliModelAccess(
      context,
      selection,
      selection.provider,
      options,
    );
  }
  throw new Error(
    `Coding-plan provider is missing from the runtime catalog: ${selection.provider}`,
  );
}
