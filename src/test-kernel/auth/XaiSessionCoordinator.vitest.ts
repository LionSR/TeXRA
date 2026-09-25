import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import { XaiSessionCoordinator } from '@auth/xai/XaiSessionCoordinator';
import type {
  SubscriptionOAuthClient,
  SubscriptionSessionStorage,
} from '@auth/oauth/SubscriptionOAuthCoordinator';
import type { XaiSession } from '@auth/xai/xaiSessionTypes';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { captureLogEntries } from '@test/support/logSinkCapture';

const NOW = 1_900_000_000_000;

function memoryStorage(initial?: XaiSession): SubscriptionSessionStorage & {
  peek: () => XaiSession | undefined;
} {
  let value = initial ? JSON.stringify(initial) : undefined;
  return {
    get: () => Effect.sync(() => value),
    store: (v) =>
      Effect.sync(() => {
        value = v;
      }),
    delete: () =>
      Effect.sync(() => {
        value = undefined;
      }),
    peek: () => (value ? (JSON.parse(value) as XaiSession) : undefined),
  };
}

function makeCoordinator(options: {
  storage: SubscriptionSessionStorage;
  client?: SubscriptionOAuthClient;
}): XaiSessionCoordinator {
  return new XaiSessionCoordinator({ ...options, now: () => NOW });
}

describe('XaiSessionCoordinator', () => {
  afterEach(() => {
    setLogSink(null);
    vi.restoreAllMocks();
  });

  it('buildAuthorizeRequest includes pinned redirect, plan, and referrer', () => {
    const coordinator = makeCoordinator({ storage: memoryStorage() });
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
        const storage: SubscriptionSessionStorage = {
          get: () => Effect.succeed(stored),
          store: () => Effect.void,
          delete: () => Effect.void,
        };
        const coordinator = makeCoordinator({ storage });
        expect(yield* coordinator.loadSession()).toBeNull();
        expect(yield* coordinator.getStatus()).toEqual({ signedIn: false });
        expect(logs.has('WARN', 'SubscriptionOAuth', warning)).toBe(true);
      }).pipe(Effect.provide(effectDiagnosticsLayer('Trace'))),
  );
});
