import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { describe, expect, vi } from 'vitest';

import { fetchRemoteAgentConfigYaml } from '@agent/remote/remoteAgentConfigClient';
import { SUPABASE_CONFIG } from '@auth/config';

describe('fetchRemoteAgentConfigYaml', () => {
  it.effect('posts the agent name and returns the parsed YAML config', () => {
    const fetchMock = vi.fn(
      async (_url: URL | RequestInfo, _init?: RequestInit) =>
        Response.json({ config: 'settings: {}\nprompts: {}\n' }),
    );
    return Effect.gen(function* () {
      const config = yield* fetchRemoteAgentConfigYaml('remoteWriter', 'token');

      expect(config).toBe('settings: {}\nprompts: {}\n');
      expect(fetchMock).toHaveBeenCalledOnce();
      // The client calls fetch with a URL and an init whose header keys are
      // lowercased.
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(SUPABASE_CONFIG.edgeFunctionUrl);
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer token');
      expect(headers['content-type']).toBe('application/json');
      expect(
        JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)),
      ).toEqual({ agentName: 'remoteWriter' });
    }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetchMock),
      Effect.provide(FetchHttpClient.layer),
    );
  });
});
