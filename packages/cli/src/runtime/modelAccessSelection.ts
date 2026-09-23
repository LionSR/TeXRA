import { Data, Effect } from 'effect';

import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import { hasUsableApiKey } from '@model/apiProviders';
import {
  codingPlanSubscriptionRuntimes,
  type CodingPlanSubscriptionRuntime,
} from '@model/codingPlanSubscriptions';
import { AppState, StateWriteFailed } from '@platform/interfaces';
import { Secrets, type PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { toErrorMessage } from '@utils/errors/errorMessage';

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

/**
 * A subscription preference transition the stores would not carry out. The
 * three members are the session read and the two preference writes, and both
 * writes go through the same settings store every host shares.
 */
class ModelAccessPreferenceFailed extends Data.TaggedError(
  'ModelAccessPreferenceFailed',
)<{
  readonly member: 'setPreferSubscription' | 'setEnabled';
  readonly subscription: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * A program: each coding plan's key status is a credential read that types its
 * own failure, so the surface that wants this status yields it or settles it
 * on the runtime it holds.
 */
export const readCliModelAccessStatus = Effect.fn(
  'modelAccessSelection.readCliModelAccessStatus',
)(function* (stores: SettingsStores, secrets: PlatformSecrets) {
  const [chatGpt, grok, codingPlanEntries] = yield* Effect.all(
    [
      subscriptionProvider('chatgpt').getStatus(secrets),
      subscriptionProvider('grok').getStatus(secrets),
      Effect.forEach(
        codingPlanSubscriptionRuntimes,
        (runtime) =>
          Effect.gen(function* () {
            const keySet = yield* hasUsableApiKey(
              secrets,
              runtime.descriptor.apiProvider,
            );
            const preferred = yield* runtime.getEnabled(stores);
            return [runtime.descriptor.id, { preferred, keySet }] as const;
          }),
        { concurrency: 'unbounded' },
      ),
    ] as const,
    { concurrency: 'unbounded' },
  );
  const codingPlans = Object.fromEntries(
    codingPlanEntries,
  ) as CliModelAccessStatus['codingPlans'];
  const preferences = {
    chatGpt: subscriptionProvider('chatgpt').isPreferSubscription(stores)
      ? 'on'
      : 'off',
    grok: subscriptionProvider('grok').isPreferSubscription(stores)
      ? 'on'
      : 'off',
  } as const;
  return {
    preferences,
    chatGptSignedIn: chatGpt.signedIn,
    chatGptAccountLabel: chatGpt.email ?? chatGpt.accountId,
    grokSignedIn: grok.signedIn,
    grokAccountLabel: grok.email,
    codingPlans,
  } satisfies CliModelAccessStatus;
});

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

/** Toggle an OAuth-subscription preference (Grok/ChatGPT) with sign-in. */
const updateSubscriptionCliModelAccess = Effect.fn(
  'modelAccessSelection.updateSubscriptionCliModelAccess',
)(function* (
  stores: SettingsStores,
  context: CliContext | undefined,
  selection: CliModelAccessSelection,
  providerId: SubscriptionProviderId,
  options: CliSubscriptionLoginOptions,
) {
  const provider = subscriptionProvider(providerId);
  const secrets = yield* Secrets;
  const { displayName, modelFamily } = provider;
  if (selection.state === 'off') {
    yield* provider.setPreferSubscription(stores, false).pipe(
      Effect.mapError(
        (cause) =>
          new ModelAccessPreferenceFailed({
            member: 'setPreferSubscription',
            subscription: providerId,
            message: `The ${displayName} subscription preference could not be disabled: ${toErrorMessage(cause)}`,
            cause,
          }),
      ),
    );
    return {
      message: `Prefer ${displayName} subscription disabled for ${modelFamily}.`,
    } satisfies CliModelAccessSelectionResult;
  }

  const status = yield* provider.getStatus(secrets);
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

  yield* provider.setPreferSubscription(stores, true).pipe(
    Effect.mapError(
      (cause) =>
        new ModelAccessPreferenceFailed({
          member: 'setPreferSubscription',
          subscription: providerId,
          message: `The ${displayName} subscription preference could not be enabled: ${toErrorMessage(cause)}`,
          cause,
        }),
    ),
  );
  const appState = yield* AppState;
  yield* appState.update(GlobalStateKey.USE_OPENROUTER, false).pipe(
    Effect.mapError(
      (cause) =>
        new StateWriteFailed({
          key: GlobalStateKey.USE_OPENROUTER,
          message: `The OpenRouter preference could not be cleared: ${toErrorMessage(cause)}`,
          cause,
        }),
    ),
  );
  return {
    message: `Prefer ${displayName} subscription enabled for ${modelFamily} (${accountLabel}).`,
  } satisfies CliModelAccessSelectionResult;
});

/** Toggle a key-credential subscription preference (Kimi Code/GLM). */
const updateKeyedCliModelAccess = Effect.fn(
  'modelAccessSelection.updateKeyedCliModelAccess',
)(function* (
  stores: SettingsStores,
  selection: CliModelAccessSelection,
  runtime: CodingPlanSubscriptionRuntime,
) {
  const plan = runtime.descriptor;
  if (selection.state === 'off') {
    yield* runtime.setEnabled(stores, false).pipe(
      Effect.mapError(
        (cause) =>
          new ModelAccessPreferenceFailed({
            member: 'setEnabled',
            subscription: plan.id,
            message: `${plan.preferenceLabel} could not be disabled: ${toErrorMessage(cause)}`,
            cause,
          }),
      ),
    );
    return {
      message: `${plan.preferenceLabel} disabled for ${plan.modelFamily}.`,
    } satisfies CliModelAccessSelectionResult;
  }

  // The provider API key is the subscription credential — there is no
  // separate sign-in flow.
  const secrets = yield* Secrets;
  const keySet = yield* hasUsableApiKey(secrets, plan.apiProvider);
  if (!keySet) {
    return {
      message: `No ${plan.credentialName} API key configured — add one with /key or /config → API keys (get one at ${plan.credentialSetupUrl}).`,
    } satisfies CliModelAccessSelectionResult;
  }
  yield* runtime.setEnabled(stores, true).pipe(
    Effect.mapError(
      (cause) =>
        new ModelAccessPreferenceFailed({
          member: 'setEnabled',
          subscription: plan.id,
          message: `${plan.preferenceLabel} could not be enabled: ${toErrorMessage(cause)}`,
          cause,
        }),
    ),
  );
  return {
    message: `${plan.preferenceLabel} enabled for ${plan.modelFamily} · other models still use ${formatCliModelAccessRouteInline('api-key')}.`,
  } satisfies CliModelAccessSelectionResult;
});

/**
 * Apply one declarative preference transition. A program: the command action
 * or slash handler runs it, where its cancellation signal (if any) becomes
 * fiber interruption of a sign-in in flight.
 */
export const updateCliModelAccess = Effect.fn(
  'modelAccessSelection.updateCliModelAccess',
)(function* (
  stores: SettingsStores,
  context: CliContext | undefined,
  selection: CliModelAccessSelection,
  options: CliSubscriptionLoginOptions = { writeProgress: () => undefined },
) {
  const codingPlan = codingPlanSubscriptionRuntimes.find(
    (runtime) => runtime.descriptor.cliProvider === selection.provider,
  );
  if (codingPlan) {
    return yield* updateKeyedCliModelAccess(stores, selection, codingPlan);
  }
  if (selection.provider === 'grok' || selection.provider === 'chatgpt') {
    return yield* updateSubscriptionCliModelAccess(
      stores,
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
