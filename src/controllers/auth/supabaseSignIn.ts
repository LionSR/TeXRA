/**
 * The one Supabase (TeXRA account) sign-in state machine, shared by all three
 * hosts.
 *
 * Every host used to carry its own copy: a nonce mint, a pending-record
 * store, a login-CSRF nonce check, an attempt-supersession token, a commit
 * lane and a callback timeout — 1 500 lines of the same machine written three
 * ways, with only the callback transport genuinely differing. This is that
 * machine, written once; a host supplies an {@link AuthCallbackTransport} and
 * nothing else.
 *
 * Lives in `src/controllers/` rather than `src/auth/` for the same reason
 * `subscriptionProviders.ts` beside it does: it composes the auth subsystem
 * with the agent catalog's sign-out invalidation, and `src/auth/**` is fenced
 * off from those. It is the account-plane twin of
 * `SubscriptionSignInPresenter`, which already collapsed the ChatGPT and Grok
 * flow across the same three hosts.
 *
 * The three invariants this file is the single home of:
 *
 * - **One PKCE bind.** {@link PendingOAuthStore.bind} pins the flow the GoTrue
 *   client just minted to the attempt's nonce, and the exchange selects that
 *   flow's verifier slot. Every host binds now; the extension was the only one
 *   that did, and the other two rode auth-js's fixed-verifier fallback.
 * - **One pending-state store.** {@link PendingOAuthStore} over a
 *   {@link PendingOAuthSlots} port — a secret store, a state store, or memory.
 * - **One nonce check.** {@link callbackNonce} plus the claim lane in
 *   {@link SupabaseSignInCoordinator}: a callback completes the attempt whose
 *   nonce it carries, or nothing.
 */
import { randomBytes } from 'node:crypto';

import { Deferred, Effect, Option, Result, type Scope } from 'effect';

import { invalidateRemoteAgentsAfterSignOut } from '@agent/index';
import type { AuthCallbackUriParts } from '@auth/authCallback';
import { refreshRemoteAgentCatalogAfterSignOut } from '@auth/authFlowEffects';
import { callPort, SerializedWrites, settleFailure } from '@auth/authProgram';
import { AUTH_CALLBACK_TIMEOUT_MS, type OAuthProvider } from '@auth/config';
import {
  isPendingOAuthStateFresh,
  OAUTH_NONCE_PATTERN,
  PendingOAuthStateSchema,
  PKCE_FLOW_ID_PATTERN,
  type PendingOAuthState,
} from '@auth/pendingOAuthState';
import { withPkcePermit } from '@auth/pkcePermit';
import type { SupabaseAuthShape } from '@auth/SupabaseAuth';
import type {
  SupabaseSession,
  SupabaseSessionCoordinator,
} from '@auth/SupabaseSession';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import { createLog } from '@logger/logUtils';
import type { ProcessServices } from '@platform/processRuntime';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('supabaseSignIn');

/**
 * Key prefix a durable {@link PendingOAuthSlots} implementation puts its
 * records under, so a store shared with other data can tell them apart and
 * enumerate only its own.
 */
export const PENDING_OAUTH_STATE_PREFIX = 'texra.auth.pendingOAuthState.';

/** The query parameter every host's callback URL carries its nonce in. */
const CALLBACK_NONCE_PARAM = 'app_nonce';

/**
 * Where one host durably keeps its pending sign-in records, keyed by nonce.
 * A record per nonce rather than one blob: on the VS Code host two windows
 * write the same secret store, and a read-modify-write of a shared blob would
 * lose the other window's attempt.
 */
export interface PendingOAuthSlots {
  read(nonce: string): Effect.Effect<string | undefined, unknown>;
  write(nonce: string, value: string): Effect.Effect<void, unknown>;
  erase(nonce: string): Effect.Effect<void, unknown>;
  /** Nonces this host currently holds a record for, for the stale sweep. */
  nonces(): Effect.Effect<readonly string[], unknown>;
}

/** The pending-record store: one implementation, three backing slots. */
export class PendingOAuthStore {
  constructor(private readonly slots: PendingOAuthSlots) {}

  /** The record for `nonce`, or null when there is none worth trusting. */
  read(nonce: string): Effect.Effect<PendingOAuthState | null, unknown> {
    return Effect.map(this.slots.read(nonce), (stored) => {
      if (stored === undefined) return null;
      const parsed = parseJsonWith(stored, PendingOAuthStateSchema);
      if (Result.isFailure(parsed)) {
        // The fixed diagnostic deliberately excludes stored secret content.
        log.warn(
          'Stored OAuth callback state is malformed and will be ignored',
        );
        return null;
      }
      return parsed.success;
    });
  }

  /**
   * The one PKCE bind in the tree: pin the flow the client just minted to this
   * attempt's nonce, so the callback carrying the nonce — in this window, this
   * process, or the next one — exchanges against that flow's verifier slot.
   */
  bind(
    attempt: Pick<PendingOAuthState, 'nonce' | 'createdAt'>,
    flowId: string | null | undefined,
  ): Effect.Effect<void, unknown> {
    if (!flowId || !PKCE_FLOW_ID_PATTERN.test(flowId)) {
      return Effect.fail(
        new Error('OAuth initialization did not return a valid PKCE flow.'),
      );
    }
    if (!isPendingOAuthStateFresh(attempt)) {
      return Effect.fail(
        new Error('Authentication attempt is no longer pending. Try again.'),
      );
    }
    return this.slots.write(
      attempt.nonce,
      JSON.stringify({
        nonce: attempt.nonce,
        createdAt: attempt.createdAt,
        flowId,
      } satisfies PendingOAuthState),
    );
  }

  clear(nonce: string): Effect.Effect<void, unknown> {
    return this.slots.erase(nonce);
  }

  /**
   * Drop records no callback can complete any more. Best effort: a store that
   * cannot be inspected or cleaned says so and the sign-in continues, because
   * a leftover record only expires again on the next sweep.
   */
  sweep(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const nonces = yield* Effect.catchCause(this.slots.nonces(), () =>
        Effect.sync(() => {
          log.warn('Unable to inspect stored OAuth callback state for cleanup');
          return [] as readonly string[];
        }),
      );
      for (const nonce of nonces) {
        yield* Effect.catchCause(
          Effect.gen({ self: this }, function* () {
            const state = yield* this.read(nonce);
            if (!state || !isPendingOAuthStateFresh(state)) {
              yield* this.clear(nonce);
            }
          }),
          () =>
            Effect.sync(() => {
              log.warn('Unable to clean up stored OAuth callback state');
            }),
        );
      }
    });
  }
}

/**
 * The one nonce check. A callback carries exactly one `app_nonce`, shaped like
 * the nonce this process mints; anything else is not ours.
 */
export function callbackNonce(query: string): string | null {
  const values = new URLSearchParams(query).getAll(CALLBACK_NONCE_PARAM);
  if (values.length !== 1 || !OAUTH_NONCE_PATTERN.test(values[0])) return null;
  return values[0];
}

/** Append this attempt's nonce to a host's callback URL. */
export function withCallbackNonce(callbackUrl: string, nonce: string): string {
  const separator = callbackUrl.includes('?') ? '&' : '?';
  return `${callbackUrl}${separator}${CALLBACK_NONCE_PARAM}=${nonce}`;
}

/** What one inbound callback did. */
export type SignInCallbackOutcome =
  | { readonly kind: 'committed'; readonly session: SupabaseSession }
  | { readonly kind: 'ignored'; readonly reason: string }
  | { readonly kind: 'failed'; readonly message: string };

/** One attempt's callback route, as the coordinator hands it to a transport. */
export interface AuthCallbackRoute {
  /** The nonce the attempt's callback URL must carry. */
  readonly nonce: string;
  /**
   * Hand one inbound callback to the coordinator. Never fails: every outcome
   * is a value, so a transport can word its own response to the browser.
   */
  readonly accept: (
    uri: AuthCallbackUriParts,
  ) => Effect.Effect<SignInCallbackOutcome, never, ProcessServices>;
}

/**
 * The only host-specific half of a TeXRA account sign-in: how this host is
 * reachable from a browser, how it shows the consent URL, and what it says
 * about a callback nobody is waiting on.
 */
export interface AuthCallbackTransport {
  /**
   * Open this host's callback route for one attempt and answer the URL GoTrue
   * must redirect to. Scoped: the route is armed before anything else in the
   * attempt runs — a browser redirect cannot outrun it — and torn down when
   * the attempt's scope closes.
   */
  open(
    route: AuthCallbackRoute,
  ): Effect.Effect<string, unknown, Scope.Scope>;
  /**
   * Show (and normally open) the consent URL. Raced against the callback, so
   * a host may block on a browser-choice dialog without stalling a sign-in
   * that has already completed.
   */
  presentSignInUrl(url: string): Effect.Effect<void, unknown>;
  /**
   * Word a callback that completed with no attempt of this process waiting on
   * it: a deep link claimed by another window, or one delivered to a process
   * that started for it.
   */
  announce(
    outcome: SignInCallbackOutcome,
  ): Effect.Effect<void, never, ProcessServices>;
}

/**
 * One sign-in attempt. Object identity is the ownership token: every step
 * that can commit or clear auth state re-checks it, so a superseded attempt
 * can neither store its session nor cancel the newer one.
 */
interface SignInAttempt {
  readonly nonce: string;
  readonly createdAt: number;
  /**
   * Settled once: the committed session, `null` when the attempt was
   * superseded or cancelled, or the callback's failure.
   */
  readonly outcome: Deferred.Deferred<SupabaseSession | null, unknown>;
}

/** What a host asks for when it starts one interactive sign-in. */
export interface SupabaseSignInRequest {
  readonly provider: OAuthProvider;
  /** Extra `/authorize` parameters (account selection, login hint). */
  readonly queryParams?: Record<string, string>;
  /** Override the shared callback deadline; the CLI's `--timeout` uses it. */
  readonly timeoutMs?: number;
}

export interface SupabaseSignInCoordinatorOptions {
  /** The account plane the composition root built. */
  readonly auth: SupabaseAuthShape;
  readonly store: PendingOAuthStore;
  readonly transport: AuthCallbackTransport;
}

/**
 * The sign-in state machine. A host constructs one per account plane and runs
 * its programs at its own edge, where a cancellation signal becomes fiber
 * interruption.
 */
export class SupabaseSignInCoordinator {
  /** Serializes session-storage commits, and gives the drain barrier. */
  private readonly commits = new SerializedWrites();
  /** Serializes callback claims, so two windows cannot claim one attempt. */
  private readonly claims = new SerializedWrites();
  private active: SignInAttempt | undefined;

  constructor(private readonly options: SupabaseSignInCoordinatorOptions) {}

  private get session(): SupabaseSessionCoordinator {
    return this.options.auth.coordinator;
  }

  /** Whether an attempt of this process is still awaiting its callback. */
  get hasPendingSignIn(): boolean {
    return this.active !== undefined && isPendingOAuthStateFresh(this.active);
  }

  /**
   * One interactive sign-in: arm the callback route, initialize the PKCE
   * flow, bind it, show the consent URL, and wait for the callback that
   * carries this attempt's nonce. Fails with the attempt's own error, whose
   * `message` is the user-facing text.
   */
  signIn(
    request: SupabaseSignInRequest,
  ): Effect.Effect<SupabaseSession, unknown, ProcessServices> {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        const attempt = this.claim();
        return yield* this.runAttempt(attempt, request).pipe(
          Effect.ensuring(this.release(attempt)),
        );
      }),
    );
  }

  /**
   * One inbound callback, from whichever transport delivered it. Never fails:
   * the transport gets the outcome as a value and words its own response.
   */
  acceptCallback(
    uri: AuthCallbackUriParts,
  ): Effect.Effect<SignInCallbackOutcome, never, ProcessServices> {
    const nonce = callbackNonce(uri.query ?? '');
    return this.processCallback(uri, nonce).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const error = settleFailure(cause);
          const message = toErrorMessage(error);
          log.error(`Error processing OAuth callback: ${message}`);
          const attempt = this.attemptFor(nonce);
          if (attempt) {
            Deferred.doneUnsafe(attempt.outcome, Effect.fail(error));
          }
          return { kind: 'failed', message } as const;
        }),
      ),
    );
  }

  /**
   * Abandon the outstanding attempt, if any. Synchronous invalidation (so it
   * cannot slip behind a caller's fiber scheduling) plus the program that
   * clears its record.
   */
  cancel(): Effect.Effect<void> {
    const abandoned = this.active;
    this.invalidate();
    return abandoned ? this.clearRecord(abandoned.nonce) : Effect.void;
  }

  /**
   * Clear the stored session and refresh the local agent catalog. Answers
   * whether a session was actually signed out. Host UI is the caller's.
   */
  signOut(): Effect.Effect<boolean, unknown, ProcessServices> {
    return Effect.gen({ self: this }, function* () {
      yield* this.cancel();
      const signedIn = yield* this.commits.run(
        Effect.gen({ self: this }, function* () {
          const session = yield* this.session.loadSession();
          yield* this.session.clearSession();
          return session !== null;
        }),
      );
      yield* refreshRemoteAgentCatalogAfterSignOut(
        invalidateRemoteAgentsAfterSignOut(),
        (message) => log.warn(message),
      );
      return signedIn;
    });
  }

  /** One attempt's body. */
  private runAttempt(
    attempt: SignInAttempt,
    request: SupabaseSignInRequest,
  ): Effect.Effect<SupabaseSession, unknown, ProcessServices | Scope.Scope> {
    return Effect.gen({ self: this }, function* () {
      const callbackUrl = yield* this.options.transport.open({
        nonce: attempt.nonce,
        accept: (uri) => this.acceptCallback(uri),
      });

      // Finish any callback commit owned by a superseded attempt before
      // initializing this attempt's PKCE flow.
      yield* this.commits.awaitIdle();
      yield* this.ensureOwned(attempt);
      yield* this.options.store.sweep();
      yield* this.ensureOwned(attempt);

      const { data, error } = yield* withPkcePermit(
        callPort(() =>
          this.options.auth.client.auth.signInWithOAuth({
            provider: request.provider,
            options: {
              redirectTo: callbackUrl,
              ...(request.queryParams && { queryParams: request.queryParams }),
            },
          }),
        ),
      );
      if (error || !data.url) {
        return yield* Effect.fail(
          new Error(
            `OAuth initialization failed: ${error?.message || 'missing auth URL'}. Try again.`,
          ),
        );
      }
      yield* this.ensureOwned(attempt);
      yield* this.options.store.bind(attempt, data.flowId);

      const settled = Deferred.await(attempt.outcome);
      // A completed callback supersedes the launcher result, while a callback
      // failure or cancellation still preempts a stalled launcher.
      yield* Effect.raceFirst(
        this.options.transport.presentSignInUrl(data.url),
        Effect.asVoid(settled),
      );

      const session = yield* settled.pipe(
        Effect.timeoutOption(request.timeoutMs ?? AUTH_CALLBACK_TIMEOUT_MS),
        Effect.flatMap((completed) =>
          Option.isSome(completed)
            ? Effect.succeed(completed.value)
            : Effect.fail(new Error('Authentication timed out. Try again.')),
        ),
      );
      if (!session) {
        return yield* Effect.fail(
          new Error('Authentication cancelled or superseded. Try again.'),
        );
      }
      return session;
    });
  }

  private processCallback(
    uri: AuthCallbackUriParts,
    nonce: string | null,
  ): Effect.Effect<SignInCallbackOutcome, unknown, ProcessServices> {
    return Effect.gen({ self: this }, function* () {
      const claimed = yield* this.claimCallback(nonce);
      if (!claimed) {
        return {
          kind: 'ignored',
          reason: 'the callback did not match a pending sign-in',
        } as const;
      }

      const attempt = this.attemptFor(claimed.nonce);
      if (!attempt && this.active) {
        log.debug(
          'OAuth callback ignored after its sign-in attempt was superseded',
        );
        return { kind: 'ignored', reason: 'superseded' } as const;
      }
      if (!attempt && (yield* this.session.loadSession())) {
        return { kind: 'ignored', reason: 'already signed in' } as const;
      }

      const result = yield* withPkcePermit(
        this.session.createSessionFromCallback(uri, claimed.flowId),
      );
      if (!result.success) {
        const outcome: SignInCallbackOutcome = result.isAuthError
          ? { kind: 'failed', message: result.error }
          : { kind: 'ignored', reason: result.error };
        if (result.isAuthError) {
          log.error(`Sign-in failed: ${result.error}`);
        } else {
          log.debug(`Auth callback ignored: ${result.error}`);
        }
        if (attempt) {
          Deferred.doneUnsafe(
            attempt.outcome,
            result.isAuthError
              ? Effect.fail(new Error(`OAuth error: ${result.error}. Try again.`))
              : Effect.succeed(null),
          );
        } else {
          yield* this.options.transport.announce(outcome);
        }
        return outcome;
      }

      yield* this.commits.run(
        Effect.gen({ self: this }, function* () {
          yield* this.session.storeSession(result.session);
          // The attempt can be superseded at any suspension point. Once it is,
          // the session it just stored must not stay.
          if (attempt && this.active !== attempt) {
            yield* this.session.clearSessionIfCurrent(result.session);
          }
        }),
      );

      const committed: SignInCallbackOutcome = {
        kind: 'committed',
        session: result.session,
      };
      if (attempt) {
        Deferred.doneUnsafe(
          attempt.outcome,
          this.active === attempt
            ? Effect.succeed(result.session)
            : Effect.succeed(null),
        );
      } else {
        log.info(`Sign-in completed for ${result.session.account.label}`);
        yield* this.options.transport.announce(committed);
      }
      return committed;
    });
  }

  /**
   * Claim one callback: the nonce is ours, its record is fresh, and no other
   * delivery of the same callback got there first. Serialized, so two windows
   * cannot both commit one attempt. A store that cannot answer means the
   * callback's ownership is unverifiable, which is the attempt's failure.
   */
  private claimCallback(
    nonce: string | null,
  ): Effect.Effect<PendingOAuthState | null, unknown> {
    return this.claims.run(
      Effect.gen({ self: this }, function* () {
        if (!nonce) {
          log.warn('OAuth callback rejected: invalid or stale attempt binding');
          return null;
        }
        const pending = yield* this.options.store.read(nonce);
        if (
          !pending?.flowId ||
          pending.nonce !== nonce ||
          !isPendingOAuthStateFresh(pending)
        ) {
          if (pending) yield* this.options.store.clear(nonce);
          log.warn('OAuth callback rejected: invalid or stale attempt binding');
          return null;
        }
        yield* this.options.store.clear(nonce);
        return pending;
      }).pipe(
        Effect.catch(() =>
          Effect.fail(
            new Error('OAuth callback state could not be verified. Try again.'),
          ),
        ),
      ),
    );
  }

  private attemptFor(nonce: string | null): SignInAttempt | undefined {
    return nonce && this.active?.nonce === nonce ? this.active : undefined;
  }

  /** Claim a fresh attempt, superseding any outstanding one. */
  private claim(): SignInAttempt {
    this.invalidate();
    const attempt: SignInAttempt = {
      nonce: randomBytes(16).toString('hex'),
      createdAt: Date.now(),
      outcome: Deferred.makeUnsafe<SupabaseSession | null, unknown>(),
    };
    this.active = attempt;
    return attempt;
  }

  private invalidate(): void {
    const attempt = this.active;
    this.active = undefined;
    if (attempt) Deferred.doneUnsafe(attempt.outcome, Effect.succeed(null));
  }

  private ensureOwned(attempt: SignInAttempt): Effect.Effect<void, Error> {
    return this.active === attempt
      ? Effect.void
      : Effect.fail(
          new Error('Authentication attempt was superseded. Try again.'),
        );
  }

  /**
   * Every exit of an attempt — success, failure, or interruption: settle it,
   * drop it if it is still owned, and clear its pending record.
   */
  private release(attempt: SignInAttempt): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.sync(() => {
        Deferred.doneUnsafe(attempt.outcome, Effect.succeed(null));
        if (this.active === attempt) this.active = undefined;
      });
      yield* this.clearRecord(attempt.nonce);
    });
  }

  private clearRecord(nonce: string): Effect.Effect<void> {
    return Effect.catchCause(this.options.store.clear(nonce), (cause) =>
      Effect.sync(() => {
        log.warn(
          `Unable to clean up stored OAuth callback state: ${toErrorMessage(settleFailure(cause))}`,
        );
      }),
    );
  }
}

/** Pending records held for the life of one process (the CLI's sign-in). */
export function memoryPendingOAuthSlots(): PendingOAuthSlots {
  const records = new Map<string, string>();
  return {
    read: (nonce) => Effect.sync(() => records.get(nonce)),
    write: (nonce, value) =>
      Effect.sync(() => {
        records.set(nonce, value);
      }),
    erase: (nonce) =>
      Effect.sync(() => {
        records.delete(nonce);
      }),
    nonces: () => Effect.sync(() => [...records.keys()]),
  };
}
