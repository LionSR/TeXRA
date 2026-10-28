/**
 * Every setting model access reads, read once into one value. A binding, a
 * model switch's admission, the helper model and the picker's route facts
 * take a {@link ModelSettings}; nothing beneath them reads a store.
 */
import { Effect } from 'effect';

import {
  type EndpointProviderId,
  findModelProviderPlugin,
  hasUsableApiKey,
  type HostRouteFacts,
  MODEL_PROVIDER_PLUGINS,
  type ReasoningEffort,
  type RegionalProviderId,
} from '@texra-ai/llm';
import { getCodexStatus, getXaiStatus } from '@texra-ai/llm/node';

import { StateReadFailed } from '@platform/interfaces';
import {
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  type DeclinableUsageRoute,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  PROVIDER_ENDPOINT_STATE_ENTRIES,
  PROVIDER_REGION_SETTINGS,
  providerEndpointKey,
  providerRegionSetting,
} from '@shared/state/providerSettings';

import { Settings } from '@shared/config/settings';
import type { SettingsStores } from '@shared/config/settings';
import { reasoningEffortOverrides } from './reasoningLevel';
import { SubscriptionPreference } from './subscriptionAccess';
import type { ModelOptionStores } from './computeModelOptions';

type AssertNever<T extends never> = T;

/**
 * The provider settings rows cover the catalog exactly: every provider with
 * an HTTP endpoint of its own has a custom-endpoint row and every regional
 * provider a region toggle, and no row names another provider. The error
 * names the provider ids on either side that lack their counterpart.
 */
type _EndpointRowsCoverTheCatalog = AssertNever<
  | Exclude<
      EndpointProviderId,
      (typeof PROVIDER_ENDPOINT_STATE_ENTRIES)[number]['id']
    >
  | Exclude<
      (typeof PROVIDER_ENDPOINT_STATE_ENTRIES)[number]['id'],
      EndpointProviderId
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
  readonly route: HostRouteFacts & {
    /** A dashboard GLM endpoint, which outranks the Coding Plan's path. */
    readonly glmEndpoint: boolean;
  };
  /** The user's saved reasoning effort per model reference. */
  readonly reasoningLevels: Readonly<Record<string, ReasoningEffort>>;
  /** Send the unpinned `shortName` in place of the date-pinned id. */
  readonly preferShortModelNames: boolean;
  /** Automatic retries after a failed attempt. */
  readonly automaticRetries: number;
  /** The providers' background-delivery toggles. */
  readonly background: BackgroundToggles;
  /** The vendor knobs a binding sends. */
  readonly wire: {
    readonly parallelToolCalls: boolean;
    readonly reasoningSummary: boolean;
    readonly serverState: boolean;
    readonly fastTier: boolean;
    readonly webSocket: boolean;
  };
}

/** The providers' background-delivery toggles, which a run reads again each turn. */
export interface BackgroundToggles {
  readonly responses: boolean;
  readonly googleInteractions: boolean;
}

/** Read the background-delivery toggles alone. */
export function readBackgroundToggles(
  stores: SettingsStores,
): Effect.Effect<BackgroundToggles, StateReadFailed> {
  return Effect.all({
    responses: Settings.get<boolean>(
      stores,
      'texra.model.useBackgroundResponses',
    ),
    googleInteractions: Settings.get<boolean>(
      stores,
      'texra.model.useGoogleBackgroundResponses',
    ),
  });
}

/**
 * The endpoint the user chose for each provider: a dashboard URL, else the
 * default of the region its toggle picks. A provider with neither takes the
 * catalog default when the route resolves.
 */
const readEndpoints = Effect.fn('modelSettings.endpoints')(function* (
  stores: SettingsStores,
) {
  const entries = yield* Effect.forEach(
    MODEL_PROVIDER_PLUGINS,
    (plugin) => readEndpointEntries(stores, plugin),
    { concurrency: 'unbounded' },
  );
  return Object.fromEntries(entries.flat());
});

/** One provider's endpoint entry: its dashboard URL, else its region's default. */
const readEndpointEntries = Effect.fn('modelSettings.endpoint')(function* (
  stores: SettingsStores,
  { id, baseUrl }: (typeof MODEL_PROVIDER_PLUGINS)[number],
) {
  const endpointKey = providerEndpointKey(id);
  const custom = endpointKey
    ? yield* Settings.get<string>(stores, endpointKey)
    : '';
  if (custom) return [[id, `https://${hostPath(custom)}`] as const];
  if (baseUrl == null || typeof baseUrl === 'string') return [];
  const regionKey = providerRegionSetting(id)?.key;
  const region =
    regionKey && (yield* Settings.get<boolean>(stores, regionKey))
      ? 'china'
      : 'international';
  return [[id, baseUrl[region]] as const];
});

/**
 * `provider`'s endpoint alone, as the route facts' `endpoints` hold it, for a
 * request that needs no other model setting (audio transcription).
 */
export const readProviderEndpoint = Effect.fn('readProviderEndpoint')(
  function* (
    stores: SettingsStores,
    provider: string,
  ): Effect.fn.Return<Readonly<Record<string, string>>, StateReadFailed> {
    const plugin = findModelProviderPlugin(provider);
    if (plugin === undefined) return {};
    return Object.fromEntries(yield* readEndpointEntries(stores, plugin));
  },
);

/** A URL-like endpoint as `host/path`, without protocol or trailing slashes. */
function hostPath(input: string): string {
  const parsed = URL.parse(input.includes('://') ? input : `https://${input}`);
  if (!parsed) return input.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
}

/**
 * Whether a subscription's preference is on and its session signed in. The
 * sign-in is read only when the preference is on, and a session that cannot
 * be read fails rather than reading as signed out, which would route the
 * call to a different billing route; the preference read is a synchronous
 * catalog read that throws, kept in the typed channel.
 */
const subscriptionOn = (
  stores: ModelOptionStores,
  provider: 'chatgpt' | 'grok',
): Effect.Effect<boolean, StateReadFailed> =>
  Effect.try({
    try: () => SubscriptionPreference.get(provider, stores),
    catch: (cause) =>
      new StateReadFailed({
        key: provider,
        message: `Could not read the ${provider} subscription preference.`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((on) =>
      on
        ? (provider === 'chatgpt' ? getCodexStatus : getXaiStatus)(
            stores.secrets,
          ).pipe(
            Effect.map((status) => status.signedIn),
            Effect.mapError(
              (cause) =>
                new StateReadFailed({
                  key: provider,
                  message: `Could not read the ${provider} subscription session.`,
                  cause,
                }),
            ),
          )
        : Effect.succeed(false),
    ),
  );

/** Read every model-access setting from `stores`, once. */
export const readModelSettings = Effect.fn('readModelSettings')(function* (
  stores: ModelOptionStores,
): Effect.fn.Return<ModelSettings, StateReadFailed> {
  const flag = (key: string) => Settings.get<boolean>(stores, key);
  // One read decides both the route and how an unreadable key fails.
  const preferKimiCode = yield* flag(GlobalStateKey.KIMI_CODE_PREFER);
  const [route, rest, wire] = yield* Effect.all(
    [
      Effect.all(
        {
          preferKimiCode: Effect.succeed(preferKimiCode),
          glmCodingPlan: flag(GlobalStateKey.GLM_CODING_PLAN),
          glmEndpoint: Effect.map(
            Settings.get<string>(stores, GlobalStateKey.ENDPOINT_GLM),
            Boolean,
          ),
          chatgptSubscription: subscriptionOn(stores, 'chatgpt'),
          xaiSubscription: subscriptionOn(stores, 'grok'),
          // Under the Kimi Code preference the key picks the billing route,
          // so an unreadable one fails the read rather than routing to the
          // pay-per-token key. Otherwise it reads as absent and warns, the
          // rule the picker applies to every key status.
          kimiCodeKey: hasUsableApiKey(stores.secrets, 'kimiCode').pipe(
            Effect.catchTag('SecretsFailed', (failure) =>
              preferKimiCode
                ? Effect.fail(
                    new StateReadFailed({
                      key: 'kimiCode',
                      message:
                        'Could not read the Kimi Code API key while Kimi Code is preferred.',
                      cause: failure,
                    }),
                  )
                : Effect.logWarning(
                    'Failed to read Kimi Code API key status; treating it as unavailable.',
                    failure.cause,
                  ).pipe(Effect.as(false)),
            ),
          ),
          // Stored in thousands of tokens; this is its only reader.
          chatgptContextWindow: Effect.map(
            Settings.get<number | null>(
              stores,
              CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.configKey,
            ),
            (thousands) =>
              thousands === null
                ? undefined
                : thousands *
                  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.tokensPerUnit,
          ),
          endpoints: readEndpoints(stores),
        },
        { concurrency: 'unbounded' },
      ),
      Effect.all({
        reasoningLevels: reasoningEffortOverrides(stores.globalState),
        preferShortModelNames: flag(GlobalStateKey.PREFER_SHORT_MODEL_NAMES),
        background: readBackgroundToggles(stores),
        automaticRetries: Settings.get<number>(
          stores,
          MODEL_RETRY_MAX_ATTEMPTS_SETTING.configKey,
        ),
      }),
      Effect.all({
        parallelToolCalls: flag('texra.model.openaiParallelToolCalls'),
        reasoningSummary: flag('texra.model.gpt5ReasoningSummary'),
        serverState: flag('texra.model.useGoogleInteractionsServerState'),
        fastTier: flag('texra.model.openaiFastTier'),
        webSocket: flag(GlobalStateKey.WEBSOCKET_OPENAI),
      }),
    ],
    { concurrency: 'unbounded' },
  );
  return { route, wire, ...rest };
});

/**
 * The host route facts under the routes a run declined (a retry the user
 * answered with their own key): a declined subscription reads as off for
 * that run without touching the user's preference.
 */
export function routeFactsFor(
  settings: Pick<ModelSettings, 'route'>,
  declined: readonly DeclinableUsageRoute[],
): HostRouteFacts {
  const allowed = (route: DeclinableUsageRoute) => !declined.includes(route);
  const { glmEndpoint, ...route } = settings.route;
  return {
    ...route,
    chatgptSubscription:
      route.chatgptSubscription && allowed('chatgpt-subscription'),
    xaiSubscription: route.xaiSubscription && allowed('xai-subscription'),
    preferKimiCode: route.preferKimiCode && allowed('kimi-code-subscription'),
    glmCodingPlan:
      route.glmCodingPlan &&
      !glmEndpoint &&
      allowed('glm-coding-plan-subscription'),
  };
}
