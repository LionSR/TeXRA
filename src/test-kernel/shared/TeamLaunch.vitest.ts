import { describe, expect, it } from 'vitest';

import { agentMatchesIdentifier } from '@texra-ai/harness/schemas';
import type { TeamPreset } from '@texra/shared/agentTeams';
import { resolveTeamLaunch } from '@texra/agent/teams/teamLaunch';
import type { TeamCatalogAgent } from '@texra/agent/teams/teamPlan';

const delegateTools = ['agent'];

function agent(
  name: string,
  options: { readonly tools?: readonly string[] } = {},
): TeamCatalogAgent {
  return {
    name,
    source: 'builtIn',
    persona: {
      prompt: '',
      temperature: 1,
      tools: (options.tools ?? []).map((tool) => ({ name: tool })),
    },
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
        launch: { teamId: 'custom-team' },
      },
      missingNames: [],
    });
  });
});
