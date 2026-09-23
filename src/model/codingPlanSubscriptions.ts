import { Effect } from 'effect';
import { ModelProvider } from 'llm-zoo';

import { hasUsableApiKey } from '@model/apiProviders';
import {
  isKimiCodeRoute,
  resolveKimiCodeRoutingFacts,
} from '@model/kimiCodeSubscriptionRouting';
import { shouldRouteModelThroughOpenRouter } from '@model/openRouterRouting';
import { oauthSubscriptionUsageRoute } from '@model/providerCapabilities';
import { resolveRouteEndpoint } from '@model/routeEndpoint';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';
import type { LanguageModel } from '@platform/languageModel';
import type { PlatformSecrets } from '@platform/secrets';
import type { ConfigWriteFailed, StateReadFailed } from '@platform/interfaces';
import {
  CODING_PLAN_SUBSCRIPTIONS,
  type CodingPlanSubscription,
} from '@shared/codingPlanSubscriptions';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { UsageRoute } from '@shared/schemas';
import { isKimiSubscriptionEligible } from '@shared/model/kimiCodeRetryGate';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  getGLMCodingPlan,
  getPreferKimiCode,
  getUseOpenRouter,
  setGLMCodingPlan,
} from '@utils/config/providerConfig';
import { writeSettingTo } from '@utils/config/platformSettings';

/**
 * What a coding-plan answer reads: the setting slots behind the plan toggles
 * and routing switches, plus the secret store behind the plan's own API key.
 */
export interface ModelSubscriptionStores extends SettingsStores {
  readonly secrets: PlatformSecrets;
}

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

function isGlmCodingPlanActive(
  stores: ModelSubscriptionStores,
  modelId: string,
): Effect.Effect<boolean, Error, LanguageModel> {
  return Effect.gen(function* () {
    const config = yield* resolveRuntimeModelConfig(modelId);
    if (config?.provider !== ModelProvider.GLM) return false;

    const endpoint = yield* resolveRouteEndpoint(
      stores,
      config,
      shouldRouteModelThroughOpenRouter(
        config,
        yield* getUseOpenRouter(stores),
      ),
    );
    if (endpoint.usageRoute !== 'glm-coding-plan-subscription') return false;
    return yield* hasUsableApiKey(stores.secrets, 'glm');
  });
}

/**
 * Whether the model currently routes through the Kimi Code coding endpoint
 * (Moonshot coding subscription, authenticated by the Kimi Code API key).
 * Mirrors the `modelRoutes` route facts: registry eligibility, the OpenRouter
 * toggle, a stored key, and the "Prefer Kimi Code" switch.
 */
function isKimiCodeSubscriptionActive(
  stores: ModelSubscriptionStores,
  modelId: string,
): Effect.Effect<boolean, Error, LanguageModel> {
  return Effect.gen(function* () {
    const config = yield* resolveRuntimeModelConfig(modelId);
    if (!config || !isKimiSubscriptionEligible(config)) return false;
    return isKimiCodeRoute(
      config,
      yield* resolveKimiCodeRoutingFacts(
        stores,
        stores.secrets,
        yield* getUseOpenRouter(stores),
      ),
    );
  });
}

const RUNTIME_BY_ID = {
  glmCodingPlan: {
    getEnabled: getGLMCodingPlan,
    setEnabled: setGLMCodingPlan,
    isActiveForModel: isGlmCodingPlanActive,
  },
  kimiCode: {
    getEnabled: getPreferKimiCode,
    setEnabled: (stores, enabled) =>
      writeSettingTo(stores, GlobalStateKey.KIMI_CODE_PREFER, enabled),
    isActiveForModel: isKimiCodeSubscriptionActive,
  },
} as const satisfies Record<
  CodingPlanSubscription['id'],
  Omit<CodingPlanSubscriptionRuntime, 'descriptor'> & {
    /**
     * Whether this plan currently serves the model. Module-private: excluded
     * from the public {@link CodingPlanSubscriptionRuntime} interface and the
     * exported catalog's element type; the one reader is
     * {@link activeCodingPlanForModel}, which
     * {@link activeSubscriptionUsageRoute} owns as the single public answer to
     * "which subscription serves this model next".
     */
    readonly isActiveForModel: (
      stores: ModelSubscriptionStores,
      modelId: string,
    ) => Effect.Effect<boolean, Error, LanguageModel>;
  }
>;

/** Rich rows (with `isActiveForModel`) for the module-private reader. */
const RUNTIMES = Object.freeze(
  CODING_PLAN_SUBSCRIPTIONS.map((descriptor) =>
    Object.freeze({
      descriptor,
      ...RUNTIME_BY_ID[descriptor.id],
    }),
  ),
);

/** Runtime catalog consumed by retry policy and host route presentation. */
export const codingPlanSubscriptionRuntimes: readonly CodingPlanSubscriptionRuntime[] =
  RUNTIMES;

/** Resolve the coding plan currently serving a model, if any. */
function activeCodingPlanForModel(
  stores: ModelSubscriptionStores,
  modelId: string,
): Effect.Effect<
  CodingPlanSubscriptionRuntime | undefined,
  Error,
  LanguageModel
> {
  return Effect.forEach(
    RUNTIMES,
    (runtime) =>
      Effect.map(runtime.isActiveForModel(stores, modelId), (active) => ({
        runtime,
        active,
      })),
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.map(
      (candidates) => candidates.find((candidate) => candidate.active)?.runtime,
    ),
  );
}

/**
 * The subscription route that would serve this model's next request, or
 * undefined when it would be paid for with the user's own API key.
 *
 * Single owner of "which subscription serves this model next": the OAuth
 * subscriptions answer from their capability profile's `usageRoute`, the
 * coding plans from their catalog descriptor. Callers get a `UsageRoute` — the
 * same vocabulary completed usage is stamped with — so no surface has to
 * re-order per-provider booleans to reach the same answer. At most one arm can
 * resolve: each subscription requires its own `config.provider`.
 *
 * Lives here rather than in `@model/providerCapabilities` so the OAuth-only
 * module stays free of the coding-plan runtime, which reads stored keys.
 */
export function activeSubscriptionUsageRoute(
  stores: ModelSubscriptionStores,
  modelId: string,
): Effect.Effect<UsageRoute | undefined, Error, LanguageModel> {
  return Effect.gen(function* () {
    const oauthRoute = yield* oauthSubscriptionUsageRoute(stores, modelId);
    if (oauthRoute !== undefined) return oauthRoute;
    const plan = yield* activeCodingPlanForModel(stores, modelId);
    return plan?.descriptor.usageRoute;
  });
}
