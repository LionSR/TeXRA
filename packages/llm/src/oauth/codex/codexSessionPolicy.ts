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
  notSignedInMessage: 'Not signed in with ChatGPT. Run sign-in first.',
  sessionChangedMessage: 'ChatGPT session changed while refreshing. Try again.',
  authorize: {
    url: CODEX_AUTHORIZE_URL,
    scope: CODEX_SCOPE,
    redirectUri: codexRedirectUri,
    params: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: CODEX_ORIGINATOR,
    },
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
