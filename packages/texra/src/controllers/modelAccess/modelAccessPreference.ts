/**
 * Whether a subscription or a coding plan pays for its models: the one read
 * of every such preference with the credential it needs, and the one
 * operation that turns one on or off. Every host calls these and words the
 * outcome itself.
 */
// Third-party imports
import { Effect } from 'effect';

// Local imports - harness and llm
import {
  emitAppSignal,
  Secrets,
  Settings,
  type SettingsStores,
} from '@texra-ai/harness/plugins';
import { isSubscriptionAuthProvider } from '@texra-ai/harness/schemas';
import { hasUsableApiKey } from '@texra-ai/llm';

// Local imports - app
import {
  CODING_PLAN_SUBSCRIPTIONS,
  type CodingPlanSubscription,
  type CodingPlanSubscriptionId,
} from '@texra/shared/model/codingPlans';
import type { SubscriptionAuthStatus } from '@texra/shared/model/subscriptionAuthStatus';
import {
  subscriptionAuthStatuses,
  subscriptionProvider,
  type SubscriptionProviderId,
} from './subscriptionProviders';

/** What a model-access preference belongs to: a sign-in subscription or a
 *  coding plan a provider key pays through. */
export type ModelAccessProviderId =
  | SubscriptionProviderId
  | CodingPlanSubscriptionId;

/** Every model-access preference, with the credential each one needs. */
export interface ModelAccessStatus {
  /** Each sign-in subscription's session and preference, by provider. */
  readonly subscriptions: Readonly<
    Record<SubscriptionProviderId, SubscriptionAuthStatus>
  >;
  /** Each coding plan's preference and whether its provider key is set. */
  readonly codingPlans: Readonly<
    Record<
      CodingPlanSubscriptionId,
      { readonly preferred: boolean; readonly keySet: boolean }
    >
  >;
}

/** Whether a coding plan's provider key is set. */
const planKeySet = (plan: CodingPlanSubscription) =>
  Effect.flatMap(Secrets, (secrets) =>
    hasUsableApiKey(secrets, plan.apiProvider),
  );

/**
 * Read every model-access preference. A credential that cannot be read fails
 * the read: it is neither set nor missing.
 */
export const readModelAccessStatus = Effect.fn('readModelAccessStatus')(
  function* (stores: SettingsStores) {
    const [subscriptions, codingPlanEntries] = yield* Effect.all(
      [
        subscriptionAuthStatuses(stores),
        Effect.forEach(
          CODING_PLAN_SUBSCRIPTIONS,
          Effect.fnUntraced(function* (plan) {
            const keySet = yield* planKeySet(plan);
            const preferred = yield* Settings.get(stores, plan.preference);
            return [plan.id, { preferred, keySet }] as const;
          }),
          { concurrency: 'unbounded' },
        ),
      ] as const,
      { concurrency: 'unbounded' },
    );
    const codingPlans =
      // cast: one entry per coding plan, so the plan ids are the record's keys.
      Object.fromEntries(codingPlanEntries) as ModelAccessStatus['codingPlans'];
    return { subscriptions, codingPlans } satisfies ModelAccessStatus;
  },
);

/**
 * How {@link setModelAccessPreference} ended. `needs-sign-in` and
 * `needs-key` wrote nothing: the preference cannot pay for a request without
 * its credential, so the host gets the credential first (its sign-in, which
 * turns the preference on when it succeeds, or its way to add a key).
 */
export type ModelAccessPreferenceOutcome =
  | 'enabled'
  | 'disabled'
  | 'needs-sign-in'
  | 'needs-key';

/** What a written preference reads as. */
const written = (enabled: boolean): ModelAccessPreferenceOutcome =>
  enabled ? 'enabled' : 'disabled';

/**
 * {@link setModelAccessPreference} for a coding plan the caller already
 * holds: the settings write path, which meets a plan as its switch's row and
 * needs no subscription account to write it.
 */
export const setCodingPlanPreference = Effect.fn('setCodingPlanPreference')(
  function* (
    stores: SettingsStores,
    plan: CodingPlanSubscription,
    enabled: boolean,
  ) {
    if (enabled && !(yield* planKeySet(plan))) {
      return 'needs-key' satisfies ModelAccessPreferenceOutcome;
    }
    yield* Settings.set(stores, plan.preference, enabled);
    yield* emitAppSignal('modelAccessChanged', undefined);
    return written(enabled);
  },
);

/**
 * Turn one model-access preference on or off, and announce
 * `modelAccessChanged` when it was written. Turning one off always writes.
 * Turning one on writes only when its credential is there: a subscription
 * that is signed in, a coding plan whose provider key is set.
 */
export const setModelAccessPreference = Effect.fn('setModelAccessPreference')(
  function* (
    stores: SettingsStores,
    provider: ModelAccessProviderId,
    enabled: boolean,
  ) {
    if (isSubscriptionAuthProvider(provider)) {
      const subscription = subscriptionProvider(provider);
      if (enabled && !(yield* subscription.getStatus()).signedIn) {
        return 'needs-sign-in' satisfies ModelAccessPreferenceOutcome;
      }
      yield* subscription.setPreferSubscription(stores, enabled);
      return written(enabled);
    }
    const plan = CODING_PLAN_SUBSCRIPTIONS.find(({ id }) => id === provider);
    // One row per coding-plan id, so the lookup holds.
    if (plan === undefined) return written(enabled);
    return yield* setCodingPlanPreference(stores, plan, enabled);
  },
);
