/**
 * The run's model binding: one runtime `ModelConfig` plus the route
 * `modelRoutes` resolves, bound by the llm package to the `Model` the loop
 * calls, the durable `ModelOrigin` every run history row names, and the
 * runtime facts the package deliberately does not own (the context window,
 * the credential route keys the retry gate coordinates on, the user's retry
 * setting).
 *
 * Credentials are resolved when the binding is made, under the recorded
 * route; the secret reaches the package's transport and never a row. The
 * `credentialScope` on the origin is a non-secret name of the route.
 */
import { createHash } from 'node:crypto';

import { Effect, type Scope } from 'effect';
import {
  BACKEND_PROTOCOLS,
  type BackendProviderId,
  type Model,
  type ModelOrigin,
  type ModelRoute,
  type ReasoningChoice,
  type ReasoningRequest,
  routeConfig,
  selectModel,
} from '@texra-ai/llm';
import { bindModel as bindWireModel } from '@texra-ai/llm/node';

import {
  resolveModelRoute,
  resolveRouteCredential,
  resolveSubscriptionCredential,
  routeBearer,
  routeBackend,
  withShortModelName,
  type RouteCredential,
} from '@agent/runtime/modelRoutes';
import { type ModelOptionStores } from '@model/computeModelOptions';
import { reasoningFor } from '@model/reasoningLevel';
import type { CopilotModelRoute } from '@model/copilotRouting';
import { longRunningModelFetch } from '@platform/defaults/longRunningModelTransport';
import { LanguageModel } from '@platform/languageModel';
import {
  AgentCategory,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  type DeclinableUsageRoute,
  type ModelBackend,
  type UsageRoute,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { readSettingFrom } from '@utils/config/platformSettings';
import { validationModel } from './validationModel';
import type { ModelConfig } from 'llm-zoo';
import type { HttpClient } from 'effect/http';

/** Tool-use runs keep output headroom for context growth. */
const TOOL_USE_MAX_OUTPUT_FACTOR = 0.5;

/** The runtime facts of one bound model that the package does not carry. */
export interface BoundModel {
  /** The run's model string (`provider/id[@effort][+pro]`), as every snapshot names it. */
  readonly modelId: string;
  readonly config: ModelConfig;
  /** What this binding asks the model for: thinking, effort and mode, and any level it substituted. */
  readonly reasoning: ReasoningChoice;
  /** The service tier the requests are sent on, which pricing bills. */
  readonly serviceTier?: 'fast';
  readonly backend: ModelBackend;
  readonly model: Model;
  readonly origin: ModelOrigin;
  /** The route decision this binding carries out (the retry offer reads it). */
  readonly route: ModelRoute;
  readonly usageRoute: UsageRoute;
  /** The route's subscription plan, when it names one; display-only. */
  readonly usagePlan?: string;
  readonly contextWindow: number;
  readonly supportsVision: boolean;
  /** Mirror `config.capabilities`: the media pipeline reads these two. */
  readonly supportsNativePdf: boolean;
  readonly supportsNativeAudio: boolean;
  readonly supportsForcedToolChoice: boolean;
  /** The retry gate's keys: one wire route (provider, credential route,
   *  endpoint, key fingerprint), and that route narrowed to one model. */
  readonly wireRouteKey: string;
  readonly modelRetryRouteKey: string;
  /** The binding can run a turn as background work (submit + observe). */
  readonly backgroundCapable: boolean;
  /** One connection a failed turn invalidates (the Responses WebSocket): the
   *  invoker rebinds before it tries again. */
  readonly persistentConnection: boolean;
  /** Automatic retries after a failed attempt, the user's setting read once
   *  with the binding: the invoker takes it from here, and a rebind (a
   *  manual retry, a model switch, a resume) reads it again. */
  readonly automaticRetries: number;
}

interface BindModelInput {
  /** The run's model string, as stored; it also carries the effort, thinking and mode asked for. */
  readonly modelId: string;
  /** The config to bind: a route's overlay, else the catalog entry the model string names. */
  readonly config?: ModelConfig;
  /** Live settings from this run's session, plus the process secret store. */
  readonly stores: ModelOptionStores;
  /** A resumed run's backend wins over today's default route. */
  readonly backend?: ModelBackend;
  /** Own-key quota fallback also declines Copilot; seeds declinedRoutes. */
  readonly ownApiKeyFallback?: boolean;
  /** Declined routes persist on this run's history, not in user preferences. */
  readonly declinedRoutes?: readonly DeclinableUsageRoute[];
  readonly agentCategory: AgentCategory;
  /** The route default's temperature. */
  readonly temperature: number;
}

/** The protocol each backend serves a run on. A stored backend without a
 *  provider protocol does not compile. */
export const PROTOCOL_BY_BACKEND: Readonly<
  Record<ModelBackend, ModelOrigin['protocol'] | 'validation'>
> = Object.freeze({ validation: 'validation', ...BACKEND_PROTOCOLS });

type AssertNever<T extends never> = T;

/** Every plugin that names a protocol is a stored backend; the error names
 *  the plugin ids `ModelBackendSchema` lacks. */
type _EveryBackendProviderIsStored = AssertNever<
  Exclude<BackendProviderId, ModelBackend>
>;

/** A binding's {@link BoundModel.wireRouteKey} and model-scoped key. */
function routeKeys(wire: readonly string[], model: string) {
  const wireRouteKey = JSON.stringify(wire);
  return {
    wireRouteKey,
    modelRetryRouteKey: JSON.stringify([wireRouteKey, model]),
  };
}

function credentialFingerprint(route: string, secret: string): string {
  return createHash('sha256')
    .update(route)
    .update('\0')
    .update(secret)
    .digest('base64url');
}

/**
 * Whether a binding delivers its turns as background work: the run's
 * category and the provider's own toggle over a binding that can. One owner
 * for the choice — the loop asks it per turn, and the binding asks it to
 * decide whether the Responses WebSocket applies. The toggles are read live
 * on every call through the catalog reader, so a flip mid-run takes effect
 * on the next turn, on the scope the Models tab shows (#12710).
 */
export const backgroundDelivery = Effect.fn('backgroundDelivery')(function* (
  bound: {
    readonly backgroundCapable: boolean;
    readonly protocol: ModelOrigin['protocol'];
    readonly modelName: string;
    readonly agentCategory: AgentCategory;
  },
  stores: SettingsStores,
) {
  if (!bound.backgroundCapable) return false;
  if (bound.agentCategory !== AgentCategory.Workflow) return false;
  if (bound.protocol === 'google-interactions') {
    return yield* readSettingFrom<boolean>(
      stores,
      'texra.model.useGoogleBackgroundResponses',
    );
  }
  return (
    bound.modelName.toLowerCase().startsWith('gpt') &&
    (yield* readSettingFrom<boolean>(
      stores,
      'texra.model.useBackgroundResponses',
    ))
  );
});

/** Bind a model the editor serves over the route its decision discovered
 *  (exact id, vendor and version), into the caller's scope. */
const bindEditorModel = Effect.fn('bindEditorModel')(function* (
  modelId: string,
  backend: ModelBackend,
  route: CopilotModelRoute,
  reasoning: ReasoningChoice,
  automaticRetries: number,
): Effect.fn.Return<BoundModel, Error, Scope.Scope | LanguageModel> {
  const editor = yield* LanguageModel;
  // The discovered route carries the editor's own context ceiling and the
  // subscription's pricing: the config the run accounts against.
  const routed = route.effectiveConfig;
  const requestedModel = route.reference.id;
  const deployment = {
    vendor: route.reference.vendor,
    version: route.version,
  } as const;
  const model = yield* editor.acquire({
    protocol: 'vscode-lm',
    requestedModel,
    deployment,
    supportsImageInput: routed.capabilities.supportsVision,
    supportsToolCalling: routed.capabilities.supportsFunctionCalling,
    defaults: { justification: 'Run the selected TeXRA agent.' },
  });
  return {
    modelId,
    config: routed,
    reasoning,
    backend,
    model,
    origin: {
      protocol: 'vscode-lm',
      codecVersion: 1,
      requestedModel,
      deployment,
    },
    route: { kind: 'copilot', route },
    usageRoute: 'api-key',
    contextWindow: routed.contextWindow,
    supportsVision: routed.capabilities.supportsVision,
    supportsNativePdf: false,
    supportsNativeAudio: false,
    supportsForcedToolChoice: false,
    ...routeKeys(
      ['vscode-lm', deployment.vendor, deployment.version],
      requestedModel,
    ),
    backgroundCapable: false,
    persistentConnection: false,
    automaticRetries,
  };
});

/**
 * Bind one model for a run. The route is `resolveModelRoute`'s one decision,
 * and only the credential that route names is fetched; a resumed run's
 * backend wins over today's default.
 */
export const bindModel = Effect.fn('bindModel')(function* (
  input: BindModelInput,
): Effect.fn.Return<
  BoundModel,
  Error,
  Scope.Scope | HttpClient.HttpClient | LanguageModel
> {
  const selected = selectModel(input.modelId);
  const catalog = input.config ?? selected?.config;
  if (catalog === undefined) {
    return yield* Effect.fail(
      new Error(`Model ${input.modelId} is not registered`),
    );
  }
  const request: ReasoningRequest = selected?.request ?? {};
  const { stores } = input;
  const automaticRetries = yield* readSettingFrom<number>(
    stores,
    MODEL_RETRY_MAX_ATTEMPTS_SETTING.configKey,
  );
  // The wire identity the preference promises, applied to the bound config;
  // a request in a provider mode (OpenAI `pro`) keeps the pinned id.
  const requested =
    request.mode === undefined
      ? yield* withShortModelName(catalog, stores)
      : catalog;
  const { route, facts } = yield* resolveModelRoute(stores, requested, {
    ...input,
    mode: request.mode,
  });
  const backend = input.backend ?? (yield* routeBackend(requested, route));
  if (backend === undefined) {
    return yield* Effect.fail(
      new Error(`Unsupported model provider: ${catalog.provider}`),
    );
  }
  const protocol = PROTOCOL_BY_BACKEND[backend];
  if (protocol === 'vscode-lm' && route.kind === 'copilot') {
    // The editor manages its own reasoning; the choice is recorded, not sent.
    return yield* bindEditorModel(
      input.modelId,
      backend,
      route.route,
      yield* reasoningFor(requested, request, stores.globalState, {
        protocol,
        codexSubscription: false,
      }),
      automaticRetries,
    );
  }
  if (protocol === 'validation') {
    const bound = validationModel(requested);
    return {
      modelId: input.modelId,
      config: requested,
      reasoning: yield* reasoningFor(requested, request, stores.globalState, {
        protocol,
        codexSubscription: false,
      }),
      backend,
      model: bound.model,
      origin: bound.origin,
      route: { kind: 'validation' },
      usageRoute: 'api-key',
      contextWindow: requested.contextWindow,
      supportsVision: false,
      supportsNativePdf: false,
      supportsNativeAudio: false,
      supportsForcedToolChoice: true,
      ...routeKeys([requested.provider, 'validation'], requested.id),
      backgroundCapable: false,
      persistentConnection: false,
      automaticRetries,
    };
  }
  if (
    protocol === 'vscode-lm' ||
    route.kind === 'copilot' ||
    route.kind === 'validation'
  ) {
    return yield* Effect.fail(
      new Error(
        `Model ${input.modelId} routes through ${route.kind}, which the run's ${backend} backend cannot bind.`,
      ),
    );
  }
  const config = routeConfig(requested, route, facts);
  const credential: RouteCredential =
    route.kind === 'chatgpt-subscription' || route.kind === 'xai-subscription'
      ? yield* resolveSubscriptionCredential(route, stores.secrets)
      : yield* resolveRouteCredential(facts, config, route, stores.secrets);
  const reasoning = yield* reasoningFor(config, request, stores.globalState, {
    protocol,
    codexSubscription: credential.route === 'chatgpt-subscription',
  });
  const bound = yield* bindWireModel({
    protocol,
    model: config,
    endpoint: credential.endpoint,
    credentialScope: `${credential.provider}:${credential.route}`,
    // A subscription token is the bearer where an API key would be, and the
    // Codex session additionally names its account.
    credential:
      credential.route === 'chatgpt-subscription'
        ? {
            kind: 'codex',
            accessToken: credential.accessToken,
            accountId: credential.accountId,
          }
        : { kind: 'api-key', apiKey: routeBearer(credential) },
    billing: credential.usageRoute,
    options: {
      maxOutputTokens:
        input.agentCategory === AgentCategory.ToolUse
          ? Math.max(
              1,
              Math.floor(config.maxOutputTokens * TOOL_USE_MAX_OUTPUT_FACTOR),
            )
          : config.maxOutputTokens,
      temperature: input.temperature,
      reasoning,
      parallelToolCalls: yield* readSettingFrom<boolean>(
        stores,
        'texra.model.openaiParallelToolCalls',
      ),
      reasoningSummary: yield* readSettingFrom<boolean>(
        stores,
        'texra.model.gpt5ReasoningSummary',
      ),
      serverState: yield* readSettingFrom<boolean>(
        stores,
        'texra.model.useGoogleInteractionsServerState',
      ),
      fastTier: yield* readSettingFrom<boolean>(
        stores,
        'texra.model.openaiFastTier',
      ),
      webSocket: yield* readSettingFrom<boolean>(
        stores,
        GlobalStateKey.WEBSOCKET_OPENAI,
      ),
      // Background delivery, where the binding can carry it, wins over the
      // persistent WebSocket.
      background: yield* backgroundDelivery(
        {
          backgroundCapable: true,
          protocol,
          modelName: config.id,
          agentCategory: input.agentCategory,
        },
        stores,
      ),
      fetch: longRunningModelFetch,
    },
  });
  return {
    modelId: input.modelId,
    config,
    reasoning,
    ...(bound.serviceTier === 'fast' && { serviceTier: 'fast' as const }),
    backend,
    model: bound.model,
    origin: bound.origin,
    route,
    usageRoute: credential.usageRoute,
    ...(credential.route === 'chatgpt-subscription' && credential.plan
      ? { usagePlan: credential.plan }
      : {}),
    contextWindow: config.contextWindow,
    supportsVision: config.capabilities.supportsVision,
    supportsNativePdf: config.capabilities.supportsNativePdf,
    supportsNativeAudio: config.capabilities.supportsNativeAudio,
    supportsForcedToolChoice: bound.forcedToolChoice,
    ...routeKeys(
      [
        config.provider,
        credential.route,
        credential.endpoint,
        credentialFingerprint(credential.route, routeBearer(credential)),
      ],
      config.id,
    ),
    backgroundCapable: bound.background,
    persistentConnection: bound.persistentConnection,
    automaticRetries,
  };
});
