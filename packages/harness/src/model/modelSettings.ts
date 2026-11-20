/**
 * Every setting model access reads, read once into one value. A binding, a
 * model switch's acceptance, the helper model and the picker's route facts
 * take a {@link ModelSettings}; nothing beneath them reads a store.
 */
import { Array as Arr, Effect, Struct } from 'effect';

import {
  type BackendProviderId,
  hasUsableApiKey,
  type PlanRoute,
  type ReasoningEffort,
  type RegionalProviderId,
  type RouteFacts,
  type SecretsFailed,
} from '@texra-ai/llm';
import { SubscriptionAccounts } from '@texra-ai/llm/node';

import { RouteUnavailable } from '@common/errors/agentErrors';
import { Secrets } from '@platform/secrets';
import {
  Settings,
  StateReadFailed,
  type SettingsStores,
} from '@shared/config/settings';
import {
  SUBSCRIPTION_ROUTES,
  type SubscriptionAuthProvider,
} from '@shared/model/subscriptionAuth';
import { type DeclinableUsageRoute } from '@shared/schemas';
import {
  PROVIDER_ENDPOINT_SETTINGS,
  PROVIDER_REGION_SETTINGS,
} from '@shared/state/providerSettings';

import { reasoningEffortOverrides } from './reasoningLevel';
import { SubscriptionPreference } from './subscriptionAccess';
import {
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  GLM_CODING_PLAN_SETTING,
  KIMI_CODE_PREFER_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  WEBSOCKET_OPENAI_SETTING,
  GOOGLE_INTERACTIONS_SERVER_STATE_SETTING,
  OPENAI_FAST_TIER_SETTING,
} from '@shared/state/stateSettings';

type AssertNever<T extends never> = T;

/**
 * The provider settings rows cover the catalog exactly: every provider with
 * an HTTP endpoint of its own has a custom-endpoint row and every regional
 * provider a region toggle, and no row names another provider. The error
 * names the provider ids on either side that lack their counterpart.
 */
type _EndpointRowsCoverTheCatalog = AssertNever<
  | Exclude<
      BackendProviderId,
      (typeof PROVIDER_ENDPOINT_SETTINGS)[number]['id']
    >
  | Exclude<
      (typeof PROVIDER_ENDPOINT_SETTINGS)[number]['id'],
      BackendProviderId
    >
>;
type _RegionRowsCoverTheCatalog = AssertNever<
  | Exclude<
      RegionalProviderId,
      (typeof PROVIDER_REGION_SETTINGS)[number]['provider']
    >
  | Exclude<
      (typeof PROVIDER_REGION_SETTINGS)[number]['provider'],
      RegionalProviderId
    >
>;

/** The model-access settings, as one read found them. */
export interface ModelSettings {
  /** The host half of the route facts, before a run declines any route. */
  readonly route: RouteFacts;
  /** A Kimi Code console key is stored. */
  readonly kimiCodeKey: boolean;
  /** The user's saved reasoning effort per model reference. */
  readonly reasoningLevels: Readonly<Record<string, ReasoningEffort>>;
  /** Automatic retries after a failed attempt. */
  readonly automaticRetries: number;
  /** The vendor knobs a binding sends. */
  readonly wire: {
    readonly serverState: boolean;
    readonly fastTier: boolean;
    readonly webSocket: boolean;
  };
}

/**
 * The route's endpoint facts as the user set them: a custom endpoint per
 * provider and the regional providers switched to their China platform.
 * Which URL a provider then takes is llm's decision (`decideModelRoute`).
 */
export const readEndpointFacts = Effect.fn('readEndpointFacts')(function* (
  stores: SettingsStores,
): Effect.fn.Return<
  Pick<RouteFacts, 'endpoints' | 'chinaPlatforms'>,
  StateReadFailed
> {
  const [endpoints, regions] = yield* Effect.all(
    [
      Effect.forEach(
        PROVIDER_ENDPOINT_SETTINGS,
        (row) =>
          Effect.map(
            Settings.get(stores, row),
            (url) => [row.id, url] as const,
          ),
        { concurrency: 'unbounded' },
      ),
      Effect.forEach(
        PROVIDER_REGION_SETTINGS,
        (row) =>
          Effect.map(
            Settings.get(stores, row),
            (china) => [row.provider, china] as const,
          ),
        { concurrency: 'unbounded' },
      ),
    ],
    { concurrency: 'unbounded' },
  );
  return {
    endpoints: Object.fromEntries(
      endpoints.flatMap(([id, url]) =>
        url ? [[id, `https://${hostPath(url)}`] as const] : [],
      ),
    ),
    chinaPlatforms: regions.flatMap(([id, china]) => (china ? [id] : [])),
  };
});

/** A URL-like endpoint as `host/path`, without protocol or trailing slashes. */
function hostPath(input: string): string {
  const parsed = URL.parse(input.includes('://') ? input : `https://${input}`);
  if (!parsed) return input.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
}

/**
 * Whether a subscription's preference is on and its session signed in. The
 * sign-in is read only when the preference is on, and a session that cannot
 * be read fails as its route, with whether only a fresh sign-in helps,
 * rather than reading as signed out, which would route the call to a
 * different billing route.
 */
const subscriptionOn = (
  stores: SettingsStores,
  provider: SubscriptionAuthProvider,
): Effect.Effect<boolean, RouteUnavailable, SubscriptionAccounts> => {
  const route = SUBSCRIPTION_ROUTES[provider];
  return SubscriptionPreference.get(provider, stores)
    ? Effect.flatMap(SubscriptionAccounts, (accounts) =>
        accounts[route].getStatus(),
      ).pipe(
        Effect.map((status) => status.signedIn),
        Effect.mapError((error) => RouteUnavailable.ofSession(route, error)),
      )
    : Effect.succeed(false);
};

/** Read every model-access setting from `stores` and the process
 *  {@link Secrets} with its subscription accounts, once. */
export const readModelSettings = Effect.fn('readModelSettings')(function* (
  stores: SettingsStores,
): Effect.fn.Return<
  ModelSettings,
  StateReadFailed | SecretsFailed | RouteUnavailable,
  Secrets | SubscriptionAccounts
> {
  const secrets = yield* Secrets;
  // One read decides both the route and how an unreadable key fails.
  const preferKimiCode = yield* Settings.get(stores, KIMI_CODE_PREFER_SETTING);
  const [{ chatgpt, xai, glm, kimiCodeKey, endpoints, ...route }, rest, wire] =
    yield* Effect.all(
      [
        Effect.all(
          {
            chatgpt: subscriptionOn(stores, 'chatgpt'),
            xai: subscriptionOn(stores, 'grok'),
            glm: Settings.get(stores, GLM_CODING_PLAN_SETTING),
            // Under the Kimi Code preference the key picks the billing route,
            // so an unreadable one fails the read rather than routing to the
            // pay-per-token key. Otherwise it reads as absent and warns, the
            // rule the picker applies to every key status.
            kimiCodeKey: hasUsableApiKey(secrets, 'kimiCode').pipe(
              Effect.catchTag('SecretsFailed', (failure) =>
                preferKimiCode
                  ? Effect.fail(failure)
                  : Effect.logWarning(
                      'Failed to read Kimi Code API key status; treating it as unavailable.',
                      failure.cause,
                    ).pipe(Effect.as(false)),
              ),
            ),
            // Stored in thousands of tokens; this is its only reader.
            chatgptContextWindow: Effect.map(
              Settings.get(stores, CHATGPT_CODEX_CONTEXT_WINDOW_SETTING),
              (thousands) =>
                thousands === null ? undefined : thousands * 1000,
            ),
            endpoints: readEndpointFacts(stores),
          },
          { concurrency: 'unbounded' },
        ),
        Effect.all({
          reasoningLevels: reasoningEffortOverrides(stores.globalState),
          automaticRetries: Settings.get(
            stores,
            MODEL_RETRY_MAX_ATTEMPTS_SETTING,
          ),
        }),
        Effect.all({
          serverState: Settings.get(
            stores,
            GOOGLE_INTERACTIONS_SERVER_STATE_SETTING,
          ),
          fastTier: Settings.get(stores, OPENAI_FAST_TIER_SETTING),
          webSocket: Settings.get(stores, WEBSOCKET_OPENAI_SETTING),
        }),
      ],
      { concurrency: 'unbounded' },
    );
  const on = {
    'chatgpt-subscription': chatgpt,
    'xai-subscription': xai,
    'kimi-code-subscription': preferKimiCode && kimiCodeKey,
    'glm-coding-plan-subscription': glm,
  } satisfies Record<PlanRoute, boolean>;
  return {
    route: {
      ...route,
      ...endpoints,
      plans: Struct.keys(on).filter((plan) => on[plan]),
    },
    kimiCodeKey,
    wire,
    ...rest,
  };
});

/**
 * The host route facts under the routes a run declined (a retry the user
 * answered with their own key): a declined plan reads as off for that run
 * without touching the user's preference.
 */
export function routeFactsFor(
  settings: Pick<ModelSettings, 'route'>,
  declined: readonly DeclinableUsageRoute[],
): RouteFacts {
  return {
    ...settings.route,
    plans: Arr.difference(settings.route.plans, declined),
  };
}
