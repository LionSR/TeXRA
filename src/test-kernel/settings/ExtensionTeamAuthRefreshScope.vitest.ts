import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyTeamRosterWithPreflight } from '@common/teams/TeamRosterApplication';
import {
  resetAgentCatalogAuthRefreshScopeForTests,
  runAfterAgentCatalogAuthRefresh,
  withAgentCatalogAuthRefreshDeferred,
} from '@frontend/auth/agentCatalogRefreshScope';

describe('extension team auth catalog refresh scope', () => {
  beforeEach(resetAgentCatalogAuthRefreshScopeForTests);

  it('defers auth listeners and fetches the remote catalog exactly once', async () => {
    let refreshed = false;
    let remoteFetches = 0;
    const commitPreset = vi.fn(async () => {});
    const preset = {
      id: 'remote-team',
      name: 'Remote team',
      description: 'Hosted team',
      icon: 'screwdriver-wrench' as const,
      agents: {
        workflow: [],
        toolUse: ['orchestrator'],
      },
      texraHostedAgents: ['orchestrator'],
    };

    const result = await withAgentCatalogAuthRefreshDeferred(() =>
      applyTeamRosterWithPreflight('remote-team', {
        catalog: {
          resolvePreset: () => ({
            ok: true,
            preset,
            resolution: refreshed
              ? {
                  keys: {
                    workflow: [],
                    toolUse: ['remote:orchestrator'],
                  },
                  nameSlots: {
                    workflow: [],
                    toolUse: [],
                  },
                  unresolvedNames: [],
                }
              : {
                  keys: {
                    workflow: [],
                    toolUse: [],
                  },
                  nameSlots: {
                    workflow: [],
                    toolUse: ['orchestrator'],
                  },
                  unresolvedNames: ['orchestrator'],
                },
          }),
          commitPreset,
        },
        loadLocalCatalog: async () => {},
        canAccessRemoteCatalog: async () => false,
        choose: async () => 'sign-in',
        signIn: async () => {
          // Models/settings listeners run after the preflight-owned fetch and
          // then reuse the populated cache instead of forcing another fetch.
          runAfterAgentCatalogAuthRefresh(async () => {
            if (!refreshed) remoteFetches += 1;
          });
          return true;
        },
        forceRefreshRemoteCatalog: async () => {
          remoteFetches += 1;
          refreshed = true;
        },
      }),
    );

    expect(result.status).toBe('applied');
    expect(remoteFetches).toBe(1);
    expect(commitPreset).toHaveBeenCalledOnce();
  });
});
