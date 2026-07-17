/**
 * Host-neutral coordinator for the Kimi Code (Moonshot coding-subscription)
 * OAuth session.
 *
 * The refresh/expiry race machinery lives in {@link OAuthSessionCoordinatorBase}
 * (shared with Codex). Simpler than Codex in two ways: the device poll returns
 * tokens directly (no authorization-code exchange, no PKCE/loopback), and the
 * token carries no JWT claims worth extracting.
 */
import {
  OAuthSessionCoordinatorBase,
  type OAuthSessionLogger,
  type OAuthSessionStorage,
} from '../shared/OAuthSessionCoordinatorBase';
import { KIMI_CODE_TOKEN_REFRESH_BUFFER_MS } from './kimiCodeConstants';
import { refreshTokens as defaultRefresh } from './kimiCodeOAuthClient';
import {
  KimiCodeAuthError,
  KimiCodeSessionSchema,
  type KimiCodeSession,
  type KimiCodeTokenResponse,
} from './kimiCodeSessionTypes';

/** Secret-backed persistence for the single session bundle. */
export type KimiCodeSessionStorage = OAuthSessionStorage;

/** The network surface the coordinator depends on (injectable for tests). */
export interface KimiCodeOAuthRefreshClient {
  refreshTokens(refreshToken: string): Promise<KimiCodeTokenResponse>;
}

export type KimiCodeLogger = OAuthSessionLogger;

export interface KimiCodeSessionStatus {
  signedIn: boolean;
  accountId?: string;
}

export interface KimiCodeSessionCoordinatorInit {
  storage: KimiCodeSessionStorage;
  client?: KimiCodeOAuthRefreshClient;
  log?: KimiCodeLogger;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export class KimiCodeSessionCoordinator extends OAuthSessionCoordinatorBase<
  KimiCodeSession,
  KimiCodeTokenResponse
> {
  private readonly client: KimiCodeOAuthRefreshClient;

  constructor(init: KimiCodeSessionCoordinatorInit) {
    super({
      storage: init.storage,
      log: init.log,
      now: init.now,
      refreshBufferMs: KIMI_CODE_TOKEN_REFRESH_BUFFER_MS,
      messages: {
        storageNotJson:
          'Kimi Code session storage was not valid JSON; ignoring.',
        bundleInvalid: 'Kimi Code session bundle failed validation; ignoring.',
        notSignedIn: 'Not signed in with Kimi Code. Run sign-in first.',
        changedWhileRefreshing:
          'Kimi Code session changed while refreshing. Try again.',
        refreshRejected: 'Kimi Code token refresh was rejected; signing out.',
      },
    });
    this.client = init.client ?? { refreshTokens: defaultRefresh };
  }

  protected parseSession(value: unknown): KimiCodeSession | null {
    const result = KimiCodeSessionSchema.safeParse(value);
    return result.success ? result.data : null;
  }

  protected refreshTokens(
    previous: KimiCodeSession,
  ): Promise<KimiCodeTokenResponse> {
    return this.client.refreshTokens(previous.refreshToken);
  }

  protected createExpiredError(message: string): Error {
    return new KimiCodeAuthError(message, 'expired');
  }

  protected isFatalRefreshError(error: unknown): boolean {
    return error instanceof KimiCodeAuthError && error.kind === 'fatal';
  }

  /** Whether a session is currently signed in (no network). */
  async getStatus(): Promise<KimiCodeSessionStatus> {
    const session = await this.loadSession();
    if (!session) return { signedIn: false };
    return { signedIn: true, accountId: session.accountId };
  }

  /**
   * Store the token bundle returned by a completed device-code poll. Unlike
   * Codex, the poll result IS the token response — no code exchange follows.
   */
  async completeDeviceLogin(
    tokens: KimiCodeTokenResponse,
  ): Promise<KimiCodeSession> {
    return this.replaceSession(this.buildSession(tokens));
  }

  /** Map a raw token response into the canonical session, preserving prior fields. */
  protected buildSession(
    tokens: KimiCodeTokenResponse,
    previous?: KimiCodeSession,
  ): KimiCodeSession {
    const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
    if (!refreshToken) {
      throw new KimiCodeAuthError(
        'OAuth response did not include a refresh token.',
        'fatal',
      );
    }
    return {
      accessToken: tokens.access_token,
      refreshToken,
      expiresAtMs: this.now() + tokens.expires_in * 1000,
      accountId: previous?.accountId,
    };
  }
}
