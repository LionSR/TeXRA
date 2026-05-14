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
  const supabase = {
    auth: {
      setSession: vi.fn().mockResolvedValue({}),
    },
    from: vi.fn(() => ({
      select: (columns: string) => {
        selectedColumns.push(columns);
        return {
          order: vi.fn(
            async () => queue.shift() ?? { data: null, error: null },
          ),
        };
      },
    })),
  };

  vi.spyOn(SupabaseClient, 'isAuthenticated').mockResolvedValue(true);
  vi.spyOn(SupabaseClient, 'getSessionTokens').mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
  });
  vi.spyOn(SupabaseClient, 'getClient').mockReturnValue(
    supabase as unknown as ReturnType<typeof SupabaseClient.getClient>,
  );

  return selectedColumns;
}

describe('remote agent schema compatibility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
