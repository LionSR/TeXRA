// The shared sign-in record store and the one login-CSRF nonce check
// (`src/controllers/auth/pendingOAuthStore.ts`), which replaced the three
// per-host copies the extension, desktop and CLI each carried. Everything the
// hosts differ on now lives behind `AuthCallbackTransport`, so this is the
// durable boundary worth pinning: what binds a PKCE flow to an attempt, and
// what a callback has to carry to claim one.

// Third-party imports
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

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
  it('round-trips the flow a bind pinned to an attempt', async () => {
    const store = new PendingOAuthStore(memoryPendingOAuthSlots());
    const attempt = freshAttempt();

    await Effect.runPromise(store.bind(attempt, FLOW_ID));

    expect(await Effect.runPromise(store.read(NONCE))).toEqual({
      ...attempt,
      flowId: FLOW_ID,
    });
  });

  it.each([
    { name: 'no flow id', flowId: undefined },
    { name: 'a flow id that is not one auth-js mints', flowId: 'no spaces!' },
  ])('refuses to bind $name', async ({ flowId }) => {
    const store = new PendingOAuthStore(memoryPendingOAuthSlots());

    await expect(
      Effect.runPromise(store.bind(freshAttempt(), flowId)),
    ).rejects.toThrow('did not return a valid PKCE flow');
  });

  it('refuses to bind an attempt that is already past its deadline', async () => {
    const store = new PendingOAuthStore(memoryPendingOAuthSlots());
    const stale = {
      nonce: NONCE,
      createdAt: Date.now() - AUTH_CALLBACK_TIMEOUT_MS - 1_000,
    };

    await expect(Effect.runPromise(store.bind(stale, FLOW_ID))).rejects.toThrow(
      'no longer pending',
    );
  });

  it('ignores a stored record that is not one of ours', async () => {
    const slots = memoryPendingOAuthSlots();
    await Effect.runPromise(slots.write(NONCE, '{"nonce":'));
    const store = new PendingOAuthStore(slots);

    expect(await Effect.runPromise(store.read(NONCE))).toBeNull();
  });

  it('sweeps expired records and keeps the answerable one', async () => {
    const slots = memoryPendingOAuthSlots();
    await Effect.runPromise(
      slots.write(
        OTHER_NONCE,
        JSON.stringify({
          nonce: OTHER_NONCE,
          createdAt: Date.now() - AUTH_CALLBACK_TIMEOUT_MS - 1_000,
          flowId: FLOW_ID,
        }),
      ),
    );
    const store = new PendingOAuthStore(slots);
    await Effect.runPromise(store.bind(freshAttempt(), FLOW_ID));

    await Effect.runPromise(store.sweep());

    expect(await Effect.runPromise(slots.nonces())).toEqual([NONCE]);
  });

  it('clears a claimed record so a replayed callback finds nothing', async () => {
    const store = new PendingOAuthStore(memoryPendingOAuthSlots());
    await Effect.runPromise(store.bind(freshAttempt(), FLOW_ID));

    await Effect.runPromise(store.clear(NONCE));

    expect(await Effect.runPromise(store.read(NONCE))).toBeNull();
  });
});
