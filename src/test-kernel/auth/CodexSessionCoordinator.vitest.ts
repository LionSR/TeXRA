// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
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

// The coordinator reads `Clock` for the expiry decision, which `it.effect`
// serves from a TestClock that starts at epoch zero; every session below is
// placed relative to it, far from the 5-minute refresh buffer's edge.
const NOW = 0;
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
