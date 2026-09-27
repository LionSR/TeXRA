import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http';
import { describe, expect, vi } from 'vitest';

import { loadRemoteAgent } from '@agent/remote/RemoteAgentLoader';
import { fetchRemoteAgentConfigYaml } from '@agent/remote/remoteAgentConfigClient';
import { listRemoteAgents } from '@agent/remote/remoteAgentList';
import { SupabaseAuth } from '@auth/SupabaseAuth';
import { SUPABASE_CONFIG } from '@auth/config';
import { fakeSupabaseAuth } from '@test/support/fakeSupabaseAuth';

/** Run `program` signed in, with `fetchMock` as the HTTP transport. */
const signedIn = <A, E>(
  fetchMock: typeof fetch,
  program: Effect.Effect<A, E, HttpClient.HttpClient>,
): Effect.Effect<A, E> =>
  Effect.provideService(
    program,
    SupabaseAuth,
    fakeSupabaseAuth({ accessToken: Effect.succeed('access-token') }),
  ).pipe(
    Effect.provideService(FetchHttpClient.Fetch, fetchMock),
    Effect.provide(FetchHttpClient.layer),
  );

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

describe('remote agent listing and loading', () => {
  it.effect('drops remote rows with non-identifier agent names', () =>
    Effect.gen(function* () {
      const row = { description: 'd', tools: [], agent_category: 'toolUse' };
      const fetchMock = vi.fn(async () =>
        Response.json([
          { ...row, id: 'agent-1', name: 'review team' },
          { ...row, id: 'agent-2', name: 'review' },
        ]),
      );

      const agents = yield* signedIn(fetchMock, listRemoteAgents());

      expect(agents.map((agent) => agent.name)).toEqual(['review']);
    }),
  );

  it.effect('rejects malformed remote config YAML with a wrapped error', () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async () =>
        Response.json({ config: 'name: "unterminated' }),
      );

      const error = yield* Effect.flip(
        signedIn(fetchMock, loadRemoteAgent('broken-agent')),
      );

      expect(error.message).toContain(
        'Failed to parse YAML for remote agent "broken-agent"',
      );
    }),
  );
});
