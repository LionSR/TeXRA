/**
 * The host half of the route decision (`decideModelRoute` in
 * `@texra-ai/llm`): the facts it reads from this session's settings, secret
 * store and sign-in state, and the credential switch a failed attempt offers.
 */
import {
  decideModelRoute,
  hasUsableApiKey,
  MODEL_PROVIDER_PLUGINS,
  OWN_KEY_ROUTE_FACTS,
  type HostRouteFacts,
  type ModelRoute,
} from '@texra-ai/llm';
import { getCodexStatus, getXaiStatus } from '@texra-ai/llm/node';
import { Effect } from 'effect';
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { isPreferSubscription } from '@model/subscriptionAccess';
import { StateReadFailed } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import {
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  getExhaustionReason,
  type CredentialSwitch,
  type DeclinableUsageRoute,
  type ProviderError,
} from '@shared/schemas';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { readSettingFrom } from '@utils/config/platformSettings';
import {
  getGLMCodingPlan,
  getPreferKimiCode,
  getProviderEndpoint,
  getUseOpenRouter,
  useChinaRegion,
} from '@utils/config/providerConfig';

/** Normalize a URL-like endpoint to `host/path` form without protocol or trailing slashes. */
function normalizeProviderEndpoint(input: string): string {
  if (!input) return '';

  const withProtocol = input.includes('://') ? input : `https://${input}`;
  const parsed = URL.parse(withProtocol);
  if (!parsed) return input.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
}

/**
 * The endpoint the user chose for each provider (`RouteFacts.endpoints`): a
 * dashboard URL, else the default of the region its toggle picks. A provider
 * with neither takes the catalog default when the route resolves.
 */
export const readProviderEndpoints = Effect.fn('readProviderEndpoints')(
  function* (stores: SettingsStores) {
    const entries = yield* Effect.forEach(
      MODEL_PROVIDER_PLUGINS,
      ({ id, baseUrl }) =>
        Effect.gen(function* () {
          const custom = yield* getProviderEndpoint(stores, id);
          if (custom) {
            return [[id, `https://${normalizeProviderEndpoint(custom)}`]];
          }
          if (baseUrl == null || typeof baseUrl === 'string') return [];
          const region = (yield* useChinaRegion(stores, id))
            ? 'china'
            : 'international';
          return [[id, baseUrl[region]]];
        }),
      { concurrency: 'unbounded' },
    );
    return Object.fromEntries(entries.flat()) as Readonly<
      Record<string, string>
    >;
  },
);

/** The routes whose quota the retry owner falls back from without asking. */
const CODING_PLAN_ROUTES: readonly DeclinableUsageRoute[] = [
  'kimi-code-subscription',
  'glm-coding-plan-subscription',
];

/**
 * The move onto the user's own credential a failed attempt offers, decided
 * once by the retry owner (`ModelInvoker`) from the recorded failure and the
 * failed binding's route, and carried on the retry request so no host
 * re-derives it.
 *
 * - A subscription or coding-plan route falls back to the route the model
 *   takes with every preference off. When that is the same kind of route
 *   (a Kimi Code-exclusive model, which only the coding endpoint serves),
 *   there is nothing to move to.
 * - A key whose upstream account ran out of credit needs a changed key for
 *   the same provider (the Kimi Code key of a Kimi Code-exclusive model).
 * - The Copilot route moves to a replacement run on the direct model.
 *
 * A coding-plan fallback is automatic when its key is already stored and
 * the run has not declined that route before: switching re-uses a key the
 * user gave, so it needs no one present (a headless run, a delegated child).
 * The subscriptions (ChatGPT, Grok) stay explicit, because moving them onto
 * a key starts spending API credit.
 */
export const routeCredentialSwitch = Effect.fn('routeCredentialSwitch')(
  function* (
    failed: { readonly config: ModelConfig; readonly route: ModelRoute },
    recorded: Pick<ProviderError, 'classification'>,
    declinedRoutes: readonly DeclinableUsageRoute[],
    secrets: PlatformSecrets,
  ): Effect.fn.Return<CredentialSwitch | null> {
    const reason = getExhaustionReason(recorded);
    if (reason === undefined) return null;
    const { route } = failed;
    let declined: DeclinableUsageRoute;
    switch (route.kind) {
      case 'copilot':
        return reason === 'copilot-subscription'
          ? { kind: 'copilot-fallback' }
          : null;
      case 'openrouter':
        return reason === 'upstream-credit'
          ? { kind: 'new-key', provider: 'openRouter' }
          : null;
      case 'chatgpt-subscription':
      case 'xai-subscription':
        declined = route.kind;
        break;
      case 'api-key':
        // The key the route bound is itself the broken credential, whatever
        // plan it pays through.
        if (reason === 'upstream-credit') {
          return { kind: 'new-key', provider: route.provider };
        }
        if (route.usageRoute === 'api-key') return null;
        declined = route.usageRoute;
        break;
      default:
        return null;
    }
    const fallback = decideModelRoute(failed.config, OWN_KEY_ROUTE_FACTS);
    if (fallback.kind !== 'api-key' || fallback.usageRoute !== 'api-key') {
      return null;
    }
    const automatic =
      CODING_PLAN_ROUTES.includes(declined) &&
      !declinedRoutes.includes(declined) &&
      (yield* hasUsableApiKey(secrets, fallback.provider).pipe(
        Effect.catchTag('SecretsFailed', (failure) =>
          Effect.logWarning(
            `Could not read the ${fallback.provider} API key; the quota fallback waits for a decision.`,
            failure.cause,
          ).pipe(Effect.as(false)),
        ),
      ));
    return {
      kind: 'decline-route',
      route: declined,
      provider: fallback.provider,
      automatic,
    };
  },
);

/**
 * Read the host half of the route facts. `declinedRoutes` are the routes the
 * asking run declined (a retry the user answered with their own key): a
 * declined subscription reads as off for that run without touching the
 * user's preference. An unreadable Kimi Code key reads as absent and warns,
 * the rule the picker applies to every key status.
 */
export const readRouteFacts = Effect.fn('readRouteFacts')(function* (
  stores: SettingsStores & { readonly secrets: PlatformSecrets },
  declinedRoutes: readonly DeclinableUsageRoute[] = [],
): Effect.fn.Return<HostRouteFacts, StateReadFailed> {
  const allowed = (route: DeclinableUsageRoute) =>
    !declinedRoutes.includes(route);
  // Only worth a sign-in read when the preference is on. The preference read
  // is a synchronous catalog read that throws; keep it in the typed channel.
  const subscriptionOn = (
    route: DeclinableUsageRoute,
    preference: string,
    provider: Parameters<typeof isPreferSubscription>[0],
  ) =>
    allowed(route)
      ? Effect.try({
          try: () => isPreferSubscription(provider, stores),
          catch: (cause) =>
            new StateReadFailed({
              key: preference,
              message: `Could not read the ${preference} preference.`,
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
        )
      : Effect.succeed(false);
  const [
    useOpenRouter,
    preferKimiCode,
    glmCodingPlan,
    glmEndpoint,
    chatgptSubscription,
    xaiSubscription,
    kimiCodeKey,
    chatgptContextWindow,
    endpoints,
  ] = yield* Effect.all(
    [
      getUseOpenRouter(stores),
      getPreferKimiCode(stores),
      getGLMCodingPlan(stores),
      getProviderEndpoint(stores, ModelProvider.GLM),
      subscriptionOn('chatgpt-subscription', 'ChatGPT subscription', 'chatgpt'),
      subscriptionOn('xai-subscription', 'Grok subscription', 'grok'),
      hasUsableApiKey(stores.secrets, 'kimiCode').pipe(
        Effect.catchTag('SecretsFailed', (failure) =>
          Effect.logWarning(
            'Failed to read Kimi Code API key status; treating it as unavailable.',
            failure.cause,
          ).pipe(Effect.as(false)),
        ),
      ),
      // The setting is stored in thousands of tokens; this is its only
      // reader, so the unit conversion lives here and nowhere else.
      readSettingFrom<number>(
        stores,
        CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.configKey,
      ).pipe(
        Effect.map(
          (thousands) =>
            thousands * CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.tokensPerUnit,
        ),
      ),
      readProviderEndpoints(stores),
    ] as const,
    { concurrency: 'unbounded' },
  );
  return {
    useOpenRouter,
    chatgptContextWindow,
    endpoints,
    chatgptSubscription,
    xaiSubscription,
    kimiCodeKey,
    preferKimiCode: preferKimiCode && allowed('kimi-code-subscription'),
    glmCodingPlan:
      glmCodingPlan && !glmEndpoint && allowed('glm-coding-plan-subscription'),
  };
});
