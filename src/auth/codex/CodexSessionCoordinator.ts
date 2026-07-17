/**
 * Host-neutral coordinator for the Codex (ChatGPT-subscription) OAuth session.
 *
 * The refresh/expiry race machinery lives in {@link OAuthSessionCoordinatorBase}
 * (shared with Kimi Code); this class adds the Codex specifics: PKCE/loopback
 * authorize URLs, the authorization-code exchange, and JWT-claims extraction.
 * Stays `vscode`-free; the loopback server, browser-open, and device-code UI
 * live in the host layer and call into here.
 */
import {
  OAuthSessionCoordinatorBase,
  type OAuthSessionLogger,
  type OAuthSessionStorage,
} from '../shared/OAuthSessionCoordinatorBase';
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
import { generateOAuthState, generatePkcePair } from './codexPkce';
import {
  CodexAuthError,
  CodexSessionSchema,
  type CodexSession,
  type CodexTokenResponse,
} from './codexSessionTypes';

/** Secret-backed persistence for the single session bundle. */
export type CodexSessionStorage = OAuthSessionStorage;

/** The network surface the coordinator depends on (injectable for tests). */
export interface CodexOAuthClient {
  exchangeAuthorizationCode(params: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<CodexTokenResponse>;
  refreshTokens(refreshToken: string): Promise<CodexTokenResponse>;
}

export type CodexLogger = OAuthSessionLogger;

export interface CodexSessionStatus {
  signedIn: boolean;
  email?: string;
  accountId?: string;
}

export interface CodexAuthorizeRequest {
  url: string;
  verifier: string;
  state: string;
  redirectUri: string;
}

export interface CodexSessionCoordinatorInit {
  storage: CodexSessionStorage;
  client?: CodexOAuthClient;
  log?: CodexLogger;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export class CodexSessionCoordinator extends OAuthSessionCoordinatorBase<
  CodexSession,
  CodexTokenResponse
> {
  private readonly client: CodexOAuthClient;

  constructor(init: CodexSessionCoordinatorInit) {
    super({
      storage: init.storage,
      log: init.log,
      now: init.now,
      refreshBufferMs: CODEX_TOKEN_REFRESH_BUFFER_MS,
      messages: {
        storageNotJson: 'Codex session storage was not valid JSON; ignoring.',
        bundleInvalid: 'Codex session bundle failed validation; ignoring.',
        notSignedIn: 'Not signed in with ChatGPT. Run sign-in first.',
        changedWhileRefreshing:
          'ChatGPT session changed while refreshing. Try again.',
        refreshRejected: 'Codex token refresh was rejected; signing out.',
      },
    });
    this.client = init.client ?? {
      exchangeAuthorizationCode: defaultExchange,
      refreshTokens: defaultRefresh,
    };
  }

  protected parseSession(value: unknown): CodexSession | null {
    const result = CodexSessionSchema.safeParse(value);
    return result.success ? result.data : null;
  }

  protected refreshTokens(previous: CodexSession): Promise<CodexTokenResponse> {
    return this.client.refreshTokens(previous.refreshToken);
  }

  protected createExpiredError(message: string): Error {
    return new CodexAuthError(message, 'expired');
  }

  protected isFatalRefreshError(error: unknown): boolean {
    return error instanceof CodexAuthError && error.kind === 'fatal';
  }

  /** Whether a session is currently signed in (no network). */
  async getStatus(): Promise<CodexSessionStatus> {
    const session = await this.loadSession();
    if (!session) return { signedIn: false };
    return {
      signedIn: true,
      email: session.email,
      accountId: session.accountId,
    };
  }

  /**
   * Build the authorize URL + PKCE for a loopback login on `port`. The verifier
   * and state must be carried back to {@link completeLoginWithCode}.
   */
  buildAuthorizeRequest(port: number): CodexAuthorizeRequest {
    const pkce = generatePkcePair();
    const state = generateOAuthState();
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
    return { url: url.toString(), verifier: pkce.verifier, state, redirectUri };
  }

  /** Exchange a loopback/manual authorization code for a stored session. */
  async completeLoginWithCode(params: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<CodexSession> {
    const tokens = await this.client.exchangeAuthorizationCode(params);
    return this.replaceSession(this.buildSession(tokens));
  }

  /** Exchange a device-code authorization code for a stored session. */
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

  /** The ChatGPT account id from the current session, if any (no refresh). */
  async getAccountId(): Promise<string | undefined> {
    return (await this.loadSession())?.accountId;
  }

  /** Map a raw token response into the canonical session, preserving prior fields. */
  protected buildSession(
    tokens: CodexTokenResponse,
    previous?: CodexSession,
  ): CodexSession {
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
      expiresAtMs: this.now() + tokens.expires_in * 1000,
      accountId: claims.accountId ?? previous?.accountId,
      email: claims.email ?? previous?.email,
    };
  }
}
