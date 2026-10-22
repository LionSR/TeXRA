// Node imports
import { setTimeout as delay } from 'node:timers/promises';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, vi } from 'vitest';

// Local imports
import {
  codexCoordinator,
  type CodexSession,
  type SubscriptionCoordinator,
  type SubscriptionTokenResponse,
} from '@texra-ai/llm/node';
import { createDeferred } from '@test/support/asyncTestUtils';
import { jsonResponse } from '@test/support/fetchTestUtils';
import type { CredentialStore } from '@texra-ai/llm';
import type { HttpClient } from 'effect/http';

// The coordinator reads the wall clock for the expiry decision; every session
// below is placed relative to it, far from the 5-minute refresh buffer's edge.
const NOW = Date.now();
const FIVE_MIN = 5 * 60 * 1000;

/** The secret store the ChatGPT coordinator binds; it reads one key. */
function memoryStorage(initial?: CodexSession): CredentialStore & {
  peek: () => CodexSession | undefined;
} {
  let value = initial ? JSON.stringify(initial) : undefined;
  return {
    get: () => Effect.sync(() => value),
    set: (_name, v) =>
      Effect.sync(() => {
        value = v;
      }),
    delete: () =>
      Effect.sync(() => {
        value = undefined;
      }),
    peek: () => (value ? (JSON.parse(value) as CodexSession) : undefined),
  };
}

/**
 * An in-memory store whose first `get`, `set` or `delete` call blocks until
 * the test calls `release()`, for deterministic race interleavings.
 * `gateReached` resolves once the gated call has started (and is therefore
 * blocked).
 */
function gatedStorage(
  gateOn: 'get' | 'set' | 'delete',
  initial?: CodexSession,
): CredentialStore & {
  peek: () => CodexSession | undefined;
  gateReached: Effect.Effect<void>;
  release: () => void;
} {
  let value = initial ? JSON.stringify(initial) : undefined;
  const reached = Deferred.makeUnsafe<void>();
  const released = Deferred.makeUnsafe<void>();
  let gated = true;
  const gate = Effect.suspend(() => {
    if (!gated) return Effect.void;
    gated = false;
    Deferred.doneUnsafe(reached, Effect.void);
    return Deferred.await(released);
  });
  return {
    get: () =>
      Effect.gen(function* () {
        const snapshot = value;
        if (gateOn === 'get') yield* gate;
        return snapshot;
      }),
    set: (_name, v) =>
      Effect.gen(function* () {
        if (gateOn === 'set') yield* gate;
        value = v;
      }),
    delete: () =>
      Effect.gen(function* () {
        if (gateOn === 'delete') yield* gate;
        value = undefined;
      }),
    peek: () => (value ? (JSON.parse(value) as CodexSession) : undefined),
    gateReached: Deferred.await(reached),
    release: () => {
      Deferred.doneUnsafe(released, Effect.void);
    },
  };
}

function session(overrides: Partial<CodexSession> = {}): CodexSession {
  return {
    accessToken: 'access-0',
    refreshToken: 'refresh-0',
    expiresAtMs: NOW + 60 * 60 * 1000,
    accountId: 'acct-0',
    email: 'user@example.com',
    ...overrides,
  };
}

function expiredSession(): CodexSession {
  return session({ expiresAtMs: NOW - 1 });
}

function tokenResponse(
  overrides: Partial<SubscriptionTokenResponse> = {},
): SubscriptionTokenResponse {
  return {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    ...overrides,
  };
}

function newLoginTokenResponse(): SubscriptionTokenResponse {
  return tokenResponse({
    access_token: 'access-new',
    refresh_token: 'refresh-new',
  });
}

/** The token endpoint's answer to a revoked refresh token. */
const revoked = () => jsonResponse({ error: 'invalid_grant' }, 401);

/** One token-endpoint grant, as the test answers it. */
type Grant = () => Promise<Response>;

/** The grants the current test's token endpoint answers. */
let grants: {
  exchangeAuthorizationCode?: Grant;
  refreshTokens?: Grant;
} = {};

/**
 * The OAuth token endpoint, behind the `FetchHttpClient.Fetch` reference: the
 * coordinator posts its form grants here, and each goes to the current test's
 * handler for its `grant_type`.
 */
const tokenEndpoint: typeof fetch = async (_input, init) => {
  const grantType = new URLSearchParams(String(init?.body)).get('grant_type');
  if (grantType === 'refresh_token' && grants.refreshTokens) {
    return grants.refreshTokens();
  }
  if (grantType === 'authorization_code' && grants.exchangeAuthorizationCode) {
    return grants.exchangeAuthorizationCode();
  }
  throw new Error(`Unexpected grant: ${grantType}`);
};

const withHttp = <A>(
  program: Effect.Effect<A, unknown, HttpClient.HttpClient>,
): Effect.Effect<A, unknown> =>
  program.pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, tokenEndpoint),
  );

function loginWithCode(
  coordinator: SubscriptionCoordinator<CodexSession>,
): Effect.Effect<CodexSession, unknown> {
  return withHttp(
    coordinator.loginWithCode({
      code: 'new-code',
      verifier: 'new-verifier',
      redirectUri: 'http://localhost:1455/auth/callback',
    }),
  );
}

/**
 * Start a coordinator program on its own fiber, synchronously — the old
 * Promise surface began its work at the call site, and these interleavings
 * depend on that: the fiber must be parked (or queued) before the test's next
 * statement runs.
 */
const forkNow = <A>(
  program: Effect.Effect<A, unknown, HttpClient.HttpClient>,
) => Effect.forkChild(withHttp(program), { startImmediately: true });

/**
 * A refresh grant that parks until the test resolves `pending` with the
 * endpoint's response. `refreshStarted` completes once the grant has been
 * posted. The coordinator runs the refresh on a detached fiber, which the
 * scheduler starts on a later `setImmediate`, so no fixed wait on the test's
 * side is ordered before it.
 */
function parkedRefresh() {
  const pending = createDeferred<Response>();
  const started = Deferred.makeUnsafe<void>();
  const refreshTokens = vi.fn(() => {
    Deferred.doneUnsafe(started, Effect.void);
    return pending.promise;
  });
  return { pending, refreshTokens, refreshStarted: Deferred.await(started) };
}

/** The typed failure of a fiber the test started with {@link forkNow}. */
const joinFailure = <A>(fiber: Fiber.Fiber<A, unknown>) =>
  Effect.flip(Fiber.join(fiber));

/**
 * The ChatGPT coordinator over `storage`, with the token endpoint answering
 * the given grants (an unlisted grant fails the request).
 */
function makeCoordinator(
  storage: CredentialStore,
  endpointGrants: typeof grants = {},
): SubscriptionCoordinator<CodexSession> {
  grants = endpointGrants;
  return codexCoordinator(storage);
}

const freshToken = (coordinator: SubscriptionCoordinator<CodexSession>) =>
  Effect.map(coordinator.getFreshSession(), (fresh) => fresh.accessToken);

describe('CodexSessionCoordinator', () => {
  it.effect('does not refresh a token outside the 5-minute buffer', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(
        session({ expiresAtMs: NOW + FIVE_MIN + 60_000 }),
      );
      const refreshTokens = vi.fn();
      const coordinator = makeCoordinator(storage, { refreshTokens });
      expect(yield* withHttp(freshToken(coordinator))).toBe('access-0');
      expect(refreshTokens).not.toHaveBeenCalled();
    }),
  );

  it.effect('refreshes proactively within the 5-minute buffer', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(session({ expiresAtMs: NOW + 60_000 }));
      const refreshTokens = vi.fn(async () => jsonResponse(tokenResponse()));
      const coordinator = makeCoordinator(storage, { refreshTokens });
      expect(yield* withHttp(freshToken(coordinator))).toBe('access-1');
      expect(refreshTokens).toHaveBeenCalledOnce();
      expect(storage.peek()?.accessToken).toBe('access-1');
    }),
  );

  it.effect('single-flights concurrent refreshes', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(expiredSession());
      const { pending, refreshTokens, refreshStarted } = parkedRefresh();
      const coordinator = makeCoordinator(storage, { refreshTokens });

      const a = yield* forkNow(freshToken(coordinator));
      const b = yield* forkNow(freshToken(coordinator));
      // Both callers reached the shared refresh synchronously when forked.
      yield* refreshStarted;
      expect(refreshTokens).toHaveBeenCalledOnce();

      pending.resolve(jsonResponse(tokenResponse()));
      const [ra, rb] = yield* Effect.all([Fiber.join(a), Fiber.join(b)]);

      expect(ra).toBe('access-1');
      expect(rb).toBe('access-1');
      expect(refreshTokens).toHaveBeenCalledOnce();
    }),
  );

  it.effect('rotates a rejected token once, however many calls sent it', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(
        session({ expiresAtMs: NOW + FIVE_MIN + 60_000 }),
      );
      const refreshTokens = vi.fn(async () => jsonResponse(tokenResponse()));
      const coordinator = makeCoordinator(storage, { refreshTokens });

      // Two calls sent access-0 and both got a 401, one after the other:
      // the second finds the token already replaced and leaves it.
      yield* withHttp(coordinator.refreshRejected('access-0'));
      yield* withHttp(coordinator.refreshRejected('access-0'));

      expect(refreshTokens).toHaveBeenCalledOnce();
      expect(storage.peek()?.accessToken).toBe('access-1');
    }),
  );

  it.effect('does not restore a session when sign-out races with refresh', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(expiredSession());
      const { pending, refreshTokens, refreshStarted } = parkedRefresh();
      const coordinator = makeCoordinator(storage, { refreshTokens });

      const token = yield* forkNow(freshToken(coordinator));
      yield* refreshStarted;
      expect(refreshTokens).toHaveBeenCalledOnce();

      yield* coordinator.signOut();
      pending.resolve(jsonResponse(tokenResponse()));

      const error = yield* joinFailure(token);
      expect(error).toMatchObject({
        kind: 'expired',
        needsReauth: true,
      });
      expect(storage.peek()).toBeUndefined();
    }),
  );

  it.effect(
    'does not restore a session when sign-out races with refresh storage',
    () =>
      Effect.gen(function* () {
        const storage = gatedStorage('set', expiredSession());
        const refreshTokens = vi.fn(async () => jsonResponse(tokenResponse()));
        const coordinator = makeCoordinator(storage, { refreshTokens });

        const token = yield* forkNow(freshToken(coordinator));
        yield* storage.gateReached;
        const signOut = yield* forkNow(coordinator.signOut());
        storage.release();

        const error = yield* joinFailure(token);
        expect(error).toMatchObject({
          kind: 'expired',
          needsReauth: true,
        });
        yield* Fiber.join(signOut);
        expect(storage.peek()).toBeUndefined();
      }),
  );

  it.effect(
    'does not erase a newer login with a blocked fatal-refresh deletion',
    () =>
      Effect.gen(function* () {
        const storage = gatedStorage('delete', expiredSession());
        const refreshTokens = vi.fn(async () => revoked());
        const exchangeAuthorizationCode = vi.fn(async () =>
          jsonResponse(newLoginTokenResponse()),
        );
        const coordinator = makeCoordinator(storage, {
          exchangeAuthorizationCode,
          refreshTokens,
        });

        const token = yield* forkNow(freshToken(coordinator));
        // The fatal refresh has started its delete (blocked); a login lands now.
        yield* storage.gateReached;
        const login = yield* forkNow(loginWithCode(coordinator));
        // Let the login run as far as it can before the delete unblocks, so an
        // unserialized store would land first and be erased by the stale delete.
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(exchangeAuthorizationCode).toHaveBeenCalled(),
          ),
        );
        yield* Effect.promise(() => delay(0));
        storage.release();

        const error = yield* joinFailure(token);
        expect(error).toMatchObject({ kind: 'fatal' });
        yield* Fiber.join(login);
        expect(storage.peek()?.accessToken).toBe('access-new');
        expect(storage.peek()?.refreshToken).toBe('refresh-new');
      }),
  );

  it.effect(
    'does not start a stale refresh for a caller entering during sign-out',
    () =>
      Effect.gen(function* () {
        const storage = gatedStorage('delete', expiredSession());
        const refreshTokens = vi.fn(async () => jsonResponse(tokenResponse()));
        const coordinator = makeCoordinator(storage, { refreshTokens });

        const signOut = yield* forkNow(coordinator.signOut());
        // The sign-out delete is blocked mid-write; a caller enters now.
        yield* storage.gateReached;
        const token = yield* forkNow(freshToken(coordinator));
        storage.release();

        const error = yield* joinFailure(token);
        expect(error).toMatchObject({
          kind: 'expired',
          needsReauth: true,
        });
        yield* Fiber.join(signOut);
        expect(refreshTokens).not.toHaveBeenCalled();
        expect(storage.peek()).toBeUndefined();
      }),
  );

  it.effect(
    'does not overwrite a newer login for a caller entering during login',
    () =>
      Effect.gen(function* () {
        const storage = gatedStorage('set', expiredSession());
        const refreshTokens = vi.fn(async () => jsonResponse(tokenResponse()));
        const exchangeAuthorizationCode = vi.fn(async () =>
          jsonResponse(newLoginTokenResponse()),
        );
        const coordinator = makeCoordinator(storage, {
          exchangeAuthorizationCode,
          refreshTokens,
        });

        const login = yield* forkNow(loginWithCode(coordinator));
        // The login store is blocked mid-write; a caller enters now.
        yield* storage.gateReached;
        const token = yield* forkNow(freshToken(coordinator));
        storage.release();

        yield* Fiber.join(login);
        expect(yield* Fiber.join(token)).toBe('access-new');
        expect(refreshTokens).not.toHaveBeenCalled();
        expect(storage.peek()?.accessToken).toBe('access-new');
      }),
  );

  it.effect(
    'finishes an interrupted login store before a later sign-out runs',
    () =>
      Effect.gen(function* () {
        const gated = gatedStorage('set');
        const ops: string[] = [];
        const storage: CredentialStore = {
          get: gated.get,
          set: (name, value) =>
            Effect.gen(function* () {
              ops.push('store');
              yield* gated.set(name, value);
            }),
          delete: (name) =>
            Effect.gen(function* () {
              ops.push('delete');
              yield* gated.delete(name);
            }),
        };
        const exchangeAuthorizationCode = vi.fn(async () =>
          jsonResponse(newLoginTokenResponse()),
        );
        const coordinator = makeCoordinator(storage, {
          exchangeAuthorizationCode,
        });

        // The login is forked and then interrupted while its session store is
        // blocked mid-write, as the host's run boundary would interrupt it.
        const login = yield* forkNow(
          coordinator.loginWithCode({
            code: 'new-code',
            verifier: 'new-verifier',
            redirectUri: 'http://localhost:1455/auth/callback',
          }),
        );
        yield* gated.gateReached;
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(login), {
          startImmediately: true,
        });
        const signOut = yield* forkNow(coordinator.signOut());
        yield* Effect.promise(() => delay(0));

        // The store cannot be cancelled, so it keeps the permit: the sign-out
        // queues behind it instead of running beside it.
        expect(ops).toEqual(['store']);
        gated.release();

        const loginExit = yield* Fiber.await(login);
        expect(Exit.isSuccess(loginExit)).toBe(false);
        yield* Fiber.join(signOut);
        yield* Fiber.join(interrupting);
        expect(ops).toEqual(['store', 'delete']);
        expect(gated.peek()).toBeUndefined();
      }),
  );

  it.effect('retries a session read superseded while storage is blocked', () =>
    Effect.gen(function* () {
      const storage = gatedStorage('get', session());
      const exchangeAuthorizationCode = vi.fn(async () =>
        jsonResponse(newLoginTokenResponse()),
      );
      const coordinator = makeCoordinator(storage, {
        exchangeAuthorizationCode,
      });

      const token = yield* forkNow(freshToken(coordinator));
      yield* storage.gateReached;
      yield* loginWithCode(coordinator);
      storage.release();

      expect(yield* Fiber.join(token)).toBe('access-new');
      expect(storage.peek()?.accessToken).toBe('access-new');
    }),
  );

  it.effect(
    'does not clear a newer login when a stale refresh is rejected',
    () =>
      Effect.gen(function* () {
        const storage = memoryStorage(expiredSession());
        const { pending, refreshTokens, refreshStarted } = parkedRefresh();
        const exchangeAuthorizationCode = vi.fn(async () =>
          jsonResponse(newLoginTokenResponse()),
        );
        const coordinator = makeCoordinator(storage, {
          exchangeAuthorizationCode,
          refreshTokens,
        });

        const token = yield* forkNow(freshToken(coordinator));
        yield* refreshStarted;
        expect(refreshTokens).toHaveBeenCalledOnce();

        yield* loginWithCode(coordinator);
        pending.resolve(revoked());

        const error = yield* joinFailure(token);
        expect(error).toMatchObject({
          kind: 'fatal',
          needsReauth: true,
        });
        expect(storage.peek()?.accessToken).toBe('access-new');
        expect(storage.peek()?.refreshToken).toBe('refresh-new');
      }),
  );

  it.effect(
    'returns the newer login when a successful refresh is superseded',
    () =>
      Effect.gen(function* () {
        const storage = memoryStorage(expiredSession());
        const { pending, refreshTokens, refreshStarted } = parkedRefresh();
        const exchangeAuthorizationCode = vi.fn(async () =>
          jsonResponse(newLoginTokenResponse()),
        );
        const coordinator = makeCoordinator(storage, {
          exchangeAuthorizationCode,
          refreshTokens,
        });

        const token = yield* forkNow(freshToken(coordinator));
        yield* refreshStarted;
        expect(refreshTokens).toHaveBeenCalledOnce();

        yield* loginWithCode(coordinator);
        pending.resolve(jsonResponse(tokenResponse()));

        // Concurrent sign-in is not a re-auth failure — hand back the new session.
        expect(yield* Fiber.join(token)).toBe('access-new');
        expect(storage.peek()?.accessToken).toBe('access-new');
        expect(storage.peek()?.refreshToken).toBe('refresh-new');
      }),
  );

  it.effect(
    'does not treat a still-expiring pre-refresh session as a successful supersede',
    () =>
      Effect.gen(function* () {
        // Generation bump that leaves the same expiring credentials (models a
        // concurrent store that failed after supersede, or rewrote the same
        // blob) must not hand back the stale token as if refresh completed.
        const storage = memoryStorage(expiredSession());
        const { pending, refreshTokens, refreshStarted } = parkedRefresh();
        const exchangeAuthorizationCode = vi.fn(async () =>
          jsonResponse(
            tokenResponse({
              access_token: 'access-0',
              refresh_token: 'refresh-0',
              // Still inside the proactive refresh buffer.
              expires_in: 60,
            }),
          ),
        );
        const coordinator = makeCoordinator(storage, {
          exchangeAuthorizationCode,
          refreshTokens,
        });

        const token = yield* forkNow(freshToken(coordinator));
        yield* refreshStarted;
        expect(refreshTokens).toHaveBeenCalledOnce();

        yield* loginWithCode(coordinator);
        pending.resolve(
          jsonResponse(tokenResponse({ access_token: 'access-stale-refresh' })),
        );

        const error = yield* joinFailure(token);
        expect(error).toMatchObject({
          kind: 'transient',
          needsReauth: false,
        });
        expect(storage.peek()?.accessToken).toBe('access-0');
      }),
  );

  it.effect(
    'keeps the previous refresh token when the response omits a new one',
    () =>
      Effect.gen(function* () {
        const storage = memoryStorage(expiredSession());
        const refreshTokens = vi.fn(async () =>
          jsonResponse(tokenResponse({ refresh_token: undefined })),
        );
        const coordinator = makeCoordinator(storage, { refreshTokens });
        yield* withHttp(freshToken(coordinator));
        expect(storage.peek()?.refreshToken).toBe('refresh-0');
      }),
  );

  it.effect('clears the session and surfaces re-auth on a fatal refresh', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(expiredSession());
      const refreshTokens = vi.fn(async () => revoked());
      const coordinator = makeCoordinator(storage, { refreshTokens });

      const error = yield* Effect.flip(withHttp(freshToken(coordinator)));
      expect(error).toMatchObject({
        kind: 'fatal',
        needsReauth: true,
      });
      expect(storage.peek()).toBeUndefined();
    }),
  );

  it.effect('keeps the session on a transient refresh failure', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(expiredSession());
      const refreshTokens = vi.fn(async () =>
        jsonResponse({ error: 'upstream' }, 502),
      );
      const coordinator = makeCoordinator(storage, { refreshTokens });

      const error = yield* Effect.flip(withHttp(freshToken(coordinator)));
      expect(error).toMatchObject({
        kind: 'transient',
      });
      expect(storage.peek()?.refreshToken).toBe('refresh-0');
    }),
  );
});
