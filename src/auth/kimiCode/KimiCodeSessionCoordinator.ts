/**
 * Host-neutral coordinator for the Kimi Code (Moonshot coding-subscription)
 * OAuth session.
 *
 * Mirrors `CodexSessionCoordinator`: pure state machine over an injected
 * secret-backed storage (one JSON bundle under one key) plus an injected
 * network client, so refresh/expiry logic is unit-testable without the network
 * or a real keychain. Simpler than Codex in two ways: the device poll returns
 * tokens directly (no authorization-code exchange, no PKCE/loopback), and the
 * token carries no JWT claims worth extracting.
 */
import { safeParseJson } from '@common/parsing/safeParseJson';

import { KIMI_CODE_TOKEN_REFRESH_BUFFER_MS } from './kimiCodeConstants';
import { refreshTokens as defaultRefresh } from './kimiCodeOAuthClient';
import {
  KimiCodeAuthError,
  KimiCodeSessionSchema,
  type KimiCodeSession,
  type KimiCodeTokenResponse,
} from './kimiCodeSessionTypes';

/** Secret-backed persistence for the single session bundle. */
export interface KimiCodeSessionStorage {
  get(): Promise<string | undefined>;
  store(value: string): Promise<void>;
  delete(): Promise<void>;
}

/** The network surface the coordinator depends on (injectable for tests). */
export interface KimiCodeOAuthRefreshClient {
  refreshTokens(refreshToken: string): Promise<KimiCodeTokenResponse>;
}

export interface KimiCodeLogger {
  debug?(message: string): void;
  warn?(message: string): void;
}

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

export class KimiCodeSessionCoordinator {
  private readonly storage: KimiCodeSessionStorage;
  private readonly client: KimiCodeOAuthRefreshClient;
  private readonly log?: KimiCodeLogger;
  private readonly now: () => number;
  private refreshInFlight: Promise<KimiCodeSession> | null = null;
  /**
   * Single serialized owner of every session-storage write (login store,
   * sign-out delete, refresh store, fatal-refresh delete). Serializing the
   * writes means a write enqueued after a session replacement can never land
   * before the replacement's own write.
   */
  private sessionMutations: Promise<void> = Promise.resolve();
  private sessionGeneration = 0;

  constructor(init: KimiCodeSessionCoordinatorInit) {
    this.storage = init.storage;
    this.client = init.client ?? { refreshTokens: defaultRefresh };
    this.log = init.log;
    this.now = init.now ?? (() => Date.now());
  }

  /** Load + validate the persisted session, or null if absent/corrupt. */
  async loadSession(): Promise<KimiCodeSession | null> {
    const raw = await this.storage.get();
    if (!raw) return null;
    const parsedJson = safeParseJson(raw);
    if (parsedJson.isErr()) {
      this.log?.warn?.('Kimi Code session storage was not valid JSON; ignoring.');
      return null;
    }
    const result = KimiCodeSessionSchema.safeParse(parsedJson.value);
    if (!result.success) {
      this.log?.warn?.('Kimi Code session bundle failed validation; ignoring.');
      return null;
    }
    return result.data;
  }

  private async storeSession(session: KimiCodeSession): Promise<void> {
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
    session: KimiCodeSession | null;
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
      throw new KimiCodeAuthError(
        'Kimi Code session changed while refreshing. Try again.',
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
    const session = this.buildSession(tokens);
    this.supersedeInFlightRefresh();
    await this.mutateSession(() => this.storeSession(session));
    return session;
  }

  /** Whether a session is within the proactive-refresh window of expiry. */
  isExpiringSoon(session: KimiCodeSession): boolean {
    return this.now() + KIMI_CODE_TOKEN_REFRESH_BUFFER_MS >= session.expiresAtMs;
  }

  /**
   * Return a non-expired access token, refreshing if needed. Throws a
   * KimiCodeAuthError('expired') if not signed in, or ('fatal') if the refresh
   * was rejected (the session is cleared in that case — the user must sign in
   * again).
   */
  async getFreshAccessToken(forceRefresh = false): Promise<string> {
    const session = await this.getFreshSession(forceRefresh);
    return session.accessToken;
  }

  /** Refresh if needed and return the live session. */
  async getFreshSession(forceRefresh = false): Promise<KimiCodeSession> {
    const { generation, session } = await this.loadStableSession();
    if (!session) {
      throw new KimiCodeAuthError(
        'Not signed in with Kimi Code. Run sign-in first.',
        'expired',
      );
    }
    if (!forceRefresh && !this.isExpiringSoon(session)) return session;
    return this.refresh(session, generation);
  }

  private async refresh(
    previous: KimiCodeSession,
    generation: number,
  ): Promise<KimiCodeSession> {
    // Single-flight: concurrent callers await the same refresh.
    if (this.refreshInFlight) return this.refreshInFlight;
    const task = this.performRefresh(previous, generation).finally(() => {
      if (this.refreshInFlight === task) this.refreshInFlight = null;
    });
    this.refreshInFlight = task;
    return task;
  }

  private async performRefresh(
    previous: KimiCodeSession,
    generation: number,
  ): Promise<KimiCodeSession> {
    let tokens: KimiCodeTokenResponse;
    try {
      tokens = await this.client.refreshTokens(previous.refreshToken);
    } catch (error) {
      if (error instanceof KimiCodeAuthError && error.kind === 'fatal') {
        // Revoked / invalid refresh token: drop the dead session unless a
        // newer login/sign-out supersedes it. The check runs inside the
        // serialized mutation, so a slow delete can never erase a login
        // whose store is queued behind it.
        await this.mutateSession(async () => {
          if (generation !== this.sessionGeneration) return;
          this.log?.warn?.('Kimi Code token refresh was rejected; signing out.');
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
