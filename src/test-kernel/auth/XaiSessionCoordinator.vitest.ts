import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import { xaiCoordinator } from '@texra-ai/llm/node';
import type { CredentialStore } from '@texra-ai/llm';

/** A secret store holding `stored` under every key; writes are dropped. */
function storeHolding(stored?: string): CredentialStore {
  return {
    get: () => Effect.succeed(stored),
    set: () => Effect.void,
    delete: () => Effect.void,
  };
}

describe('xAI subscription session coordinator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buildAuthorizeRequest includes pinned redirect, plan, and referrer', () => {
    const coordinator = xaiCoordinator(storeHolding());
    const auth = coordinator.buildAuthorizeRequest(0);
    const url = new URL(auth.url);
    expect(auth.redirectUri).toBe('http://127.0.0.1:56121/callback');
    expect(url.searchParams.get('client_id')).toBe(
      'b1a00492-073a-47ea-816f-4c329264a828',
    );
    expect(url.searchParams.get('redirect_uri')).toBe(auth.redirectUri);
    expect(url.searchParams.get('plan')).toBe('generic');
    expect(url.searchParams.get('referrer')).toBe('texra');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // CSRF is `state`; we do not send an unverified OIDC nonce.
    expect(url.searchParams.get('nonce')).toBeNull();
    expect(auth.verifier.length).toBeGreaterThan(20);
    expect(auth.state.length).toBeGreaterThan(20);
  });

  it.effect.each([
    { stored: '{not-json', what: 'not JSON' },
    { stored: JSON.stringify({ accessToken: 'only' }), what: 'off-schema' },
  ])(
    'fails an unreadable stored session ($what) as fatal, not signed out',
    ({ stored }) =>
      Effect.gen(function* () {
        const coordinator = xaiCoordinator(storeHolding(stored));
        const failure = yield* Effect.flip(coordinator.getStatus());
        expect(failure).toMatchObject({
          _tag: 'SubscriptionOAuthError',
          kind: 'fatal',
        });
      }),
  );
});
