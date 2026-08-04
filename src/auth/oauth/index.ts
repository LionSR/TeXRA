/**
 * Shared subscription-OAuth primitives used by ChatGPT/Codex and Grok/xAI.
 * Provider-specific URLs, client ids, and claim extraction stay in
 * `@auth/codex` / `@auth/xai`.
 */
export {
  generateCodeVerifier,
  computeCodeChallenge,
  generatePkcePair,
  generateOAuthState,
  type PkcePair,
} from './pkce';
export {
  SubscriptionOAuthError,
  type SubscriptionOAuthErrorKind,
} from './subscriptionOAuthError';
export {
  loginWithOAuthLoopback,
  type LoopbackAuthorizeRequest,
  type LoopbackOAuthCoordinator,
  type OAuthLoopbackLoginOptions,
} from './loopbackLogin';
export {
  SubscriptionOAuthCoordinator,
  type SubscriptionAuthorizeRequest,
  type SubscriptionOAuthClient,
  type SubscriptionOAuthCoordinatorInit,
  type SubscriptionOAuthPolicy,
  type SubscriptionSession,
  type SubscriptionSessionStatus,
  type SubscriptionSessionStorage,
  type SubscriptionTokenResponse,
} from './SubscriptionOAuthCoordinator';
export {
  getSubscriptionSessionStatus,
  isSubscriptionSessionRoutable,
  type SessionAccessCoordinator,
  type SessionAccessErrorFactory,
} from './sessionAccess';
export {
  rethrowAsProviderAuthError,
  wrapProviderOAuthClient,
  type ProviderAuthError,
  type ProviderAuthErrorCtor,
} from './providerAuthBridge';
export {
  exchangeAuthorizationCode,
  oauthRequestSignal,
  oauthTokenErrorKind,
  parseOAuthJson,
  postOAuthForm,
  refreshOAuthTokens,
  throwOAuthHttpError,
  type OAuthFormEndpoint,
} from './formTokenClient';
export {
  NonEmptyJwtClaim,
  claimsPreferringIdToken,
  decodeJwtClaimsWithSchema,
} from './jwtDecode';
