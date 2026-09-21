import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { applyTeamRosterWithPreflight } from '@common/teams/TeamRosterApplication';
import {
  resetAgentCatalogAuthRefreshScopeForTests,
  runAfterAgentCatalogAuthRefresh,
  withAgentCatalogAuthRefreshDeferred,
} from '@frontend/auth/agentCatalogRefreshScope';
import { testRuntime } from '@test/support/testProcessRuntime';

describe('extension team auth catalog refresh scope', () => {
  beforeEach(resetAgentCatalogAuthRefreshScopeForTests);

  it.effect(
    'defers auth listeners and fetches the remote catalog exactly once',
    () =>
      Effect.gen(function* () {
        let refreshed = false;
        let remoteFetches = 0;
        const commitPreset = vi.fn(() => Effect.void);
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

        const result = yield* withAgentCatalogAuthRefreshDeferred(
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
                      unresolvedNames: [],
                    }
                  : {
                      keys: {
                        workflow: [],
                        toolUse: [],
                      },
                      unresolvedNames: ['orchestrator'],
                    },
              }),
              commitPreset,
            },
            loadLocalCatalog: () => Effect.void,
            canAccessRemoteCatalog: () => Effect.succeed(false),
            choose: () => Effect.succeed('sign-in' as const),
            signIn: () =>
              Effect.sync(() => {
                // Models/settings listeners run after the preflight-owned fetch and
                // then reuse the populated cache instead of forcing another fetch.
                runAfterAgentCatalogAuthRefresh(testRuntime(), [
                  Effect.sync(() => {
                    if (!refreshed) remoteFetches += 1;
                  }),
                ]);
                return true;
              }),
            forceRefreshRemoteCatalog: () =>
              Effect.sync(() => {
                remoteFetches += 1;
                refreshed = true;
              }),
          }),
        );

        expect(result.status).toBe('applied');
        expect(remoteFetches).toBe(1);
        expect(commitPreset).toHaveBeenCalledOnce();
      }),
  );
});
