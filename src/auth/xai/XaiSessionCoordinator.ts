/**
 * Host-neutral coordinator for the xAI (Grok) OAuth session.
 *
 * Thin policy over {@link SubscriptionOAuthCoordinator} — only authorize URL,
 * claims, and JWT-exp refresh differ from ChatGPT/Codex.
 */
import { generateOAuthState } from '../oauth/pkce';
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
import {
  XaiAuthError,
  XaiSessionSchema,
  type XaiSession,
  type XaiTokenResponse,
} from './xaiSessionTypes';

export type XaiSessionStorage = SubscriptionSessionStorage;
export type XaiOAuthClient = SubscriptionOAuthClient;
export type XaiSessionStatus = SubscriptionSessionStatus;
export type XaiAuthorizeRequest = SubscriptionAuthorizeRequest;

export interface XaiSessionCoordinatorInit {
  storage: XaiSessionStorage;
  client?: XaiOAuthClient;
  now?: () => number;
}

function toXaiError(error: unknown): never {
  rethrowAsProviderAuthError(error, XaiAuthError);
}

const XAI_POLICY: SubscriptionOAuthPolicy<XaiSession> = {
  sessionSchema: XaiSessionSchema,
  refreshBufferMs: XAI_TOKEN_REFRESH_BUFFER_MS,
  notSignedInMessage: 'Not signed in with Grok. Run sign-in first.',
  sessionChangedMessage: 'Grok session changed while refreshing. Try again.',
  // xAI pins one redirect port; the loopback bind uses that port and we ignore
  // the parameter for the authorize URL construction.
  buildAuthorizeRequest(_port, pkce, state) {
    const redirectUri = xaiRedirectUri();
    const nonce = generateOAuthState();
    const url = new URL(XAI_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', XAI_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', XAI_SCOPE);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', pkce.method);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
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

function wrapClient(client: XaiOAuthClient): SubscriptionOAuthClient {
  return wrapProviderOAuthClient(client, XaiAuthError);
}

export class XaiSessionCoordinator {
  private readonly inner: SubscriptionOAuthCoordinator<XaiSession>;

  constructor(init: XaiSessionCoordinatorInit) {
    const client = init.client ?? {
      exchangeAuthorizationCode: defaultExchange,
      refreshTokens: defaultRefresh,
    };
    this.inner = new SubscriptionOAuthCoordinator({
      storage: init.storage,
      policy: XAI_POLICY,
      client: wrapClient(client),
      now: init.now,
    });
  }

  loadSession(): Promise<XaiSession | null> {
    return this.inner.loadSession();
  }

  async signOut(): Promise<void> {
    try {
      await this.inner.signOut();
    } catch (error) {
      toXaiError(error);
    }
  }

  getStatus(): Promise<XaiSessionStatus> {
    return this.inner.getStatus();
  }

  buildAuthorizeRequest(_port?: number): XaiAuthorizeRequest {
    // Port is fixed by the Grok-CLI registration; policy ignores the argument.
    return this.inner.buildAuthorizeRequest(0);
  }

  async completeLoginWithCode(params: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<XaiSession> {
    try {
      return await this.inner.completeLoginWithCode(params);
    } catch (error) {
      toXaiError(error);
    }
  }

  async completeDeviceLogin(tokens: XaiTokenResponse): Promise<XaiSession> {
    try {
      return await this.inner.storeTokens(tokens);
    } catch (error) {
      toXaiError(error);
    }
  }

  isExpiringSoon(session: XaiSession): boolean {
    return this.inner.isExpiringSoon(session);
  }

  async getFreshAccessToken(forceRefresh = false): Promise<string> {
    try {
      return await this.inner.getFreshAccessToken(forceRefresh);
    } catch (error) {
      toXaiError(error);
    }
  }

  async getFreshSession(forceRefresh = false): Promise<XaiSession> {
    try {
      return await this.inner.getFreshSession(forceRefresh);
    } catch (error) {
      toXaiError(error);
    }
  }
}
