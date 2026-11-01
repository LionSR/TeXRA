import { describe, expect, it } from 'vitest';

import { agentMatchesIdentifier } from '@texra-ai/harness/schemas';
import type { TeamPreset } from '@texra/shared/agentTeams';
import { resolveTeamLaunch } from '@texra/shared/teamLaunch';
import type { TeamCatalogAgent } from '@texra/shared/teamPlan';

const delegateTools = ['agent'];

function agent(
  name: string,
  options: Partial<TeamCatalogAgent> = {},
): TeamCatalogAgent {
  return {
    name,
    source: 'builtIn',
    ...options,
  };
}

/** The list-backed stand-in for the agent resolver the hosts pass. */
function fromCatalog<T extends TeamCatalogAgent>(agents: readonly T[]) {
  return (identifier: string) =>
    agents.find((entry) => agentMatchesIdentifier(entry, identifier));
}

describe('resolveTeamLaunch', () => {
  it('returns execution-scoped fields for a ready team', () => {
    const preset: TeamPreset = {
      id: 'custom-team',
      name: 'Custom Team',
      description: 'A custom team.',
      icon: 'bookmark',
      agents: ['writer', 'lead', 'member'],
      source: 'custom',
    };

    expect(
      resolveTeamLaunch({
        teamId: 'custom-team',
        presets: [preset],
        resolveAgent: fromCatalog([
          agent('writer'),
          agent('lead', { tools: delegateTools }),
          agent('member'),
        ]),
        rootAgentNames: [],
      }),
    ).toEqual({
      status: 'ready',
      fields: {
        agent: 'builtIn:lead',
        delegationAgentScope: [
          'builtIn:writer',
          'builtIn:lead',
          'builtIn:member',
        ],
        cli: { teamId: 'custom-team' },
      },
      missingNames: [],
    });
  });
});
