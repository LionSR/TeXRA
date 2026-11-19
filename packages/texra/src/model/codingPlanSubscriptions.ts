import {
  emitAppSignal,
  Settings,
  type AppSignals,
  type SettingsStores,
  type ConfigWriteFailed,
  type StateReadFailed,
} from '@texra-ai/harness/plugins';
import { providerRegionSetting } from '@texra-ai/harness/schemas';
import {
  CODING_PLAN_SUBSCRIPTIONS,
  type CodingPlanSubscription,
} from '@texra/shared/model/codingPlans';
import { Effect } from 'effect';

export interface CodingPlanSubscriptionRuntime {
  readonly descriptor: CodingPlanSubscription;
  readonly getEnabled: (
    stores: SettingsStores,
  ) => Effect.Effect<boolean, StateReadFailed>;
  /**
   * Persist the toggle through the shared config write path and announce
   * `modelAccessChanged`. An `Effect`, like every other write of a
   * catalog-backed setting, so the caller's program composes it and owns the
   * failure.
   */
  readonly setEnabled: (
    stores: SettingsStores,
    enabled: boolean,
  ) => Effect.Effect<void, ConfigWriteFailed | Error, AppSignals>;
}

/** A plan's toggle re-routes its models, so its write says so. */
const announced = <E>(write: Effect.Effect<void, E>) =>
  Effect.andThen(write, emitAppSignal('modelAccessChanged', undefined));

/**
 * Runtime catalog consumed by retry policy and host route presentation. Which
 * plan serves a model's next request is not answered here: the picker decides
 * it (the `usageRoute` of each `readModelOptions` option).
 */
export const codingPlanSubscriptionRuntimes: readonly CodingPlanSubscriptionRuntime[] =
  Object.freeze(
    CODING_PLAN_SUBSCRIPTIONS.map((descriptor) =>
      Object.freeze({
        descriptor,
        getEnabled: (stores: SettingsStores) =>
          Settings.get(stores, descriptor.preference),
        setEnabled: (stores: SettingsStores, enabled: boolean) =>
          announced(Settings.set(stores, descriptor.preference, enabled)),
      }),
    ),
  );

/**
 * The plan whose usage endpoint varies with the setting `key`: a plan's
 * usage is read on its provider's region, so its region toggle is that
 * setting (the GLM Coding Plan on `texra.glm.useChina`).
 */
export function codingPlanForUsageSetting(
  key: string,
): CodingPlanSubscription | undefined {
  return CODING_PLAN_SUBSCRIPTIONS.find(
    (plan) => providerRegionSetting(plan.apiProvider)?.key === key,
  );
}
