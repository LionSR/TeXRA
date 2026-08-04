/**
 * Host-neutral coordinator for the Codex (ChatGPT-subscription) OAuth session.
 *
 * Thin policy over {@link SubscriptionOAuthCoordinator}: ChatGPT-specific
 * authorize URL, claims, and device-login redirect live here; single-flight
 * refresh and storage races live in the shared machine.
 */
import {
  rethrowAsProviderAuthError,
  wrapProviderOAuthClient,
} from '../oauth/providerAuthBridge';
import {
  SubscriptionOAuthCoordinator,
  type SubscriptionAuthorizeRequest,
  type SubscriptionOAuthClient,
  type SubscriptionOAuthPolicy,
  type SubscriptionSessionStatus,
  type SubscriptionSessionStorage,
  type SubscriptionTokenResponse,
} from '../oauth/SubscriptionOAuthCoordinator';
import {
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_ORIGINATOR,
  CODEX_SCOPE,
  CODEX_TOKEN_REFRESH_BUFFER_MS,
  codexRedirectUri,
} from './codexConstants';
import { extractCodexClaims } from './codexJwt';
import {
  exchangeAuthorizationCode as defaultExchange,
  refreshTokens as defaultRefresh,
} from './codexOAuthClient';
import {
  CodexAuthError,
  CodexSessionSchema,
  type CodexSession,
  type CodexTokenResponse,
} from './codexSessionTypes';

export type CodexSessionStorage = SubscriptionSessionStorage;
export type CodexOAuthClient = SubscriptionOAuthClient;
export type CodexSessionStatus = SubscriptionSessionStatus;
export type CodexAuthorizeRequest = SubscriptionAuthorizeRequest;

export interface CodexSessionCoordinatorInit {
  storage: CodexSessionStorage;
  client?: CodexOAuthClient;
  now?: () => number;
}

function toCodexError(error: unknown): never {
  rethrowAsProviderAuthError(error, CodexAuthError);
}

const CODEX_POLICY: SubscriptionOAuthPolicy<CodexSession> = {
  sessionSchema: CodexSessionSchema,
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
  buildSession(tokens, nowMs, previous) {
    const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
    if (!refreshToken) {
      throw new CodexAuthError(
        'OAuth response did not include a refresh token.',
        'config',
      );
    }
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
    };
  },
};

/** Map Codex client errors into SubscriptionOAuthError for the shared machine. */
function wrapClient(client: CodexOAuthClient): SubscriptionOAuthClient {
  return wrapProviderOAuthClient(client, CodexAuthError);
}

export class CodexSessionCoordinator {
  private readonly inner: SubscriptionOAuthCoordinator<CodexSession>;

  constructor(init: CodexSessionCoordinatorInit) {
    const client = init.client ?? {
      exchangeAuthorizationCode: defaultExchange,
      refreshTokens: defaultRefresh,
    };
    this.inner = new SubscriptionOAuthCoordinator({
      storage: init.storage,
      policy: CODEX_POLICY,
      client: wrapClient(client),
      now: init.now,
    });
  }

  loadSession(): Promise<CodexSession | null> {
    return this.inner.loadSession();
  }

  async signOut(): Promise<void> {
    try {
      await this.inner.signOut();
    } catch (error) {
      toCodexError(error);
    }
  }

  getStatus(): Promise<CodexSessionStatus> {
    return this.inner.getStatus();
  }

  buildAuthorizeRequest(port: number): CodexAuthorizeRequest {
    return this.inner.buildAuthorizeRequest(port);
  }

  async completeLoginWithCode(params: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<CodexSession> {
    try {
      return await this.inner.completeLoginWithCode(params);
    } catch (error) {
      toCodexError(error);
    }
  }

  async completeDeviceLogin(params: {
    authorizationCode: string;
    codeVerifier: string;
  }): Promise<CodexSession> {
    return this.completeLoginWithCode({
      code: params.authorizationCode,
      verifier: params.codeVerifier,
      redirectUri: CODEX_DEVICE_REDIRECT_URI,
    });
  }

  isExpiringSoon(session: CodexSession): boolean {
    return this.inner.isExpiringSoon(session);
  }

  async getFreshAccessToken(forceRefresh = false): Promise<string> {
    try {
      return await this.inner.getFreshAccessToken(forceRefresh);
    } catch (error) {
      toCodexError(error);
    }
  }

  async getAccountId(): Promise<string | undefined> {
    return (await this.loadSession())?.accountId;
  }

  async getFreshSession(forceRefresh = false): Promise<CodexSession> {
    try {
      return await this.inner.getFreshSession(forceRefresh);
    } catch (error) {
      toCodexError(error);
    }
  }
}
