import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadRemoteAgent } from '@agent/remote/RemoteAgentLoader';
import { listRemoteAgents } from '@agent/remote/remoteAgentList';
import { SupabaseClient } from '@auth/SupabaseClient';
import { SUPABASE_CONFIG } from '@auth/config';

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
  vi.spyOn(SupabaseClient, 'getAccessToken').mockResolvedValue('access-token');

  return selectedColumns;
}

const canonicalReviewRow = {
  id: 'agent-2',
  name: 'review',
  description: 'Canonical row',
  visibility: ['public'],
  tools: [],
  agent_category: 'toolUse',
};

function invalidAgentRow(overrides: Record<string, unknown>) {
  return {
    id: 'agent-1',
    name: 'review team',
    description: 'Invalid row',
    visibility: ['public'],
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
  it('drops remote rows with non-identifier agent names', async () => {
    installRemoteAgentListClient({
      data: [invalidAgentRow({}), canonicalReviewRow],
      error: null,
    });

    const agents = await listRemoteAgents();

    expect(agents.map((agent) => agent.name)).toEqual(['review']);
  });

  it('drops remote rows without an agent category', async () => {
    installRemoteAgentListClient({
      data: [
        invalidAgentRow({ name: 'uncategorized', agent_category: null }),
        canonicalReviewRow,
      ],
      error: null,
    });

    const agents = await listRemoteAgents();

    expect(agents.map((agent) => agent.name)).toEqual(['review']);
  });

  it('returns no agents when the list query fails', async () => {
    const selectedColumns = installRemoteAgentListClient({
      data: null,
      error: {
        code: '42501',
        message: 'permission denied for table remote_agents',
      },
    });

    const agents = await listRemoteAgents();

    expect(agents).toEqual([]);
    expect(selectedColumns).toEqual([
      'id, name, description, visibility, tools, agent_category',
    ]);
  });
});

describe('remote agent config parsing', () => {
  it('rejects with a wrapped error for malformed remote config YAML', async () => {
    vi.spyOn(SupabaseClient, 'isAuthenticated').mockResolvedValue(true);
    vi.spyOn(SupabaseClient, 'getAccessToken').mockResolvedValue(
      'access-token',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const urlString = input instanceof Request ? input.url : String(input);
        if (urlString !== SUPABASE_CONFIG.edgeFunctionUrl) {
          return new Response('not found', { status: 404 });
        }
        return new Response(JSON.stringify({ config: 'name: "unterminated' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    await expect(loadRemoteAgent('broken-agent')).rejects.toThrow(
      'Failed to parse YAML for remote agent "broken-agent"',
    );
  });
});
