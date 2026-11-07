// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Logger } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, vi } from 'vitest';

// Local imports
import {
  type ChatgptSession,
  SubscriptionAccounts,
  type SubscriptionCoordinator,
  type SubscriptionTokenResponse,
} from '@texra-ai/llm/node';
import { jsonResponse } from '@test/support/fetchTestUtils';
import type { CredentialStore } from '@texra-ai/llm';
import type { HttpClient } from 'effect/http';

// The coordinator reads `Clock` for the expiry decision, which `it.effect`
// serves from a TestClock that starts at epoch zero; every session below is
// placed relative to it, far from the 5-minute refresh buffer's edge.
const NOW = 0;
const FIVE_MIN = 5 * 60 * 1000;

/** The secret store the ChatGPT coordinator binds; it reads one key. */
function memoryStorage(initial?: ChatgptSession): CredentialStore & {
  peek: () => ChatgptSession | undefined;
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
    peek: () =>
      value
        ? // cast: `set` stores only what this store was handed, a ChatgptSession.
          (JSON.parse(value) as ChatgptSession)
        : undefined,
  };
}

function session(overrides: Partial<ChatgptSession> = {}): ChatgptSession {
  return {
    accessToken: 'access-0',
    refreshToken: 'refresh-0',
    expiresAtMs: NOW + 60 * 60 * 1000,
    accountId: 'acct-0',
    email: 'user@example.com',
    ...overrides,
  };
}

function expiredSession(): ChatgptSession {
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

/** The token endpoint's answer to a revoked refresh token. */
const revoked = () => jsonResponse({ error: 'invalid_grant' }, 401);

/** One token-endpoint grant, as the test answers it. */
type Grant = () => Promise<Response>;

/** The grants the current test's token endpoint answers. */
let grants: {
  refreshTokens?: Grant;
} = {};

/**
 * The OAuth token endpoint, behind the `FetchHttpClient.Fetch` reference: the
 * coordinator posts its form grants here, and each goes to the current test's
 * handler for its `grant_type`.
 */
const tokenEndpoint: typeof fetch = async (_input, init) => {
  const form = new URLSearchParams(String(init?.body));
  // Sign-out revokes the refresh token first; revocation answers an empty 200.
  if (form.get('token_type_hint') === 'refresh_token')
    return new Response(null, { status: 200 });
  const grantType = form.get('grant_type');
  if (grantType === 'refresh_token' && grants.refreshTokens) {
    return grants.refreshTokens();
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
 * posted, so the test's next step is ordered after it.
 */
function parkedRefresh() {
  const pending = Promise.withResolvers<Response>();
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
): Effect.Effect<SubscriptionCoordinator<ChatgptSession>> {
  grants = endpointGrants;
  return Effect.map(
    SubscriptionAccounts.make(storage),
    (accounts) => accounts['chatgpt-subscription'],
  );
}

const freshToken = (coordinator: SubscriptionCoordinator<ChatgptSession>) =>
  Effect.map(coordinator.getFreshSession(), (fresh) => fresh.accessToken);

describe('ChatGPT session coordinator', () => {
  it.effect('refreshes once for concurrent callers', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(expiredSession());
      const { pending, refreshTokens, refreshStarted } = parkedRefresh();
      const coordinator = yield* makeCoordinator(storage, { refreshTokens });

      const a = yield* forkNow(freshToken(coordinator));
      const b = yield* forkNow(freshToken(coordinator));
      // The second caller waits on the lock while the first refreshes, then
      // finds the refreshed session.
      yield* refreshStarted;

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
      const coordinator = yield* makeCoordinator(storage, { refreshTokens });

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
      const coordinator = yield* makeCoordinator(storage, { refreshTokens });

      const token = yield* forkNow(freshToken(coordinator));
      yield* refreshStarted;

      // The sign-out waits for the exchange in flight, then deletes what it
      // stored.
      const signedOut = yield* forkNow(coordinator.signOut());
      pending.resolve(jsonResponse(tokenResponse()));

      expect(yield* Fiber.join(token)).toBe('access-1');
      yield* Fiber.join(signedOut);
      expect(storage.peek()).toBeUndefined();
    }),
  );

  it.effect(
    'does not clear a newer login when a stale refresh is rejected',
    () =>
      Effect.gen(function* () {
        const storage = memoryStorage(expiredSession());
        const { pending, refreshTokens, refreshStarted } = parkedRefresh();
        const coordinator = yield* makeCoordinator(storage, { refreshTokens });

        const token = yield* forkNow(freshToken(coordinator));
        yield* refreshStarted;

        // A sign-in that finished stores its grant the same way, after the
        // exchange in flight.
        const signedIn = yield* forkNow(
          coordinator.storeTokens(
            tokenResponse({
              access_token: 'access-new',
              refresh_token: 'refresh-new',
            }),
          ),
        );
        pending.resolve(revoked());

        const error = yield* joinFailure(token);
        yield* Fiber.join(signedIn);
        expect(error).toMatchObject({
          kind: 'fatal',
          needsReauth: true,
        });
        expect(storage.peek()?.accessToken).toBe('access-new');
      }),
  );

  it.effect(
    'keeps the previous refresh token when the response omits a new one',
    () =>
      Effect.gen(function* () {
        const storage = memoryStorage(expiredSession());
        const refreshTokens = async () =>
          jsonResponse(tokenResponse({ refresh_token: undefined }));
        const coordinator = yield* makeCoordinator(storage, { refreshTokens });
        yield* withHttp(freshToken(coordinator));
        expect(storage.peek()?.refreshToken).toBe('refresh-0');
      }),
  );

  it.effect('keeps the session on a transient refresh failure', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(expiredSession());
      const refreshTokens = async () =>
        jsonResponse({ error: 'upstream' }, 502);
      const coordinator = yield* makeCoordinator(storage, { refreshTokens });

      const error = yield* Effect.flip(withHttp(freshToken(coordinator)));
      expect(error).toMatchObject({
        kind: 'transient',
      });
      expect(storage.peek()?.refreshToken).toBe('refresh-0');
    }),
  );

  it.effect(
    'warns that an unreadable session was not ended at the provider',
    () =>
      Effect.gen(function* () {
        const warnings: string[] = [];
        const captured = Logger.make(({ logLevel, message }) => {
          if (logLevel === 'Warn') warnings.push(String(message));
        });
        let value: string | undefined = '{not json';
        const storage: CredentialStore = {
          get: () => Effect.sync(() => value),
          set: () => Effect.void,
          delete: () =>
            Effect.sync(() => {
              value = undefined;
            }),
        };
        const coordinator = yield* makeCoordinator(storage);
        yield* withHttp(coordinator.signOut()).pipe(
          Effect.provide(Logger.layer([captured])),
        );
        expect(value).toBeUndefined();
        expect(warnings.join('\n')).toMatch(/not ended/);
      }),
  );
});
