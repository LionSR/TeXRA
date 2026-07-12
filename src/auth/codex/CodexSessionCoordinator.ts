/**
 * Host-neutral coordinator for the Codex (ChatGPT-subscription) OAuth session.
 *
 * Mirrors the split of `SupabaseSessionCoordinator`: pure state machine over an
 * injected secret-backed storage (one JSON bundle under one key) plus an
 * injected network client, so refresh/expiry logic is unit-testable without the
 * network or a real keychain. Stays `vscode`-free; the loopback server,
 * browser-open, and device-code UI live in the host layer and call into here.
 */
import { safeParseJson } from '@common/parsing/safeParseJson';
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
export interface CodexSessionStorage {
  get(): Promise<string | undefined>;
  store(value: string): Promise<void>;
  delete(): Promise<void>;
}

/** The network surface the coordinator depends on (injectable for tests). */
export interface CodexOAuthClient {
  exchangeAuthorizationCode(params: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<CodexTokenResponse>;
  refreshTokens(refreshToken: string): Promise<CodexTokenResponse>;
}

export interface CodexLogger {
  debug?(message: string): void;
  warn?(message: string): void;
}

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

export class CodexSessionCoordinator {
  private readonly storage: CodexSessionStorage;
  private readonly client: CodexOAuthClient;
  private readonly log?: CodexLogger;
  private readonly now: () => number;
  private refreshInFlight: Promise<CodexSession> | null = null;
  /**
   * Single serialized owner of every session-storage write (login store,
   * sign-out delete, refresh store, fatal-refresh delete). Serializing the
   * writes means a write enqueued after a session replacement can never land
   * before the replacement's own write.
   */
  private sessionMutations: Promise<void> = Promise.resolve();
  private sessionGeneration = 0;

  constructor(init: CodexSessionCoordinatorInit) {
    this.storage = init.storage;
    this.client = init.client ?? {
      exchangeAuthorizationCode: defaultExchange,
      refreshTokens: defaultRefresh,
    };
    this.log = init.log;
    this.now = init.now ?? (() => Date.now());
  }

  /** Load + validate the persisted session, or null if absent/corrupt. */
  async loadSession(): Promise<CodexSession | null> {
    const raw = await this.storage.get();
    if (!raw) return null;
    const parsedJson = safeParseJson(raw);
    if (parsedJson.isErr()) {
      this.log?.warn?.('Codex session storage was not valid JSON; ignoring.');
      return null;
    }
    const result = CodexSessionSchema.safeParse(parsedJson.value);
    if (!result.success) {
      this.log?.warn?.('Codex session bundle failed validation; ignoring.');
      return null;
    }
    return result.data;
  }

  private async storeSession(session: CodexSession): Promise<void> {
    await this.storage.store(JSON.stringify(session));
  }

  /**
   * Chain `op` after every previously queued session-storage write so
   * replacement (login/sign-out) and refresh-originated writes settle in the
   * order they were requested. The chain link is established synchronously
   * (before the first `await`), so ordering is captured at call time.
   */
  private mutateSession(op: () => Promise<void>): Promise<void> {
    const mutation = this.sessionMutations.then(op);
    this.sessionMutations = mutation.catch(() => undefined);
    return mutation;
  }

  /**
   * Read a session only when no replacement changed its generation while the
   * queued writes or storage read were settling.
   */
  private async loadStableSession(): Promise<{
    generation: number;
    session: CodexSession | null;
  }> {
    while (true) {
      const generation = this.sessionGeneration;
      await this.sessionMutations;
      const session = await this.loadSession();
      if (generation === this.sessionGeneration) {
        return { generation, session };
      }
    }
  }

  /**
   * Advance the session generation and abandon any in-flight refresh so its
   * result can no longer overwrite the session that supersedes it. Shared by
   * sign-out and every successful login, which must enqueue their storage
   * write via {@link mutateSession} in the same synchronous block — that way
   * an observed generation implies its write is already in the queue.
   */
  private supersedeInFlightRefresh(): void {
    this.sessionGeneration += 1;
    this.refreshInFlight = null;
  }

  /**
   * Fail an in-flight refresh whose session was superseded (a newer login or
   * sign-out bumped the generation) so it can't resurrect a stale token.
   */
  private assertSameGeneration(generation: number): void {
    if (generation !== this.sessionGeneration) {
      throw new CodexAuthError(
        'ChatGPT session changed while refreshing. Try again.',
        'expired',
      );
    }
  }

  /** Forget the session (sign out). */
  async signOut(): Promise<void> {
    this.supersedeInFlightRefresh();
    await this.mutateSession(() => this.storage.delete());
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
    const session = this.buildSession(tokens);
    this.supersedeInFlightRefresh();
    await this.mutateSession(() => this.storeSession(session));
    return session;
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

  /** Whether a session is within the proactive-refresh window of expiry. */
  isExpiringSoon(session: CodexSession): boolean {
    return this.now() + CODEX_TOKEN_REFRESH_BUFFER_MS >= session.expiresAtMs;
  }

  /**
   * Return a non-expired access token, refreshing if needed. Throws a
   * CodexAuthError('expired') if not signed in, or ('fatal') if the refresh was
   * rejected (the session is cleared in that case — the user must sign in again).
   */
  async getFreshAccessToken(forceRefresh = false): Promise<string> {
    const session = await this.getFreshSession(forceRefresh);
    return session.accessToken;
  }

  /** The ChatGPT account id from the current session, if any (no refresh). */
  async getAccountId(): Promise<string | undefined> {
    return (await this.loadSession())?.accountId;
  }

  /** Refresh if needed and return the live session. */
  async getFreshSession(forceRefresh = false): Promise<CodexSession> {
    const { generation, session } = await this.loadStableSession();
    if (!session) {
      throw new CodexAuthError(
        'Not signed in with ChatGPT. Run sign-in first.',
        'expired',
      );
    }
    if (!forceRefresh && !this.isExpiringSoon(session)) return session;
    return this.refresh(session, generation);
  }

  private async refresh(
    previous: CodexSession,
    generation: number,
  ): Promise<CodexSession> {
    // Single-flight: concurrent callers await the same refresh.
    if (this.refreshInFlight) return this.refreshInFlight;
    const task = this.performRefresh(previous, generation).finally(() => {
      if (this.refreshInFlight === task) this.refreshInFlight = null;
    });
    this.refreshInFlight = task;
    return task;
  }

  private async performRefresh(
    previous: CodexSession,
    generation: number,
  ): Promise<CodexSession> {
    let tokens: CodexTokenResponse;
    try {
      tokens = await this.client.refreshTokens(previous.refreshToken);
    } catch (error) {
      if (error instanceof CodexAuthError && error.kind === 'fatal') {
        // Revoked / invalid refresh token: drop the dead session unless a
        // newer login/sign-out supersedes it. The check runs inside the
        // serialized mutation, so a slow delete can never erase a login
        // whose store is queued behind it.
        await this.mutateSession(async () => {
          if (generation !== this.sessionGeneration) return;
          this.log?.warn?.('Codex token refresh was rejected; signing out.');
          await this.storage.delete();
        });
      }
      throw error;
    }
    const session = this.buildSession(tokens, previous);
    await this.mutateSession(async () => {
      this.assertSameGeneration(generation);
      await this.storeSession(session);
    });
    // Superseded while the store settled: the superseding write is queued
    // after ours (so storage converges), but this caller must not hand out
    // a token from the replaced session.
    this.assertSameGeneration(generation);
    return session;
  }

  /** Map a raw token response into the canonical session, preserving prior fields. */
  private buildSession(
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
