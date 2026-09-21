import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import { fetchRemoteAgentConfigYaml } from '@agent/remote/remoteAgentConfigClient';
import { SUPABASE_CONFIG } from '@auth/config';

describe('fetchRemoteAgentConfigYaml', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect('posts the agent name and returns the parsed YAML config', () =>
    Effect.gen(function* () {
      // ky buffers the request body for retry support, so read it inside the mock
      // (via clone) before that stream is consumed rather than from mock.calls.
      let requestBody: unknown;
      const fetchMock = vi.fn(async (request: Request) => {
        requestBody = await request.clone().json();
        return Response.json({ config: 'settings: {}\nprompts: {}\n' });
      });
      vi.stubGlobal('fetch', fetchMock);

      const config = yield* fetchRemoteAgentConfigYaml('remoteWriter', 'token');

      expect(config).toBe('settings: {}\nprompts: {}\n');
      expect(fetchMock).toHaveBeenCalledOnce();
      // ky passes a Request object; inspect properties rather than raw fetch args
      const request = fetchMock.mock.calls[0][0];
      expect(request.url).toBe(SUPABASE_CONFIG.edgeFunctionUrl);
      expect(request.method).toBe('POST');
      expect(request.headers.get('Authorization')).toBe('Bearer token');
      expect(request.headers.get('Content-Type')).toBe('application/json');
      expect(requestBody).toEqual({ agentName: 'remoteWriter' });
    }),
  );

  it.effect.each([
    [404, /Agent "remoteWriter" not found or access denied/],
    [403, /Your account does not have permission to access this remote agent/],
  ] as const)(
    'maps a %i response to the user-facing error text',
    ([status, pattern]) =>
      Effect.gen(function* () {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => new Response('rejected', { status })),
        );

        const failure = yield* Effect.flip(
          fetchRemoteAgentConfigYaml('remoteWriter', 'token'),
        );

        expect(failure.message).toMatch(pattern);
      }),
  );
});
