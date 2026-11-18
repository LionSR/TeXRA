/**
 * Node.js entry of `@texra-ai/llm`: binding a catalog model to its wire
 * protocol (`bindModel`) and running subscription OAuth sign-in flows.
 *
 * > **Guide:** Read [Model Layer (`@texra-ai/llm`)](/api/model-layer) for a
 * > complete `selectModel` $\to$ `bindModel` $\to$ `prepareTurn` $\to$
 * > `streamTurn` example.
 *
 * ### Key exports by role
 *
 * - **Protocol binding**: [`bindModel`](#bindmodel), [`BindSpec`](#bindspec),
 *   [`Binding`](#binding) dynamically load only the requested protocol
 *   (`anthropic-messages`, `openai-responses`, `google-interactions`), manage
 *   scoped connections and file uploads in the caller's `Scope`, and classify
 *   provider failures into `ModelError`.
 * - **Subscription sign-in (`chatgpt`, `xai`)**: each subscription's
 *   account, keyed by its route
 *   ([`SubscriptionAccounts`](#subscriptionaccounts)), which runs its own
 *   browser and (Grok's) device-code sign-in.
 * - **Plan usage**: [`fetchPlanUsage`](#fetchplanusage) reads a coding
 *   plan's quota windows from its provider.
 */
import { Effect, type Scope } from 'effect';
import { ModelError, type BillingRoute } from './errors.js';
import { originOf, type ModelOrigin } from './protocol.js';
import type { ModelConfig } from 'llm-zoo';

import type { CredentialRoute } from './models/modelRoute.js';
import type { ReasoningChoice } from './models/reasoningChoice.js';
import type { Model, ModelConfiguration } from './turn.js';

/**
 * A subscription session's token, which the caller renews: read before
 * every request, and, when the provider rejects the one sent (a 401 before
 * its stored expiry), handed back as `rejected` once, after which the
 * request goes again on the next `current`. A rejected request was not
 * billed. The Responses protocol alone takes one.
 */
export interface SessionToken {
  readonly current: Effect.Effect<string, ModelError>;
  readonly rejected: (token: string) => Effect.Effect<void, ModelError>;
}

/**
 * One model on one decided route, and what the caller asks of it. The
 * protocol is the model's provider's, and the route fixes the config it runs
 * (`routeConfig`), the endpoint it sends to, the credential scope stamped on
 * its origin and the plan it bills.
 */
export interface BindSpec {
  /** The llm-zoo entry, before its route's overrides. */
  readonly model: ModelConfig;
  readonly route: CredentialRoute;
  /**
   * The token the binding sends: an API key (or any bearer token the
   * endpoint takes as one), or a subscription plan's session token. Which
   * plan's request rules apply is the route's `plan`.
   */
  readonly bearer: string | SessionToken;
  /** Each option has a default; the booleans default to `false`. */
  readonly options?: {
    /** The output ceiling, before the model's own rules; the catalog's by default. */
    readonly maxOutputTokens?: number;
    /** The sampling temperature where the model takes one; the provider's own by default. */
    readonly temperature?: number;
    /** The model's default reasoning (`chooseReasoning`) unless given. */
    readonly reasoning?: ReasoningChoice;
    /** Google keeps the conversation server-side. */
    readonly serverState?: boolean;
    /** OpenAI's fast service tier, where the model offers it. */
    readonly fastTier?: boolean;
    /** The caller would serve Responses over its WebSocket. */
    readonly webSocket?: boolean;
    /** The caller would deliver turns as background work; it wins over the socket. */
    readonly background?: boolean;
    /** The fetch every HTTP request goes through. */
    readonly fetch?: typeof fetch;
  };
}

/** A bound model and the facts its configuration fixed. */
export interface Binding {
  readonly model: Model;
  readonly origin: ModelOrigin;
  /**
   * The config the model runs and bills with on its route: its window, its
   * prices, and the media its route carries (`capabilities`).
   */
  readonly config: ModelConfig;
  /** The route the binding bills through. */
  readonly billing: BillingRoute;
  /** The output limit a turn takes unless it asks for less; null where the route takes none. */
  readonly maxOutputTokens: number | null;
  readonly serviceTier: 'fast' | null;
  /** The route takes a tool choice naming one function. */
  readonly forcedToolChoice: boolean;
}

/** The key of a non-Responses protocol: only a fixed API key serves one. */
const fixedKey = (bearer: string | SessionToken, protocol: string) =>
  typeof bearer === 'string'
    ? Effect.succeed(bearer)
    : Effect.fail(
        new ModelError({
          kind: 'invalid-request',
          message: `A subscription session token cannot authenticate the ${protocol} protocol.`,
        }),
      );

/** The model one configuration builds, over its protocol's module. */
const construct = Effect.fn('llm.construct')(function* (
  configuration: ModelConfiguration,
  bearer: string | SessionToken,
  webSocket: boolean,
  fetch: typeof globalThis.fetch | undefined,
): Effect.fn.Return<Model, ModelError, Scope.Scope> {
  switch (configuration.protocol) {
    case 'anthropic-messages': {
      const apiKey = yield* fixedKey(bearer, configuration.protocol);
      const { anthropicMessagesModel } = yield* Effect.promise(
        () => import('./api/anthropicMessages.js'),
      );
      return yield* anthropicMessagesModel(configuration, { apiKey, fetch });
    }
    case 'google-interactions': {
      const apiKey = yield* fixedKey(bearer, configuration.protocol);
      const { googleInteractionsModel } = yield* Effect.promise(
        () => import('./api/googleInteractions.js'),
      );
      return yield* googleInteractionsModel(configuration, { apiKey, fetch });
    }
    case 'openai-responses': {
      if (webSocket) {
        const { openaiResponsesWebSocketModel } = yield* Effect.promise(
          () => import('./api/openaiResponsesWebSocket.js'),
        );
        return yield* openaiResponsesWebSocketModel(configuration, bearer);
      }
      const { openaiResponsesModel } = yield* Effect.promise(
        () => import('./api/openaiResponses.js'),
      );
      return yield* openaiResponsesModel(configuration, { bearer, fetch });
    }
  }
});

/**
 * Bind one model. The vendor rules and the failure verdicts load on demand,
 * like the protocol modules. The connection, and the files the model
 * uploads, live in the caller's scope: an upload the provider will not
 * confirm deleted is logged and left to its own expiry.
 */
export const bindModel = Effect.fn('llm.bindModel')(function* (
  spec: BindSpec,
): Effect.fn.Return<Binding, ModelError, Scope.Scope> {
  const [wire, { judgedModel }] = yield* Effect.promise(() =>
    Promise.all([import('./api/configuration.js'), import('./api/verdict.js')]),
  );
  const { config, options, configuration } = yield* Effect.fromResult(
    wire.configurationFor(spec),
  );
  const model = yield* construct(
    configuration,
    spec.bearer,
    wire.servesWebSocket(options, configuration),
    options.fetch,
  );
  const { route } = spec;
  const billing = route.plan ?? 'api-key';
  return {
    model: judgedModel(model, billing),
    origin: originOf(configuration),
    config,
    billing,
    maxOutputTokens: configuration.defaults.maxOutputTokens,
    serviceTier:
      configuration.protocol === 'openai-responses'
        ? configuration.defaults.serviceTier
        : null,
    forcedToolChoice: wire.forcedToolChoice(configuration, config),
  };
});

export { SubscriptionOAuthError } from './oauth/subscriptionOAuthError.js';
export type { SubscriptionDeviceCodePrompt } from './oauth/deviceAuthorization.js';
export { LoopbackTransportUnavailableError } from './oauth/loopbackLogin.js';
export type {
  SubscriptionCoordinator,
  SubscriptionSession,
  SubscriptionSessionStatus,
} from './oauth/subscriptionCoordinator.js';
export type { ChatgptSession } from './oauth/chatgpt/chatgptProvider.js';
export type { XaiSession } from './oauth/xai/xaiProvider.js';
export { SubscriptionAccounts } from './oauth/subscriptionAccounts.js';

// Provider endpoints outside the turn contract.
export { fetchPlanUsage } from './providers/planUsage.js';
export type {
  PlanUsage,
  PlanUsageRequest,
  PlanUsageWindow,
} from './providers/planUsage.js';
