/**
 * The Codex (ChatGPT-subscription) OAuth policy for the shared
 * `SubscriptionOAuthCoordinator`: the authorize URL and the claims differ
 * from Grok; single-flight refresh, storage races, and error mapping
 * live in the shared machine.
 */
import {
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_ORIGINATOR,
  CODEX_SCOPE,
  CODEX_TOKEN_REFRESH_BUFFER_MS,
  CODEX_TOKEN_URL,
  codexRedirectUri,
} from './codexConstants.js';
import { extractCodexClaims } from './codexJwt.js';
import {
  CodexSessionSchema,
  CodexTokenResponseSchema,
  type CodexSession,
} from './codexSessionTypes.js';
import type { SubscriptionOAuthPolicy } from '../SubscriptionOAuthCoordinator.js';

/** The ChatGPT sign-in policy. */
export const CODEX_POLICY: SubscriptionOAuthPolicy<CodexSession> = {
  sessionSchema: CodexSessionSchema,
  tokenEndpoint: {
    tokenUrl: CODEX_TOKEN_URL,
    clientId: CODEX_CLIENT_ID,
    tokenResponseSchema: CodexTokenResponseSchema,
  },
  refreshBufferMs: CODEX_TOKEN_REFRESH_BUFFER_MS,
  notSignedInMessage: 'Not signed in with ChatGPT. Run sign-in first.',
  sessionChangedMessage: 'ChatGPT session changed while refreshing. Try again.',
  buildAuthorizeRequest(port, pkce, state) {
    const redirectUri = codexRedirectUri(port);
    const url = new URL(CODEX_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CODEX_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', CODEX_SCOPE);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', pkce.method);
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    url.searchParams.set('state', state);
    url.searchParams.set('originator', CODEX_ORIGINATOR);
    return {
      url: url.toString(),
      verifier: pkce.verifier,
      state,
      redirectUri,
    };
  },
  buildSession(tokens, refreshToken, nowMs, previous) {
    const claims = extractCodexClaims(
      tokens.id_token ?? undefined,
      tokens.access_token,
    );
    return {
      accessToken: tokens.access_token,
      refreshToken,
      idToken: tokens.id_token ?? previous?.idToken,
      expiresAtMs: nowMs + tokens.expires_in * 1000,
      accountId: claims.accountId ?? previous?.accountId,
      email: claims.email ?? previous?.email,
      planType: claims.planType ?? previous?.planType,
    };
  },
};
