/**
 * The one Supabase (TeXRA account) sign-in state machine, shared by all three
 * hosts.
 *
 * Every host used to carry its own copy: an attempt nonce, an ownership
 * token, a claim lane, a commit lane and a callback deadline, written three
 * ways although only the callback transport genuinely differs. This is that
 * machine, written once; a host supplies an {@link AuthCallbackTransport} and
 * nothing else. The record store and the login-CSRF nonce check it composes
 * live beside it in `pendingOAuthStore.ts`.
 *
 * Lives in `src/controllers/` rather than `src/auth/` for the same reason
 * `subscriptionProviders.ts` does: it composes the auth subsystem with the
 * agent catalog's sign-out invalidation, and `src/auth/**` is fenced off from
 * that. It is the account-plane twin of `SubscriptionSignInPresenter`, which
 * already collapsed the ChatGPT and Grok flow across the same three hosts.
 */
import { Deferred, Effect, Option, type Scope } from 'effect';

import { invalidateRemoteAgentsAfterSignOut } from '@agent/index';
import type { AuthCallbackUriParts } from '@auth/authCallback';
import { refreshRemoteAgentCatalogAfterSignOut } from '@auth/authFlowEffects';
import { callPort, SerializedWrites, settleFailure } from '@auth/authProgram';
import { AUTH_CALLBACK_TIMEOUT_MS, type OAuthProvider } from '@auth/config';
import {
  isPendingOAuthStateFresh,
  type PendingOAuthState,
} from '@auth/pendingOAuthState';
import { withPkcePermit } from '@auth/pkcePermit';
import type { SupabaseAuthShape } from '@auth/SupabaseAuth';
import type {
  SupabaseSession,
  SupabaseSessionCoordinator,
} from '@auth/SupabaseSession';
import { createLog } from '@logger/logUtils';
import type { ProcessServices } from '@platform/processRuntime';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { callbackNonce, type PendingOAuthStore } from './pendingOAuthStore';

const log = createLog('supabaseSignIn');

/**
 * The user declined consent in the browser. `signIn` fails with this rather
 * than a plain error so a host can tell "the user changed their mind" from
 * "the sign-in broke": the desktop, whose sign-ins run detached, says nothing
 * at all for it.
 */
export class SignInCancelled extends Error {
  constructor(message = 'Sign-in was cancelled in the browser.') {
    super(message);
    this.name = 'SignInCancelled';
  }
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
  open(route: AuthCallbackRoute): Effect.Effect<string, Error, Scope.Scope>;
  /**
   * Show (and normally open) the consent URL. Raced against the callback, so
   * a host may block on a browser-choice dialog without stranding a sign-in
   * that has already completed.
   */
  presentSignInUrl(url: string): Effect.Effect<void, Error>;
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
  readonly outcome: Deferred.Deferred<SupabaseSession | null, Error>;
}

/** What a host asks for when it starts one interactive sign-in. */
interface SupabaseSignInRequest {
  readonly provider: OAuthProvider;
  /** Extra `/authorize` parameters (account selection, login hint). */
  readonly queryParams?: Record<string, string>;
  /** Override the shared callback deadline. */
  readonly timeoutMs?: number;
}

interface SupabaseSignInCoordinatorOptions {
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

  /**
   * One interactive sign-in: arm the callback route, initialize the PKCE
   * flow, bind it, show the consent URL, and wait for the callback carrying
   * this attempt's nonce. Fails with the attempt's own error, whose `message`
   * is the user-facing text.
   */
  signIn(
    request: SupabaseSignInRequest,
  ): Effect.Effect<SupabaseSession, Error, ProcessServices> {
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
          const error = ensureError(settleFailure(cause));
          log.error(`Error processing OAuth callback: ${error.message}`);
          const attempt = this.attemptFor(nonce);
          if (attempt) {
            Deferred.doneUnsafe(attempt.outcome, Effect.fail(error));
          }
          return { kind: 'failed', message: error.message } as const;
        }),
      ),
    );
  }

  /**
   * Abandon the outstanding attempt, if any. The invalidation is synchronous,
   * so it cannot slip behind a caller's fiber scheduling; the program that
   * comes back clears the record.
   */
  cancel(): Effect.Effect<void> {
    const abandoned = this.active;
    this.invalidate();
    return abandoned ? this.clearRecord(abandoned.nonce) : Effect.void;
  }

  /**
   * Clear the stored session and refresh the local agent catalog. Answers
   * whether a session was actually signed out; host UI is the caller's.
   */
  signOut(): Effect.Effect<boolean, Error, ProcessServices> {
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
  ): Effect.Effect<SupabaseSession, Error, ProcessServices | Scope.Scope> {
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
  ): Effect.Effect<SignInCallbackOutcome, Error, ProcessServices> {
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
        return yield* this.refuse(attempt, result);
      }

      yield* this.commits.run(
        Effect.gen({ self: this }, function* () {
          yield* this.session.storeSession(result.session);
          // The attempt can be superseded at any suspension point. Once it is,
          // the session just stored must not stay.
          if (attempt && this.active !== attempt) {
            yield* this.session.clearSessionIfCurrent(result.session);
          }
        }),
      );

      const committed = {
        kind: 'committed',
        session: result.session,
      } as const;
      if (attempt) {
        Deferred.doneUnsafe(
          attempt.outcome,
          Effect.succeed(this.active === attempt ? result.session : null),
        );
      } else {
        log.info(`Sign-in completed for ${result.session.account.label}`);
        yield* this.options.transport.announce(committed);
      }
      return committed;
    });
  }

  /** A callback whose code exchange did not yield a session. */
  private refuse(
    attempt: SignInAttempt | undefined,
    result: {
      readonly error: string;
      readonly isAuthError?: boolean;
      readonly cancelled?: boolean;
    },
  ): Effect.Effect<SignInCallbackOutcome, never, ProcessServices> {
    // Declining consent in the browser ends the attempt without failing it,
    // so it never reaches a host's failure wording. Any other auth error is
    // the attempt's failure, and a callback carrying neither is ignored.
    let outcome: SignInCallbackOutcome = {
      kind: 'ignored',
      reason: result.error,
    };
    let settlement: Effect.Effect<SupabaseSession | null, Error> =
      Effect.succeed(null);
    if (result.cancelled) {
      outcome = {
        kind: 'ignored',
        reason: 'the sign-in was cancelled in the browser',
      };
      settlement = Effect.fail(new SignInCancelled());
    } else if (result.isAuthError) {
      outcome = { kind: 'failed', message: result.error };
      settlement = Effect.fail(
        new Error(`OAuth error: ${result.error}. Try again.`),
      );
    }
    return Effect.gen({ self: this }, function* () {
      if (result.cancelled) log.info('Sign-in was cancelled in the browser');
      else if (result.isAuthError) log.error(`Sign-in failed: ${result.error}`);
      else log.debug(`Auth callback ignored: ${result.error}`);
      if (attempt) Deferred.doneUnsafe(attempt.outcome, settlement);
      else yield* this.options.transport.announce(outcome);
      return outcome;
    });
  }

  /**
   * Claim one callback: the nonce is ours, its record is fresh and bound to a
   * PKCE flow, and no other delivery got there first. Serialized, so two
   * windows cannot both commit one attempt. A store that cannot answer means
   * the callback's ownership is unverifiable, which is the attempt's failure.
   */
  private claimCallback(
    nonce: string | null,
  ): Effect.Effect<PendingOAuthState | null, Error> {
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
        Effect.catch((error) =>
          Effect.fail(
            new Error(
              `OAuth callback state could not be verified (${toErrorMessage(error)}). Try again.`,
            ),
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
      nonce: mintCallbackNonce(),
      createdAt: Date.now(),
      outcome: Deferred.makeUnsafe<SupabaseSession | null, Error>(),
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
    return Effect.catch(this.options.store.clear(nonce), (error) =>
      Effect.sync(() => {
        log.warn(
          `Unable to clean up stored OAuth callback state: ${toErrorMessage(error)}`,
        );
      }),
    );
  }
}

/** A sign-in nonce: 16 random bytes, hex, as `OAUTH_NONCE_PATTERN` spells it. */
function mintCallbackNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
