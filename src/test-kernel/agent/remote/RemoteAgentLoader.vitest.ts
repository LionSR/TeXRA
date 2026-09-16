import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import { loadRemoteAgent } from '@agent/remote/RemoteAgentLoader';
import { listRemoteAgents } from '@agent/remote/remoteAgentList';
import { SupabaseAuth } from '@auth/SupabaseAuth';
import { SUPABASE_CONFIG } from '@auth/config';
import { fakeSupabaseAuth } from '@test/support/fakeSupabaseAuth';

/** Every program here runs against a signed-in fake account plane. */
const signedIn = <A, E>(program: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.provideService(
    program,
    SupabaseAuth,
    fakeSupabaseAuth({ accessToken: Effect.succeed('access-token') }),
  );

function installRemoteAgentListClient(result: {
  data: unknown[] | null;
  error: Partial<
    Record<'code' | 'message' | 'details' | 'hint', string | null>
  > | null;
}): string[] {
  const selectedColumns: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
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
    }),
  );

  return selectedColumns;
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
  vi.unstubAllGlobals();
});

describe('remote agent listing', () => {
  it.effect('drops remote rows with non-identifier agent names', () =>
    Effect.gen(function* () {
      installRemoteAgentListClient({
        data: [invalidAgentRow({}), canonicalReviewRow],
        error: null,
      });

      const agents = yield* signedIn(listRemoteAgents());

      expect(agents.map((agent) => agent.name)).toEqual(['review']);
    }),
  );

  it.effect('drops remote rows without an agent category', () =>
    Effect.gen(function* () {
      installRemoteAgentListClient({
        data: [
          invalidAgentRow({ name: 'uncategorized', agent_category: null }),
          canonicalReviewRow,
        ],
        error: null,
      });

      const agents = yield* signedIn(listRemoteAgents());

      expect(agents.map((agent) => agent.name)).toEqual(['review']);
    }),
  );

  it.effect('returns no agents when the list query fails', () =>
    Effect.gen(function* () {
      const selectedColumns = installRemoteAgentListClient({
        data: null,
        error: {
          code: '42501',
          message: 'permission denied for table remote_agents',
        },
      });

      const agents = yield* signedIn(listRemoteAgents());

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
        vi.stubGlobal(
          'fetch',
          vi.fn(async (input: RequestInfo | URL) => {
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
          }),
        );

        const error = yield* Effect.flip(
          signedIn(loadRemoteAgent('broken-agent')),
        );
        expect(error.message).toContain(
          'Failed to parse YAML for remote agent "broken-agent"',
        );
      }),
  );
});
