import type { ConfigWriteFailed, StateReadFailed } from '@platform/interfaces';
import {
  CODING_PLAN_SUBSCRIPTIONS,
  type CodingPlanSubscription,
} from '@shared/codingPlanSubscriptions';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  getGLMCodingPlan,
  getPreferKimiCode,
  setGLMCodingPlan,
} from '@utils/config/providerConfig';
import { writeSettingTo } from '@utils/config/platformSettings';
import type { Effect } from 'effect';

export interface CodingPlanSubscriptionRuntime {
  readonly descriptor: CodingPlanSubscription;
  readonly getEnabled: (
    stores: SettingsStores,
  ) => Effect.Effect<boolean, StateReadFailed>;
  /**
   * Persist the toggle through the shared config write path. An `Effect`, like
   * every other write of a catalog-backed setting, so the caller's program
   * composes it and owns the failure.
   */
  readonly setEnabled: (
    stores: SettingsStores,
    enabled: boolean,
  ) => Effect.Effect<void, ConfigWriteFailed | Error>;
}

const RUNTIME_BY_ID = {
  glmCodingPlan: {
    getEnabled: getGLMCodingPlan,
    setEnabled: setGLMCodingPlan,
  },
  kimiCode: {
    getEnabled: getPreferKimiCode,
    setEnabled: (stores, enabled) =>
      writeSettingTo(stores, GlobalStateKey.KIMI_CODE_PREFER, enabled),
  },
} as const satisfies Record<
  CodingPlanSubscription['id'],
  Omit<CodingPlanSubscriptionRuntime, 'descriptor'>
>;

/**
 * Runtime catalog consumed by retry policy and host route presentation. Which
 * plan serves a model's next request is not answered here: the picker decides
 * it (`usageRoute` on the `modelOptionsFrom` row).
 */
export const codingPlanSubscriptionRuntimes: readonly CodingPlanSubscriptionRuntime[] =
  Object.freeze(
    CODING_PLAN_SUBSCRIPTIONS.map((descriptor) =>
      Object.freeze({ descriptor, ...RUNTIME_BY_ID[descriptor.id] }),
    ),
  );
