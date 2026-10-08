/**
 * Every setting model access reads, read once into one value. A binding, a
 * model switch's admission, the helper model and the picker's route facts
 * take a {@link ModelSettings}; nothing beneath them reads a store.
 */
import { Effect } from 'effect';
import { ModelProvider, type ReasoningEffort } from 'llm-zoo';

import {
  hasUsableApiKey,
  MODEL_PROVIDER_PLUGINS,
  type HostRouteFacts,
} from '@texra-ai/llm';
import { getCodexStatus, getXaiStatus } from '@texra-ai/llm/node';

import { StateReadFailed } from '@platform/interfaces';
import {
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  type DeclinableUsageRoute,
} from '@shared/schemas';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { readSettingFrom } from '@utils/config/platformSettings';
import {
  getGLMCodingPlan,
  getPreferKimiCode,
  getProviderEndpoint,
  getUseOpenRouter,
  useChinaRegion,
} from '@utils/config/providerConfig';

import { preferredCopilotRouteModels } from './copilotRouting';
import { reasoningEffortOverrides } from './reasoningLevel';
import { isPreferSubscription } from './subscriptionAccess';
import type { ModelOptionStores } from './computeModelOptions';

/** The model-access settings, as one read found them. */
export interface ModelSettings {
  /** The host half of the route facts, before a run declines any route. */
  readonly route: HostRouteFacts & {
    /** A dashboard GLM endpoint, which outranks the Coding Plan's path. */
    readonly glmEndpoint: boolean;
  };
  /** Models whose Copilot route the user prefers. */
  readonly copilotModels: readonly string[];
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
    responses: readSettingFrom<boolean>(
      stores,
      'texra.model.useBackgroundResponses',
    ),
    googleInteractions: readSettingFrom<boolean>(
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
    ({ id, baseUrl }) =>
      Effect.gen(function* () {
        const custom = yield* getProviderEndpoint(stores, id);
        if (custom) return [[id, `https://${hostPath(custom)}`] as const];
        if (baseUrl == null || typeof baseUrl === 'string') return [];
        const region = (yield* useChinaRegion(stores, id))
          ? 'china'
          : 'international';
        return [[id, baseUrl[region]] as const];
      }),
    { concurrency: 'unbounded' },
  );
  return Object.fromEntries(entries.flat());
});

/** A URL-like endpoint as `host/path`, without protocol or trailing slashes. */
function hostPath(input: string): string {
  const parsed = URL.parse(input.includes('://') ? input : `https://${input}`);
  if (!parsed) return input.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
}

/**
 * Whether a subscription's preference is on and its session signed in. The
 * sign-in is read only when the preference is on; the preference read is a
 * synchronous catalog read that throws, kept in the typed channel.
 */
const subscriptionOn = (
  stores: ModelOptionStores,
  provider: 'chatgpt' | 'grok',
): Effect.Effect<boolean, StateReadFailed> =>
  Effect.try({
    try: () => isPreferSubscription(provider, stores),
    catch: (cause) =>
      new StateReadFailed({
        key: provider,
        message: `Could not read the ${provider} subscription preference.`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((on) =>
      on
        ? Effect.map(
            (provider === 'chatgpt' ? getCodexStatus : getXaiStatus)(
              stores.secrets,
            ),
            (status) => status.signedIn,
          )
        : Effect.succeed(false),
    ),
  );

/** Read every model-access setting from `stores`, once. */
export const readModelSettings = Effect.fn('readModelSettings')(function* (
  stores: ModelOptionStores,
): Effect.fn.Return<ModelSettings, StateReadFailed> {
  const flag = (key: string) => readSettingFrom<boolean>(stores, key);
  const [route, rest, wire] = yield* Effect.all(
    [
      Effect.all(
        {
          useOpenRouter: getUseOpenRouter(stores),
          preferKimiCode: getPreferKimiCode(stores),
          glmCodingPlan: getGLMCodingPlan(stores),
          glmEndpoint: Effect.map(
            getProviderEndpoint(stores, ModelProvider.GLM),
            Boolean,
          ),
          chatgptSubscription: subscriptionOn(stores, 'chatgpt'),
          xaiSubscription: subscriptionOn(stores, 'grok'),
          // An unreadable Kimi Code key reads as absent and warns, the rule
          // the picker applies to every key status.
          kimiCodeKey: hasUsableApiKey(stores.secrets, 'kimiCode').pipe(
            Effect.catchTag('SecretsFailed', (failure) =>
              Effect.logWarning(
                'Failed to read Kimi Code API key status; treating it as unavailable.',
                failure.cause,
              ).pipe(Effect.as(false)),
            ),
          ),
          // Stored in thousands of tokens; this is its only reader.
          chatgptContextWindow: Effect.map(
            readSettingFrom<number>(
              stores,
              CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.configKey,
            ),
            (thousands) =>
              thousands * CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.tokensPerUnit,
          ),
          endpoints: readEndpoints(stores),
        },
        { concurrency: 'unbounded' },
      ),
      Effect.all({
        copilotModels: preferredCopilotRouteModels(stores.globalState),
        reasoningLevels: reasoningEffortOverrides(stores.globalState),
        preferShortModelNames: flag(GlobalStateKey.PREFER_SHORT_MODEL_NAMES),
        background: readBackgroundToggles(stores),
        automaticRetries: readSettingFrom<number>(
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
