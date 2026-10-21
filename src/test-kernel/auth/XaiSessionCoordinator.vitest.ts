import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import { xaiCoordinator } from '@texra-ai/llm/node';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { captureLogEntries } from '@test/support/logSinkCapture';
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
    setLogSink(null);
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
    { stored: '{not-json', warning: 'not valid JSON' },
    {
      stored: JSON.stringify({ accessToken: 'only' }),
      warning: 'schema validation',
    },
  ])(
    'warns and treats an unreadable stored session ($warning) as signed out',
    ({ stored, warning }) =>
      Effect.gen(function* () {
        const logs = captureLogEntries();
        const coordinator = xaiCoordinator(storeHolding(stored));
        expect(yield* coordinator.loadSession()).toBeNull();
        expect(yield* coordinator.getStatus()).toEqual({ signedIn: false });
        expect(logs.has('WARN', 'SubscriptionOAuth', warning)).toBe(true);
      }).pipe(Effect.provide(effectDiagnosticsLayer('Trace'))),
  );
});
