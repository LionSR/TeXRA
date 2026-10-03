/**
 * `@texra-ai/llm/node` — what runs only in Node: binding a configured model
 * to its wire protocol, and the ChatGPT and Grok sign-in flows.
 *
 * {@link bindModel} owns the choice of protocol. It loads the chosen
 * protocol's module on demand, with a literal `import()`, so a run loads only
 * its own provider's SDK, and nothing in its signature names a protocol
 * module's type: the declarations of this entry reach no vendor SDK.
 */
import { Effect, type Scope } from 'effect';

import { ModelError } from './errors.js';
import type { Model, ModelConfiguration } from './turn.js';

/** A configuration one of the package's HTTP protocols serves. */
export type HttpModelConfiguration = Exclude<
  ModelConfiguration,
  { protocol: 'vscode-lm' }
>;

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

/** How a binding reaches its endpoint. */
export interface ModelTransport {
  /** The fetch every HTTP request goes through. */
  readonly fetch?: typeof fetch;
  /**
   * Serve the Responses protocol over its persistent WebSocket instead of
   * HTTP. The caller decides it (the endpoint must serve the socket);
   * other protocols ignore it.
   */
  readonly webSocket?: boolean;
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

/**
 * The model one configuration binds, over its protocol's module. A
 * WebSocket binding holds its connection in the caller's scope.
 */
export const bindModel = Effect.fn('llm.bindModel')(function* (
  configuration: HttpModelConfiguration,
  credential: ModelCredential,
  transport: ModelTransport = {},
): Effect.fn.Return<Model, ModelError, Scope.Scope> {
  const { fetch } = transport;
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
      if (transport.webSocket) {
        const { openaiResponsesWebSocketModel } = yield* Effect.promise(
          () => import('./api/openaiResponsesWebSocket.js'),
        );
        return yield* openaiResponsesWebSocketModel(configuration, credential);
      }
      const { openaiResponsesModel } = yield* Effect.promise(
        () => import('./api/openaiResponses.js'),
      );
      return yield* constructed(() =>
        openaiResponsesModel(configuration, {
          authentication: credential,
          fetch,
        }),
      );
    }
  }
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
