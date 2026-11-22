import { Effect } from 'effect';

import { providerDisplayName } from '@texra-ai/llm';
import { getProviderKeyUrl } from '@texra/model/providerPresentation';
import type { SettingsStores } from '@texra-ai/worldline/plugins';
import { isSubscriptionAuthProvider } from '@texra-ai/worldline/schemas';
import { CODING_PLAN_SUBSCRIPTIONS } from '@texra/shared/model/codingPlans';
import { setModelAccessPreference } from '@texra/controllers/modelAccess/modelAccessPreference';
import { subscriptionProvider } from '@texra/controllers/modelAccess/subscriptionProviders';

import { OWN_API_KEYS } from '@ui/copy/modelAccess';
import {
  shouldUseSubscriptionDeviceCode,
  signInCliSubscription,
  type CliSubscriptionLoginOptions,
} from './subscriptionLogin';
import { type CliModelAccessSelection } from './modelAccessRoute';
import type { CliContext } from '../platform/cliContext';

/**
 * Apply one preference change and word how it ended: the app decides
 * (`setModelAccessPreference`), and the terminal gets the credential a
 * preference lacks its own way, signing in on the spot or naming where a key
 * is added. A program: the command action or slash handler runs it, where
 * its cancellation signal (if any) becomes fiber interruption of a sign-in
 * in flight.
 */
export const updateCliModelAccess = Effect.fn(
  'modelAccessSelection.updateCliModelAccess',
)(function* (
  stores: SettingsStores,
  context: CliContext | undefined,
  selection: CliModelAccessSelection,
  options: CliSubscriptionLoginOptions = { writeProgress: () => undefined },
) {
  const { provider } = selection;
  const outcome = yield* setModelAccessPreference(
    stores,
    provider,
    selection.state === 'on',
  );
  if (isSubscriptionAuthProvider(provider)) {
    const { displayName, modelFamily, getStatus } =
      subscriptionProvider(provider);
    if (outcome === 'disabled') {
      return {
        message: `${displayName} subscription disabled for ${modelFamily}.`,
      };
    }
    // Signing in turns the preference on.
    const init = { device: false, noBrowser: false };
    const account =
      outcome === 'needs-sign-in'
        ? yield* signInCliSubscription(
            stores,
            provider,
            {
              ...init,
              device:
                context != null &&
                shouldUseSubscriptionDeviceCode(context, init),
            },
            options,
          )
        : yield* getStatus();
    return {
      message: `${displayName} subscription enabled for ${modelFamily} (${account.label}).`,
    };
  }
  const plan = CODING_PLAN_SUBSCRIPTIONS.find(({ id }) => id === provider);
  if (plan === undefined) {
    return yield* Effect.die(
      new Error(`Coding plan is missing from the catalog: ${provider}`),
    );
  }
  const { title } = plan.preference;
  switch (outcome) {
    case 'disabled':
      return { message: `${title} disabled for ${plan.modelFamily}.` };
    case 'needs-key':
      // The provider API key is the plan's credential: there is no sign-in.
      return {
        message: `No ${providerDisplayName(plan.apiProvider)} API key configured — add one with /key or /config → API keys (get one at ${yield* getProviderKeyUrl(stores, plan.apiProvider)}).`,
      };
    default:
      return {
        message: `${title} enabled for ${plan.modelFamily} · other models still use ${OWN_API_KEYS.inline}.`,
      };
  }
});
