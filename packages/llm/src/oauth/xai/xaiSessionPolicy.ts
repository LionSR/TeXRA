/**
 * The xAI (Grok) OAuth policy for the shared `SubscriptionOAuthCoordinator`: only
 * the authorize URL, claims, and JWT-exp refresh differ from ChatGPT/Codex,
 * so the shared coordinator runs it as is.
 */
import { SubscriptionOAuthError } from '../subscriptionOAuthError.js';
import {
  XAI_AUTHORIZE_URL,
  XAI_CLIENT_ID,
  XAI_PLAN,
  XAI_REFERRER,
  XAI_SCOPE,
  XAI_TOKEN_REFRESH_BUFFER_MS,
  XAI_TOKEN_URL,
  xaiRedirectUri,
} from './xaiConstants.js';
import { decodeXaiJwtClaims } from './xaiJwt.js';
import {
  XaiSessionSchema,
  XaiTokenResponseSchema,
  type XaiSession,
} from './xaiSessionTypes.js';
import type { SubscriptionOAuthPolicy } from '../SubscriptionOAuthCoordinator.js';

export const XAI_POLICY: SubscriptionOAuthPolicy<XaiSession> = {
  sessionSchema: XaiSessionSchema,
  tokenEndpoint: {
    tokenUrl: XAI_TOKEN_URL,
    clientId: XAI_CLIENT_ID,
    tokenResponseSchema: XaiTokenResponseSchema,
  },
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
      throw new SubscriptionOAuthError({
        message: 'OAuth response did not include a refresh token.',
        kind: 'config',
      });
    }
    // Refresh keys off the *access* token. Prefer access JWT exp over
    // id_token.exp (which can outlive the access token). Each token is
    // decoded exactly once here and the email claim reuses that decode.
    // `expires_in` is already normalized to a positive number by
    // XaiTokenResponseSchema, so no second default is applied here.
    const idClaims = tokens.id_token ? decodeXaiJwtClaims(tokens.id_token) : {};
    const accessClaims = decodeXaiJwtClaims(tokens.access_token);
    const expiresAtMs =
      accessClaims.expiresAtMs ?? nowMs + tokens.expires_in * 1000;
    return {
      accessToken: tokens.access_token,
      refreshToken,
      idToken: tokens.id_token ?? previous?.idToken,
      expiresAtMs,
      email: idClaims.email ?? accessClaims.email ?? previous?.email,
    };
  },
};
