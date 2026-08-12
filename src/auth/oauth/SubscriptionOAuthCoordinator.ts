/**
 * Host-neutral coordinator for a subscription OAuth session (ChatGPT, Grok, …).
 *
 * Pure state machine over injected secret storage + network client. Provider
 * differences (authorize URL, claim extraction, refresh buffer) live in the
 * {@link SubscriptionOAuthPolicy}; this class owns single-flight refresh,
 * generation supersede, and serialized storage writes.
 */
// Third-party imports
import PQueue from 'p-queue';

// Local imports
import { safeParseJson } from '@common/parsing/safeParseJson';
import * as logger from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { generateOAuthState, generatePkcePair } from './pkce';
import {
  rethrowAsProviderAuthError,
  type ProviderAuthErrorCtor,
} from './providerAuthBridge';
import { SubscriptionOAuthError } from './subscriptionOAuthError';
import type { z } from 'zod';

/** Secret-backed persistence for one session bundle. */
export interface SubscriptionSessionStorage {
  get(): Promise<string | undefined>;
  store(value: string): Promise<void>;
  delete(): Promise<void>;
}

/** Raw token-endpoint shape shared by authorization-code and refresh grants. */
export interface SubscriptionTokenResponse {
  access_token: string;
  refresh_token?: string | null;
  id_token?: string | null;
  expires_in: number;
}

/** Canonical stored session. Providers may add fields via intersection types. */
export interface SubscriptionSession {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAtMs: number;
  email?: string;
  accountId?: string;
}

export interface SubscriptionAuthorizeRequest {
  url: string;
  verifier: string;
  state: string;
  redirectUri: string;
}

export interface SubscriptionOAuthClient {
  exchangeAuthorizationCode(params: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<SubscriptionTokenResponse>;
  refreshTokens(refreshToken: string): Promise<SubscriptionTokenResponse>;
}

export interface SubscriptionSessionStatus {
  signedIn: boolean;
  email?: string;
  accountId?: string;
}

/**
 * Provider-specific policy. Keeps every magic URL/claim out of the shared
 * state machine.
 */
export interface SubscriptionOAuthPolicy<S extends SubscriptionSession> {
  /** Zod schema for the persisted session bundle. */
  readonly sessionSchema: z.ZodType<S>;
  /** Proactive refresh window (ms before expiresAtMs). */
  readonly refreshBufferMs: number;
  readonly notSignedInMessage: string;
  readonly sessionChangedMessage: string;
  /** Build authorize URL for a loopback bind on `port` (ignore if fixed). */
  buildAuthorizeRequest(
    port: number,
    pkce: { verifier: string; challenge: string; method: 'S256' },
    state: string,
  ): SubscriptionAuthorizeRequest;
  /** Map a token response into the stored session. */
  buildSession(
    tokens: SubscriptionTokenResponse,
    nowMs: number,
    previous?: S,
  ): S;
}

export interface SubscriptionOAuthCoordinatorInit<
  S extends SubscriptionSession,
> {
  storage: SubscriptionSessionStorage;
  policy: SubscriptionOAuthPolicy<S>;
  client: SubscriptionOAuthClient;
  now?: () => number;
  /**
   * Provider error type. When set, the public mutating/refreshing methods
   * (signOut, completeLoginWithCode, storeTokens, getFreshSession) rethrow
   * {@link SubscriptionOAuthError} as this type so callers see the provider's
   * own error vocabulary.
   */
  errorType?: ProviderAuthErrorCtor;
}

export class SubscriptionOAuthCoordinator<S extends SubscriptionSession> {
  private readonly storage: SubscriptionSessionStorage;
  private readonly policy: SubscriptionOAuthPolicy<S>;
  private readonly client: SubscriptionOAuthClient;
  private readonly now: () => number;
  private readonly errorType?: ProviderAuthErrorCtor;
  private refreshInFlight: Promise<S> | null = null;
  private readonly sessionMutations = new PQueue({ concurrency: 1 });
  private sessionGeneration = 0;

  constructor(init: SubscriptionOAuthCoordinatorInit<S>) {
    this.storage = init.storage;
    this.policy = init.policy;
    this.client = init.client;
    this.now = init.now ?? (() => Date.now());
    this.errorType = init.errorType;
  }

  /** Map shared-machine errors into the provider error type, when configured. */
  private async mapErrors<T>(op: () => Promise<T>): Promise<T> {
    const ErrorType = this.errorType;
    if (!ErrorType) return op();
    try {
      return await op();
    } catch (error) {
      rethrowAsProviderAuthError(error, ErrorType);
    }
  }

  async loadSession(): Promise<S | null> {
    const raw = await this.storage.get();
    if (!raw) return null;
    const parsedJson = safeParseJson(raw);
    if (parsedJson.isErr()) {
      // Present-but-corrupt is not the same as never signed in.
      logger.warn(
        'SubscriptionOAuth',
        `Stored subscription session is not valid JSON; treating as signed out: ${toErrorMessage(parsedJson.error)}`,
      );
      return null;
    }
    const parsed = this.policy.sessionSchema.safeParse(parsedJson.value);
    if (!parsed.success) {
      logger.warn(
        'SubscriptionOAuth',
        `Stored subscription session failed schema validation; treating as signed out: ${toErrorMessage(parsed.error)}`,
      );
      return null;
    }
    return parsed.data;
  }

  private async storeSession(session: S): Promise<void> {
    await this.storage.store(JSON.stringify(session));
  }

  private mutateSession(op: () => Promise<void>): Promise<void> {
    return this.sessionMutations.add(op);
  }

  private async loadStableSession(): Promise<{
    generation: number;
    session: S | null;
  }> {
    while (true) {
      const generation = this.sessionGeneration;
      await this.sessionMutations.onIdle();
      const session = await this.loadSession();
      if (generation === this.sessionGeneration) {
        return { generation, session };
      }
    }
  }

  private supersedeInFlightRefresh(): void {
    this.sessionGeneration += 1;
    this.refreshInFlight = null;
  }

  /**
   * After a refresh is superseded (concurrent login/sign-out), take a stable
   * storage snapshot and:
   * - return a *replacement* session (different credentials) — concurrent
   *   sign-in succeeded; do not force re-auth;
   * - return a still-fresh same session (rare: supersede without replace);
   * - throw `expired` when storage is empty (sign-out won);
   * - throw `transient` when the pre-refresh session is still the only
   *   stored value and still needs refresh (failed concurrent store, or a
   *   server-rotated refresh that never landed) — never hand back a known-
   *   stale token as if the refresh completed.
   */
  private async sessionAfterSupersede(previous: S): Promise<S> {
    const { session } = await this.loadStableSession();
    if (!session) {
      throw new SubscriptionOAuthError(
        this.policy.sessionChangedMessage,
        'expired',
      );
    }
    const replaced =
      session.accessToken !== previous.accessToken ||
      session.refreshToken !== previous.refreshToken;
    if (replaced || !this.isExpiringSoon(session)) {
      return session;
    }
    throw new SubscriptionOAuthError(
      this.policy.sessionChangedMessage,
      'transient',
    );
  }

  async signOut(): Promise<void> {
    await this.mapErrors(async () => {
      this.supersedeInFlightRefresh();
      await this.mutateSession(() => this.storage.delete());
    });
  }

  async getStatus(): Promise<SubscriptionSessionStatus> {
    const session = await this.loadSession();
    if (!session) return { signedIn: false };
    return {
      signedIn: true,
      email: session.email,
      accountId: session.accountId,
    };
  }

  buildAuthorizeRequest(port: number): SubscriptionAuthorizeRequest {
    const pkce = generatePkcePair();
    const state = generateOAuthState();
    return this.policy.buildAuthorizeRequest(port, pkce, state);
  }

  async completeLoginWithCode(params: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<S> {
    return this.mapErrors(async () => {
      const tokens = await this.client.exchangeAuthorizationCode(params);
      const session = this.policy.buildSession(tokens, this.now());
      this.supersedeInFlightRefresh();
      await this.mutateSession(() => this.storeSession(session));
      return session;
    });
  }

  /** Persist tokens from a successful device-code (or other) grant. */
  async storeTokens(tokens: SubscriptionTokenResponse): Promise<S> {
    return this.mapErrors(async () => {
      const session = this.policy.buildSession(tokens, this.now());
      this.supersedeInFlightRefresh();
      await this.mutateSession(() => this.storeSession(session));
      return session;
    });
  }

  isExpiringSoon(session: S): boolean {
    return this.now() + this.policy.refreshBufferMs >= session.expiresAtMs;
  }

  async getFreshAccessToken(forceRefresh = false): Promise<string> {
    const session = await this.getFreshSession(forceRefresh);
    return session.accessToken;
  }

  async getFreshSession(forceRefresh = false): Promise<S> {
    return this.mapErrors(async () => {
      const { generation, session } = await this.loadStableSession();
      if (!session) {
        throw new SubscriptionOAuthError(
          this.policy.notSignedInMessage,
          'expired',
        );
      }
      if (!forceRefresh && !this.isExpiringSoon(session)) return session;
      return this.refresh(session, generation);
    });
  }

  private async refresh(previous: S, generation: number): Promise<S> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const task = this.performRefresh(previous, generation).finally(() => {
      if (this.refreshInFlight === task) this.refreshInFlight = null;
    });
    this.refreshInFlight = task;
    return task;
  }

  private async performRefresh(previous: S, generation: number): Promise<S> {
    let tokens: SubscriptionTokenResponse;
    try {
      tokens = await this.client.refreshTokens(previous.refreshToken);
    } catch (error) {
      if (error instanceof SubscriptionOAuthError && error.kind === 'fatal') {
        await this.mutateSession(async () => {
          if (generation !== this.sessionGeneration) return;
          await this.storage.delete();
        });
      }
      throw error;
    }
    const session = this.policy.buildSession(tokens, this.now(), previous);
    await this.mutateSession(async () => {
      if (generation !== this.sessionGeneration) return;
      await this.storeSession(session);
    });
    if (generation === this.sessionGeneration) return session;
    return this.sessionAfterSupersede(previous);
  }
}
