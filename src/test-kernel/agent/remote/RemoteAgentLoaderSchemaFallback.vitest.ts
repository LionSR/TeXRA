import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isMissingRemoteAgentToolsColumnError,
  RemoteAgentLoader,
} from '@agent/remote/RemoteAgentLoader';
import { SupabaseClient } from '@auth/SupabaseClient';
import { SUPABASE_CONFIG } from '@auth/config';

function installRemoteAgentListClient(
  ...results: Array<{
    data: unknown[] | null;
    error: Partial<
      Record<'code' | 'message' | 'details' | 'hint', string | null>
    > | null;
  }>
): string[] {
  const selectedColumns: string[] = [];
  const queue = [...results];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      // ky passes a Request object; extract the URL string from it
      const urlString = input instanceof Request ? input.url : String(input);
      const url = new URL(urlString);
      selectedColumns.push(url.searchParams.get('select') ?? '');
      const result = queue.shift() ?? { data: null, error: null };

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

describe('remote agent schema compatibility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('recognizes the pre-migration missing tools column error', () => {
    expect(
      isMissingRemoteAgentToolsColumnError({
        code: 'PGRST204',
        message:
          "Could not find the 'tools' column of 'remote_agents' in the schema cache",
      }),
    ).toBe(true);
  });

  it('does not treat unrelated Supabase errors as schema compatibility', () => {
    expect(
      isMissingRemoteAgentToolsColumnError({
        code: '42501',
        message: 'permission denied for table remote_agents',
      }),
    ).toBe(false);

    expect(
      isMissingRemoteAgentToolsColumnError({
        code: 'PGRST204',
        message:
          "Could not find the 'visibility' column of 'remote_agents' in the schema cache",
      }),
    ).toBe(false);
  });

  it('uses the legacy list query only for the missing tools column', async () => {
    const selectedColumns = installRemoteAgentListClient(
      {
        data: null,
        error: {
          code: 'PGRST204',
          message:
            "Could not find the 'tools' column of 'remote_agents' in the schema cache",
        },
      },
      {
        data: [
          {
            id: 'agent-1',
            name: 'legacy-agent',
            description: 'Legacy row',
            visibility: ['public'],
            agent_category: null,
          },
        ],
        error: null,
      },
    );

    const agents = await RemoteAgentLoader.listRemoteAgents();

    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe('legacy-agent');
    expect(selectedColumns).toEqual([
      'id, name, description, visibility, tools, agent_category',
      'id, name, description, visibility, agent_category',
    ]);
  });

  it('keeps the missing-tools fallback when PostgREST sends null details', async () => {
    const selectedColumns = installRemoteAgentListClient(
      {
        data: null,
        error: {
          code: 'PGRST204',
          message: 'tools',
          details: null,
          hint: null,
        },
      },
      {
        data: [
          {
            id: 'agent-1',
            name: 'nullable-error-agent',
            description: 'Legacy row',
            visibility: ['public'],
            agent_category: null,
          },
        ],
        error: null,
      },
    );

    const agents = await RemoteAgentLoader.listRemoteAgents();

    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe('nullable-error-agent');
    expect(selectedColumns).toEqual([
      'id, name, description, visibility, tools, agent_category',
      'id, name, description, visibility, agent_category',
    ]);
  });

  it('drops remote rows with non-identifier agent names', async () => {
    installRemoteAgentListClient({
      data: [
        {
          id: 'agent-1',
          name: 'review team',
          description: 'Legacy row',
          visibility: ['public'],
          tools: [],
          agent_category: 'toolUse',
        },
        {
          id: 'agent-2',
          name: 'review',
          description: 'Canonical row',
          visibility: ['public'],
          tools: [],
          agent_category: 'toolUse',
        },
      ],
      error: null,
    });

    const agents = await RemoteAgentLoader.listRemoteAgents();

    expect(agents.map((agent) => agent.name)).toEqual(['review']);
  });

  it('does not hide unrelated list-query errors behind legacy fallback', async () => {
    const selectedColumns = installRemoteAgentListClient({
      data: null,
      error: {
        code: '42501',
        message: 'permission denied for table remote_agents',
      },
    });

    const agents = await RemoteAgentLoader.listRemoteAgents();

    expect(agents).toEqual([]);
    expect(selectedColumns).toEqual([
      'id, name, description, visibility, tools, agent_category',
    ]);
  });
});

describe('remote agent config parsing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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
        return new Response(
          JSON.stringify({ config: 'name: "unterminated' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    await expect(
      RemoteAgentLoader.loadRemoteAgent('broken-agent'),
    ).rejects.toThrow('Failed to parse YAML for remote agent "broken-agent"');
  });
});
