/**
 * Host-neutral coordinator for the xAI (Grok) OAuth session.
 *
 * Thin policy over {@link SubscriptionOAuthCoordinator} — only authorize URL,
 * claims, and JWT-exp refresh differ from ChatGPT/Codex.
 */
import { wrapProviderOAuthClient } from '../oauth/providerAuthBridge';
import {
  SubscriptionOAuthCoordinator,
  type SubscriptionOAuthClient,
  type SubscriptionOAuthPolicy,
  type SubscriptionSessionStatus,
  type SubscriptionSessionStorage,
} from '../oauth/SubscriptionOAuthCoordinator';
import {
  XAI_AUTHORIZE_URL,
  XAI_CLIENT_ID,
  XAI_DEFAULT_EXPIRES_IN_SEC,
  XAI_PLAN,
  XAI_REFERRER,
  XAI_SCOPE,
  XAI_TOKEN_REFRESH_BUFFER_MS,
  xaiRedirectUri,
} from './xaiConstants';
import { decodeXaiJwtClaims } from './xaiJwt';
import {
  exchangeAuthorizationCode as defaultExchange,
  refreshTokens as defaultRefresh,
} from './xaiOAuthClient';
import { XaiAuthError, XaiSessionSchema, type XaiSession } from './xaiSessionTypes';

export type XaiSessionStorage = SubscriptionSessionStorage;
export type XaiOAuthClient = SubscriptionOAuthClient;
export type XaiSessionStatus = SubscriptionSessionStatus;

export interface XaiSessionCoordinatorInit {
  storage: XaiSessionStorage;
  client?: XaiOAuthClient;
  now?: () => number;
}

const XAI_POLICY: SubscriptionOAuthPolicy<XaiSession> = {
  sessionSchema: XaiSessionSchema,
  refreshBufferMs: XAI_TOKEN_REFRESH_BUFFER_MS,
  notSignedInMessage: 'Not signed in with Grok. Run sign-in first.',
  sessionChangedMessage: 'Grok session changed while refreshing. Try again.',
  // xAI pins one redirect port; the loopback bind uses that port and we ignore
  // the parameter for the authorize URL construction.
  // CSRF is covered by `state` on the loopback callback. We do not send an
  // OIDC `nonce` unless we also verify it against `id_token` (we don't).
  buildAuthorizeRequest(_port, pkce, state) {
    const redirectUri = xaiRedirectUri();
    const url = new URL(XAI_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', XAI_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', XAI_SCOPE);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', pkce.method);
    url.searchParams.set('state', state);
    url.searchParams.set('plan', XAI_PLAN);
    url.searchParams.set('referrer', XAI_REFERRER);
    return {
      url: url.toString(),
      verifier: pkce.verifier,
      state,
      redirectUri,
    };
  },
  buildSession(tokens, nowMs, previous) {
    const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
    if (!refreshToken) {
      throw new XaiAuthError(
        'OAuth response did not include a refresh token.',
        'config',
      );
    }
    // Refresh keys off the *access* token. Prefer access JWT exp over
    // id_token.exp (which can outlive the access token). Decode each token
    // once; do not use extractXaiClaims (email-only and would re-decode).
    const idClaims = tokens.id_token ? decodeXaiJwtClaims(tokens.id_token) : {};
    const accessClaims = decodeXaiJwtClaims(tokens.access_token);
    const expiresInSec = tokens.expires_in ?? XAI_DEFAULT_EXPIRES_IN_SEC;
    const expiresAtMs = accessClaims.expiresAtMs ?? nowMs + expiresInSec * 1000;
    return {
      accessToken: tokens.access_token,
      refreshToken,
      idToken: tokens.id_token ?? previous?.idToken,
      expiresAtMs,
      email: idClaims.email ?? accessClaims.email ?? previous?.email,
    };
  },
};

export class XaiSessionCoordinator extends SubscriptionOAuthCoordinator<XaiSession> {
  constructor(init: XaiSessionCoordinatorInit) {
    const client = init.client ?? {
      exchangeAuthorizationCode: defaultExchange,
      refreshTokens: defaultRefresh,
    };
    super({
      storage: init.storage,
      policy: XAI_POLICY,
      client: wrapProviderOAuthClient(client, XaiAuthError),
      now: init.now,
      errorType: XaiAuthError,
    });
  }
}
