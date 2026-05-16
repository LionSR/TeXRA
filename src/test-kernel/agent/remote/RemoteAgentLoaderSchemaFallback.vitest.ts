import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isMissingRemoteAgentToolsColumnError,
  RemoteAgentLoader,
} from '@agent/remote/RemoteAgentLoader';
import { SupabaseClient } from '@auth/SupabaseClient';

function installRemoteAgentListClient(
  ...results: Array<{
    data: unknown[] | null;
    error: { code?: string; message?: string } | null;
  }>
): string[] {
  const selectedColumns: string[] = [];
  const queue = [...results];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
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
