/**
 * The xAI (Grok) OAuth policy for the shared `SubscriptionOAuthCoordinator`: only
 * the authorize URL, claims, and JWT-exp refresh differ from ChatGPT/Codex,
 * so the shared coordinator runs it as is.
 */
import {
  XAI_AUTHORIZE_URL,
  XAI_CLIENT_ID,
  XAI_PLAN,
  XAI_REFERRER,
  XAI_SCOPE,
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
  notSignedInMessage: 'Not signed in with Grok. Run sign-in first.',
  sessionChangedMessage: 'Grok session changed while refreshing. Try again.',
  // xAI pins one redirect port, so the bind's port is ignored.
  authorize: {
    url: XAI_AUTHORIZE_URL,
    scope: XAI_SCOPE,
    redirectUri: xaiRedirectUri,
    params: { plan: XAI_PLAN, referrer: XAI_REFERRER },
  },
  buildSession(tokens, refreshToken, nowMs, previous) {
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
