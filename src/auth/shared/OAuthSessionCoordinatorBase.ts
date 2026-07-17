/**
 * Shared race machinery for the subscription OAuth session coordinators
 * (Codex/ChatGPT, Kimi Code): a pure state machine over an injected
 * secret-backed storage (one JSON bundle under one key), so refresh/expiry
 * logic is unit-testable without the network or a real keychain. Stays
 * `vscode`-free. Subclasses supply the provider specifics only: session-schema
 * parse, the refresh network call, session construction, the fatal-error
 * predicate, and user-facing message strings.
 */
import { safeParseJson } from '@common/parsing/safeParseJson';

/** Secret-backed persistence for the single session bundle. */
export interface OAuthSessionStorage {
  get(): Promise<string | undefined>;
  store(value: string): Promise<void>;
  delete(): Promise<void>;
}

export interface OAuthSessionLogger {
  debug?(message: string): void;
  warn?(message: string): void;
}

/** Provider-specific wording used by the shared machinery. */
interface OAuthSessionMessages {
  /** Log warning when the stored bundle is not valid JSON. */
  storageNotJson: string;
  /** Log warning when the stored bundle fails schema validation. */
  bundleInvalid: string;
  /** 'expired' error when no session is stored. */
  notSignedIn: string;
  /** 'expired' error when a refresh was superseded by login/sign-out. */
  changedWhileRefreshing: string;
  /** Log warning when a fatal refresh clears the session. */
  refreshRejected: string;
}

interface OAuthSessionCoordinatorBaseInit {
  storage: OAuthSessionStorage;
  log?: OAuthSessionLogger;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  /** Proactive-refresh window before token expiry. */
  refreshBufferMs: number;
  messages: OAuthSessionMessages;
}

export abstract class OAuthSessionCoordinatorBase<
  TSession extends {
    accessToken: string;
    refreshToken: string;
    expiresAtMs: number;
  },
  TTokens,
> {
  protected readonly now: () => number;
  private readonly storage: OAuthSessionStorage;
  private readonly log?: OAuthSessionLogger;
  private readonly refreshBufferMs: number;
  private readonly messages: OAuthSessionMessages;
  private refreshInFlight: Promise<TSession> | null = null;
  /**
   * Single serialized owner of every session-storage write (login store,
   * sign-out delete, refresh store, fatal-refresh delete). Serializing the
   * writes means a write enqueued after a session replacement can never land
   * before the replacement's own write.
   */
  private sessionMutations: Promise<void> = Promise.resolve();
  private sessionGeneration = 0;

  protected constructor(init: OAuthSessionCoordinatorBaseInit) {
    this.storage = init.storage;
    this.log = init.log;
    this.now = init.now ?? (() => Date.now());
    this.refreshBufferMs = init.refreshBufferMs;
    this.messages = init.messages;
  }

  /** Parse an already-JSON-decoded bundle via the provider schema, or null. */
  protected abstract parseSession(value: unknown): TSession | null;

  /** The provider's refresh-token network call. */
  protected abstract refreshTokens(previous: TSession): Promise<TTokens>;

  /** Map a raw token response into the canonical session, preserving prior fields. */
  protected abstract buildSession(
    tokens: TTokens,
    previous?: TSession,
  ): TSession;

  /** The provider's 'expired' auth error (not signed in / superseded refresh). */
  protected abstract createExpiredError(message: string): Error;

  /** Whether a refresh rejection is fatal (revoked / invalid refresh token). */
  protected abstract isFatalRefreshError(error: unknown): boolean;

  /** Load + validate the persisted session, or null if absent/corrupt. */
  async loadSession(): Promise<TSession | null> {
    const raw = await this.storage.get();
    if (!raw) return null;
    const parsedJson = safeParseJson(raw);
    if (parsedJson.isErr()) {
      this.log?.warn?.(this.messages.storageNotJson);
      return null;
    }
    const session = this.parseSession(parsedJson.value);
    if (!session) {
      this.log?.warn?.(this.messages.bundleInvalid);
      return null;
    }
    return session;
  }

  private async storeSession(session: TSession): Promise<void> {
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
    session: TSession | null;
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
      throw this.createExpiredError(this.messages.changedWhileRefreshing);
    }
  }

  /** Forget the session (sign out). */
  async signOut(): Promise<void> {
    this.supersedeInFlightRefresh();
    await this.mutateSession(() => this.storage.delete());
  }

  /**
   * Replace the stored session after a completed login: supersede any
   * in-flight refresh and enqueue the store in the same synchronous block.
   */
  protected async replaceSession(session: TSession): Promise<TSession> {
    this.supersedeInFlightRefresh();
    await this.mutateSession(() => this.storeSession(session));
    return session;
  }

  /** Whether a session is within the proactive-refresh window of expiry. */
  isExpiringSoon(session: TSession): boolean {
    return this.now() + this.refreshBufferMs >= session.expiresAtMs;
  }

  /**
   * Return a non-expired access token, refreshing if needed. Throws the
   * provider's auth error ('expired') if not signed in, or ('fatal') if the
   * refresh was rejected (the session is cleared in that case — the user must
   * sign in again).
   */
  async getFreshAccessToken(forceRefresh = false): Promise<string> {
    const session = await this.getFreshSession(forceRefresh);
    return session.accessToken;
  }

  /** Refresh if needed and return the live session. */
  async getFreshSession(forceRefresh = false): Promise<TSession> {
    const { generation, session } = await this.loadStableSession();
    if (!session) {
      throw this.createExpiredError(this.messages.notSignedIn);
    }
    if (!forceRefresh && !this.isExpiringSoon(session)) return session;
    return this.refresh(session, generation);
  }

  private async refresh(
    previous: TSession,
    generation: number,
  ): Promise<TSession> {
    // Single-flight: concurrent callers await the same refresh.
    if (this.refreshInFlight) return this.refreshInFlight;
    const task = this.performRefresh(previous, generation).finally(() => {
      if (this.refreshInFlight === task) this.refreshInFlight = null;
    });
    this.refreshInFlight = task;
    return task;
  }

  private async performRefresh(
    previous: TSession,
    generation: number,
  ): Promise<TSession> {
    let tokens: TTokens;
    try {
      tokens = await this.refreshTokens(previous);
    } catch (error) {
      if (this.isFatalRefreshError(error)) {
        // Revoked / invalid refresh token: drop the dead session unless a
        // newer login/sign-out supersedes it. The check runs inside the
        // serialized mutation, so a slow delete can never erase a login
        // whose store is queued behind it.
        await this.mutateSession(async () => {
          if (generation !== this.sessionGeneration) return;
          this.log?.warn?.(this.messages.refreshRejected);
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
}
