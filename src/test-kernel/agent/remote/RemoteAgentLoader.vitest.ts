import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http';
import { afterEach, describe, expect, vi } from 'vitest';

import { loadRemoteAgent } from '@agent/remote/RemoteAgentLoader';
import { listRemoteAgents } from '@agent/remote/remoteAgentList';
import { SupabaseAuth } from '@auth/SupabaseAuth';
import { SUPABASE_CONFIG } from '@auth/config';
import { fakeSupabaseAuth } from '@test/support/fakeSupabaseAuth';

/** Every program here runs against a signed-in fake account plane, with
 *  `fetchMock` as the HTTP client's transport. */
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

function installRemoteAgentListClient(result: {
  data: unknown[] | null;
  error: Partial<
    Record<'code' | 'message' | 'details' | 'hint', string | null>
  > | null;
}): { fetchMock: typeof fetch; selectedColumns: string[] } {
  const selectedColumns: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const urlString = input instanceof Request ? input.url : String(input);
    const url = new URL(urlString);
    selectedColumns.push(url.searchParams.get('select') ?? '');

    if (result.error) {
      return new Response(JSON.stringify(result.error), {
        status: 400,
        statusText: 'Bad Request',
      });
    }

    return new Response(JSON.stringify(result.data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  return { fetchMock, selectedColumns };
}

const canonicalReviewRow = {
  id: 'agent-2',
  name: 'review',
  description: 'Canonical row',
  tools: [],
  agent_category: 'toolUse',
};

function invalidAgentRow(overrides: Record<string, unknown>) {
  return {
    id: 'agent-1',
    name: 'review team',
    description: 'Invalid row',
    tools: [],
    agent_category: 'toolUse',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('remote agent listing', () => {
  it.effect('drops remote rows with non-identifier agent names', () =>
    Effect.gen(function* () {
      const { fetchMock } = installRemoteAgentListClient({
        data: [invalidAgentRow({}), canonicalReviewRow],
        error: null,
      });

      const agents = yield* signedIn(fetchMock, listRemoteAgents());

      expect(agents.map((agent) => agent.name)).toEqual(['review']);
    }),
  );

  it.effect('drops remote rows without an agent category', () =>
    Effect.gen(function* () {
      const { fetchMock } = installRemoteAgentListClient({
        data: [
          invalidAgentRow({ name: 'uncategorized', agent_category: null }),
          canonicalReviewRow,
        ],
        error: null,
      });

      const agents = yield* signedIn(fetchMock, listRemoteAgents());

      expect(agents.map((agent) => agent.name)).toEqual(['review']);
    }),
  );

  it.effect('returns no agents when the list query fails', () =>
    Effect.gen(function* () {
      const { fetchMock, selectedColumns } = installRemoteAgentListClient({
        data: null,
        error: {
          code: '42501',
          message: 'permission denied for table remote_agents',
        },
      });

      const agents = yield* signedIn(fetchMock, listRemoteAgents());

      expect(agents).toEqual([]);
      expect(selectedColumns).toEqual([
        'id, name, description, tools, agent_category',
      ]);
    }),
  );
});

describe('remote agent config parsing', () => {
  it.effect(
    'rejects with a wrapped error for malformed remote config YAML',
    () =>
      Effect.gen(function* () {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
          const urlString =
            input instanceof Request ? input.url : String(input);
          if (urlString !== SUPABASE_CONFIG.edgeFunctionUrl) {
            return new Response('not found', { status: 404 });
          }
          return new Response(
            JSON.stringify({ config: 'name: "unterminated' }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        });

        const error = yield* Effect.flip(
          signedIn(fetchMock, loadRemoteAgent('broken-agent')),
        );
        expect(error.message).toContain(
          'Failed to parse YAML for remote agent "broken-agent"',
        );
      }),
  );
});
