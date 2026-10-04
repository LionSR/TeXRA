/**
 * `@texra-ai/llm/node` — what runs only in Node: binding a catalog model to
 * its wire protocol, and the ChatGPT and Grok sign-in flows.
 *
 * {@link bindModel} owns the wire: it turns a catalog model, its route and
 * plain options into the protocol's configuration, loads the protocol's
 * module on demand with a literal `import()` (a run loads only its own
 * provider's SDK), and judges every failure the model raises against the
 * vendor's reply. Nothing in its signature names a protocol module's type:
 * the declarations of this entry reach no vendor SDK.
 */
import { Effect, type Scope } from 'effect';
import { ModelError } from './errors.js';
import { originOf, type ModelOrigin } from './protocol.js';
import type { ModelConfig } from 'llm-zoo';

import type { HttpModelConfiguration } from './api/configuration.js';
import type { BillingRoute } from './api/verdict.js';
import type { ReasoningChoice } from './models/reasoningChoice.js';
import type { Model } from './turn.js';

/**
 * The credential a binding sends: an API key (or any bearer token the
 * endpoint takes as one), or a ChatGPT (Codex) session token, which also
 * names its account and is served on the Responses protocol only.
 */
export type ModelCredential =
  | { readonly kind: 'api-key'; readonly apiKey: string }
  | {
      readonly kind: 'codex';
      readonly accessToken: string;
      readonly accountId: string | null;
    };

/** One model on one route, and what the caller asks of it. */
export interface BindSpec {
  readonly protocol: HttpModelConfiguration['protocol'];
  /** The llm-zoo entry after `routeConfig`. */
  readonly model: ModelConfig;
  readonly endpoint: string;
  /** A non-secret name of the credential route, stamped on the origin. */
  readonly credentialScope: string;
  readonly credential: ModelCredential;
  /** The route the binding bills through. */
  readonly billing: BillingRoute;
  readonly options: {
    /** The output ceiling, before the model's own rules. */
    readonly maxOutputTokens: number;
    /** The sampling temperature, applied where the model takes one. */
    readonly temperature: number;
    readonly reasoning: ReasoningChoice;
    readonly parallelToolCalls: boolean;
    /** GPT-5 sends a reasoning summary only when asked. */
    readonly reasoningSummary: boolean;
    /** Google keeps the conversation server-side. */
    readonly serverState: boolean;
    /** OpenAI's fast service tier, where the model offers it. */
    readonly fastTier: boolean;
    /** The caller would serve Responses over its WebSocket. */
    readonly webSocket: boolean;
    /** The caller would deliver turns as background work; it wins over the socket. */
    readonly background: boolean;
    /** The fetch every HTTP request goes through. */
    readonly fetch?: typeof fetch;
  };
}

/** A bound model and the facts its configuration fixed. */
export interface Binding {
  readonly model: Model;
  readonly origin: ModelOrigin;
  /** Turns can run as background work (submit and observe). */
  readonly background: boolean;
  /** One connection a failed turn invalidates (the Responses WebSocket). */
  readonly persistentConnection: boolean;
  readonly serviceTier: 'fast' | null;
  /** The route takes a tool choice naming one function. */
  readonly forcedToolChoice: boolean;
}

/** A synchronous protocol factory's refusal, kept as the `ModelError` it is. */
const constructed = (make: () => Model) =>
  Effect.try({
    try: make,
    catch: (cause) =>
      cause instanceof ModelError
        ? cause
        : new ModelError({
            kind: 'invalid-request',
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  });

/** The bearer of a non-Responses protocol: only an API key serves one. */
const bearer = (credential: ModelCredential, protocol: string) =>
  credential.kind === 'api-key'
    ? Effect.succeed(credential.apiKey)
    : Effect.fail(
        new ModelError({
          kind: 'unsupported',
          message: `A ChatGPT session token cannot authenticate the ${protocol} protocol.`,
        }),
      );

/** The model one configuration builds, over its protocol's module. */
const construct = Effect.fn('llm.construct')(function* (
  configuration: HttpModelConfiguration,
  credential: ModelCredential,
  webSocket: boolean,
  fetch: typeof globalThis.fetch | undefined,
): Effect.fn.Return<Model, ModelError, Scope.Scope> {
  switch (configuration.protocol) {
    case 'anthropic-messages': {
      const apiKey = yield* bearer(credential, configuration.protocol);
      const { anthropicMessagesModel } = yield* Effect.promise(
        () => import('./api/anthropicMessages.js'),
      );
      return yield* constructed(() =>
        anthropicMessagesModel(configuration, { apiKey, fetch }),
      );
    }
    case 'google-interactions': {
      const apiKey = yield* bearer(credential, configuration.protocol);
      const { googleInteractionsModel } = yield* Effect.promise(
        () => import('./api/googleInteractions.js'),
      );
      return yield* constructed(() =>
        googleInteractionsModel(configuration, { apiKey, fetch }),
      );
    }
    case 'openrouter-chat': {
      const apiKey = yield* bearer(credential, configuration.protocol);
      const { openrouterChatModel } = yield* Effect.promise(
        () => import('./api/openrouterChat.js'),
      );
      return yield* constructed(() =>
        openrouterChatModel(configuration, { apiKey, fetch }),
      );
    }
    case 'openai-responses': {
      // Named fields only: `ResponseAuthenticationSchema` is a strictObject, so
      // a field added to the credential must not reach its parse.
      const authentication =
        credential.kind === 'api-key'
          ? credential
          : {
              kind: credential.kind,
              accessToken: credential.accessToken,
              accountId: credential.accountId,
            };
      if (webSocket) {
        const { openaiResponsesWebSocketModel } = yield* Effect.promise(
          () => import('./api/openaiResponsesWebSocket.js'),
        );
        return yield* openaiResponsesWebSocketModel(
          configuration,
          authentication,
        );
      }
      const { openaiResponsesModel } = yield* Effect.promise(
        () => import('./api/openaiResponses.js'),
      );
      return yield* constructed(() =>
        openaiResponsesModel(configuration, { authentication, fetch }),
      );
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
  const configuration = wire.configurationFor(spec);
  const webSocket = wire.servesWebSocket(spec, configuration);
  const model = yield* construct(
    configuration,
    spec.credential,
    webSocket,
    spec.options.fetch,
  );
  const { releaseUploads } = model;
  if (releaseUploads !== undefined) {
    yield* Effect.addFinalizer(() =>
      releaseUploads().pipe(
        Effect.flatMap((unreleased) =>
          unreleased.length === 0
            ? Effect.void
            : Effect.logWarning(
                `Could not delete ${unreleased.length} uploaded file(s) when the ${spec.model.label} binding closed; the provider expires them on its own.`,
              ).pipe(Effect.annotateLogs({ unreleased })),
        ),
      ),
    );
  }
  return {
    model: judgedModel(model, spec.billing),
    origin: originOf(configuration),
    background: !webSocket && wire.backgroundCapable(configuration),
    persistentConnection: webSocket,
    serviceTier:
      configuration.protocol === 'openai-responses'
        ? configuration.defaults.serviceTier
        : null,
    forcedToolChoice: wire.forcedToolChoice(configuration, spec.model),
  };
});

export { SubscriptionOAuthError } from './oauth/subscriptionOAuthError.js';
export { AuthPortError, settleFailure } from './oauth/authProgram.js';
export { SharedAttempt } from './oauth/sharedAttempt.js';
export type { SubscriptionDeviceCodePrompt } from './oauth/deviceAuthorization.js';
export { LoopbackTransportUnavailableError } from './oauth/loopbackLogin.js';
export type { SubscriptionSessionStatus } from './oauth/SubscriptionOAuthCoordinator.js';
export { CODEX_BACKEND_BASE_URL } from './oauth/codex/codexConstants.js';
export {
  codexCoordinator,
  getCodexStatus,
} from './oauth/codex/codexAuthAccess.js';
export { codexLoginWithLoopback } from './oauth/codex/codexLoopbackLogin.js';
export { codexLoginWithDeviceCode } from './oauth/codex/codexDeviceLogin.js';
export { xaiCoordinator, getXaiStatus } from './oauth/xai/xaiAuthAccess.js';
export { xaiLoginWithLoopback } from './oauth/xai/xaiLoopbackLogin.js';
export { xaiLoginWithDeviceCode } from './oauth/xai/xaiDeviceLogin.js';
