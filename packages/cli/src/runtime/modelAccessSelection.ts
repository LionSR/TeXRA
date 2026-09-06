import { Effect } from 'effect';

import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import { hasUsableApiKey } from '@model/apiProviders';
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
  type CliAccountStatus,
  type CliModelAccessSelection,
  type CliModelAccessStatus,
} from './modelAccessRoute';
import type { CliContext } from './cliContext';
import type { CliAuthProfile } from './supabaseAuth';

interface CliModelAccessSelectionResult {
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

export function mergeCliTexraAccountStatus(
  access: CliModelAccessStatus,
  profile: Pick<CliAuthProfile, 'authenticated' | 'accountLabel'>,
): CliAccountStatus {
  return {
    ...access,
    texraSignedIn: profile.authenticated,
    texraAccountLabel: profile.accountLabel,
  };
}

// ---------------------------------------------------------------------------
// The four subscription arms share two skeletons — an OAuth sign-in flow
// (Grok/ChatGPT, driven by the shared provider catalog) and a key-credential
// gate (Kimi Code/GLM) — so a fifth provider is a catalog row plus a dispatch
// case, not another 30-line copy.
// ---------------------------------------------------------------------------

/** A Promise step of the preference machinery, failing with what it threw. */
const step = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: async () => run(),
    catch: (error: unknown) => error,
  });

/** Toggle an OAuth-subscription preference (Grok/ChatGPT) with sign-in. */
const updateSubscriptionCliModelAccess = Effect.fn(
  'modelAccessSelection.updateSubscriptionCliModelAccess',
)(function* (
  context: CliContext | undefined,
  selection: CliModelAccessSelection,
  providerId: SubscriptionProviderId,
  options: CliSubscriptionLoginOptions,
) {
  const provider = subscriptionProvider(providerId);
  const { displayName, modelFamily } = provider;
  if (selection.state === 'off') {
    const update = yield* step(() => provider.setPreferSubscription(false));
    return {
      message: update.effective
        ? `${displayName} subscription preference remains enabled because a more specific setting overrides ${update.target} config.`
        : `Prefer ${displayName} subscription disabled for ${modelFamily}.`,
    } satisfies CliModelAccessSelectionResult;
  }

  const status = yield* step(() => provider.getStatus());
  let accountLabel = status.label;
  if (!status.signedIn) {
    const init = { device: false, noBrowser: false };
    const device =
      context != null && shouldUseSubscriptionDeviceCode(context, init);
    const account = yield* signInCliSubscription(
      providerId,
      { ...init, device },
      options,
    );
    accountLabel = account.label;
  }

  const update = yield* step(() => provider.setPreferSubscription(true));
  yield* step(() =>
    platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false),
  );
  return {
    message: update.effective
      ? `Prefer ${displayName} subscription enabled for ${modelFamily} (${accountLabel}).`
      : `${displayName} sign-in succeeded, but a more specific setting keeps subscription access disabled.`,
  } satisfies CliModelAccessSelectionResult;
});

/** Toggle a key-credential subscription preference (Kimi Code/GLM). */
async function updateKeyedCliModelAccess(
  selection: CliModelAccessSelection,
  runtime: CodingPlanSubscriptionRuntime,
): Promise<CliModelAccessSelectionResult> {
  const plan = runtime.descriptor;
  if (selection.state === 'off') {
    await runtime.setEnabled(false);
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
  return {
    message: `${plan.preferenceLabel} enabled for ${plan.modelFamily} · other models still use ${formatCliModelAccessRouteInline('personal')}.`,
  };
}

/**
 * Apply one declarative preference transition. A program: the command action
 * or slash handler runs it, where its cancellation signal (if any) becomes
 * fiber interruption of a sign-in in flight.
 */
export const updateCliModelAccess = Effect.fn(
  'modelAccessSelection.updateCliModelAccess',
)(function* (
  context: CliContext | undefined,
  selection: CliModelAccessSelection,
  options: CliSubscriptionLoginOptions = { writeProgress: () => undefined },
) {
  const codingPlan = codingPlanSubscriptionRuntimes.find(
    (runtime) => runtime.descriptor.cliProvider === selection.provider,
  );
  if (codingPlan) {
    return yield* step(() => updateKeyedCliModelAccess(selection, codingPlan));
  }
  if (selection.provider === 'grok' || selection.provider === 'chatgpt') {
    return yield* updateSubscriptionCliModelAccess(
      context,
      selection,
      selection.provider,
      options,
    );
  }
  return yield* Effect.die(
    new Error(
      `Coding-plan provider is missing from the runtime catalog: ${selection.provider}`,
    ),
  );
});
