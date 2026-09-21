// The shared sign-in record store and the one login-CSRF nonce check
// (`src/controllers/auth/pendingOAuthStore.ts`), which replaced the three
// per-host copies the extension, desktop and CLI each carried. Everything the
// hosts differ on now lives behind `AuthCallbackTransport`, so this is the
// durable boundary worth pinning: what binds a PKCE flow to an attempt, and
// what a callback has to carry to claim one.

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { AUTH_CALLBACK_TIMEOUT_MS } from '@auth/config';
import {
  callbackNonce,
  memoryPendingOAuthSlots,
  PendingOAuthStore,
  withCallbackNonce,
} from '@controllers/auth/pendingOAuthStore';

const NONCE = 'a'.repeat(32);
const OTHER_NONCE = 'b'.repeat(32);
const FLOW_ID = 'pkce-flow-1234';

function freshAttempt(nonce = NONCE) {
  return { nonce, createdAt: Date.now() };
}

describe('callback nonce', () => {
  it('accepts exactly one well-formed nonce', () => {
    expect(callbackNonce(`code=abc&app_nonce=${NONCE}`)).toBe(NONCE);
    expect(callbackNonce(withCallbackNonce('/cb', NONCE).slice(4))).toBe(NONCE);
  });

  it.each([
    { name: 'no nonce at all', query: 'code=abc' },
    {
      name: 'two nonces (a smuggled second binding)',
      query: `app_nonce=${NONCE}&app_nonce=${OTHER_NONCE}`,
    },
    {
      name: 'a nonce this process could not have minted',
      query: 'app_nonce=x',
    },
  ])('rejects a callback with $name', ({ query }) => {
    expect(callbackNonce(query)).toBeNull();
  });
});

describe('pending OAuth store', () => {
  it.effect('round-trips the flow a bind pinned to an attempt', () =>
    Effect.gen(function* () {
      const store = new PendingOAuthStore(memoryPendingOAuthSlots());
      const attempt = freshAttempt();

      yield* store.bind(attempt, FLOW_ID);

      expect(yield* store.read(NONCE)).toEqual({
        ...attempt,
        flowId: FLOW_ID,
      });
    }),
  );

  it.effect.each([
    { name: 'no flow id', flowId: undefined },
    { name: 'a flow id that is not one auth-js mints', flowId: 'no spaces!' },
  ])('refuses to bind $name', ({ flowId }) =>
    Effect.gen(function* () {
      const store = new PendingOAuthStore(memoryPendingOAuthSlots());

      const error = yield* Effect.flip(store.bind(freshAttempt(), flowId));
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('did not return a valid PKCE flow');
    }),
  );

  it.effect(
    'refuses to bind an attempt that is already past its deadline',
    () =>
      Effect.gen(function* () {
        const store = new PendingOAuthStore(memoryPendingOAuthSlots());
        const stale = {
          nonce: NONCE,
          createdAt: Date.now() - AUTH_CALLBACK_TIMEOUT_MS - 1_000,
        };

        const error = yield* Effect.flip(store.bind(stale, FLOW_ID));
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('no longer pending');
      }),
  );

  it.effect('ignores a stored record that is not one of ours', () =>
    Effect.gen(function* () {
      const slots = memoryPendingOAuthSlots();
      yield* slots.write(NONCE, '{"nonce":');
      const store = new PendingOAuthStore(slots);

      expect(yield* store.read(NONCE)).toBeNull();
    }),
  );

  it.effect('sweeps expired records and keeps the answerable one', () =>
    Effect.gen(function* () {
      const slots = memoryPendingOAuthSlots();
      yield* slots.write(
        OTHER_NONCE,
        JSON.stringify({
          nonce: OTHER_NONCE,
          createdAt: Date.now() - AUTH_CALLBACK_TIMEOUT_MS - 1_000,
          flowId: FLOW_ID,
        }),
      );
      const store = new PendingOAuthStore(slots);
      yield* store.bind(freshAttempt(), FLOW_ID);

      yield* store.sweep();

      expect(yield* slots.nonces()).toEqual([NONCE]);
    }),
  );

  it.effect(
    'clears a claimed record so a replayed callback finds nothing',
    () =>
      Effect.gen(function* () {
        const store = new PendingOAuthStore(memoryPendingOAuthSlots());
        yield* store.bind(freshAttempt(), FLOW_ID);

        yield* store.clear(NONCE);

        expect(yield* store.read(NONCE)).toBeNull();
      }),
  );
});
