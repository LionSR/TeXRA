import { describe, expect, it } from 'vitest';

import { formatCliAgentRoster } from '@cli/runtime/agentRoster';

describe('AgentRosterForm', () => {
  it('reports open categories without materializing the current catalog', () => {
    const output = formatCliAgentRoster({
      selection: { kind: 'team', teamId: 'deleted-team' },
      effectiveSelection: { kind: 'all' },
      defaultTeamId: undefined,
      missingTeamId: 'deleted-team',
      agentKeys: {
        workflow: 'all',
        toolUse: ['future-assistant'],
      },
      unresolvedNames: ['future-assistant'],
    });

    expect(output).toContain('Workflow agents: all');
    expect(output).toContain(
      'Unavailable team: deleted-team; showing all agents instead',
    );
  });
});
