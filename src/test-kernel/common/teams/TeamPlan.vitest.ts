import { describe, expect, it } from 'vitest';

import {
  canLaunchTeam,
  loadTeamOptions,
  planTeamRun,
  resolveTeamLaunch,
  teamLaunchBlockReason,
  teamPlanStatus,
  type TeamCatalogAgent,
  type TeamRunPlan,
} from '@common/teams/TeamPlan';
import {
  findTeamPreset,
  launchableTeamPresets,
  teamPresets,
  type TeamPreset,
} from '@common/teams/TeamPresets';
import {
  AGENT_MODE_PRESETS,
  agentMatchesIdentifier,
  STARTER_AGENT_MODE_PRESET,
} from '@shared/schemas';

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

function preset(overrides: Partial<TeamPreset> = {}): TeamPreset {
  return {
    id: 'custom-team',
    name: 'Custom Team',
    description: 'A custom team.',
    icon: 'bookmark',
    agents: ['writer', 'lead', 'member'],
    source: 'custom',
    ...overrides,
  };
}

function manualPlan(overrides: Partial<TeamRunPlan> = {}): TeamRunPlan {
  return {
    preset: preset(),
    rootAgent: agent('lead', { tools: delegateTools }),
    agentKeys: ['builtIn:writer', 'builtIn:lead', 'builtIn:member'],
    missingAgents: [],
    ...overrides,
  };
}

/** The list-backed stand-in for the agent resolver the hosts pass. */
function fromCatalog<T extends TeamCatalogAgent>(agents: readonly T[]) {
  return (identifier: string) =>
    agents.find((entry) => agentMatchesIdentifier(entry, identifier));
}

function planOver<T extends TeamCatalogAgent>(
  teamPreset: TeamPreset,
  options: { agents: readonly T[]; agentOverride?: string },
) {
  return planTeamRun(teamPreset, {
    resolveAgent: fromCatalog(options.agents),
    agentOverride: options.agentOverride,
  });
}

describe('teamPresets', () => {
  it('tags the starter setup-only and drops custom built-in id collisions', () => {
    const collision = preset({
      id: AGENT_MODE_PRESETS[0].id,
      name: 'Shadow Built-in',
    });
    const presets = teamPresets([STARTER_AGENT_MODE_PRESET, collision]);

    expect(presets).toHaveLength(AGENT_MODE_PRESETS.length + 1);
    expect(
      presets.filter((item) => item.id === STARTER_AGENT_MODE_PRESET.id),
    ).toEqual([expect.objectContaining({ setupOnly: true })]);
    expect(
      launchableTeamPresets([STARTER_AGENT_MODE_PRESET]).some(
        (item) => item.id === STARTER_AGENT_MODE_PRESET.id,
      ),
    ).toBe(false);
    expect(presets.find((item) => item.id === collision.id)?.source).toBe(
      'built-in',
    );
  });
});

describe('findTeamPreset', () => {
  it('matches case-insensitive ids, names, and name slugs', () => {
    const target = preset({ id: 'my-id', name: 'My Research Team' });
    const presets = [target];

    expect(findTeamPreset(presets, ' MY-ID ')).toBe(target);
    expect(findTeamPreset(presets, 'my research team')).toBe(target);
    expect(findTeamPreset(presets, 'MY-RESEARCH-TEAM')).toBe(target);
    expect(findTeamPreset(presets, 'missing')).toBeUndefined();
  });
});

function builtInPreset(id: string): TeamPreset {
  const found = teamPresets([]).find((item) => item.id === id);
  if (!found) throw new Error(`Unknown built-in preset: ${id}`);
  return found;
}

describe('planTeamRun', () => {
  it('selects the orchestrator for the built-in physicist team', () => {
    const plan = planOver(builtInPreset('physicist'), {
      agents: [
        agent('research', { tools: delegateTools }),
        agent('orchestrator', { tools: delegateTools }),
      ],
    });

    expect(plan.rootAgent?.name).toBe('orchestrator');
  });

  it('does not fall back to an arbitrary delegating agent for a built-in', () => {
    const plan = planOver(builtInPreset('physicist'), {
      agents: [agent('research', { tools: delegateTools })],
    });

    expect(plan.rootAgent).toBeUndefined();
  });

  it('selects the first delegation-capable custom member in preset order', () => {
    const plan = planOver(preset({ agents: ['second', 'first', 'plain'] }), {
      agents: [
        agent('first', { tools: delegateTools }),
        agent('second', { tools: delegateTools }),
        agent('plain'),
      ],
    });

    expect(plan.rootAgent?.name).toBe('second');
  });

  it('honors name-or-key overrides and reports a missing override', () => {
    const customLead = agent('lead', {
      source: 'custom',
      tools: delegateTools,
    });
    const options = { agents: [customLead, agent('member')] };

    const selected = planOver(preset(), {
      ...options,
      agentOverride: 'custom:lead',
    });
    const missing = planOver(preset(), {
      ...options,
      agentOverride: 'plugin:lead',
    });

    expect(selected.rootAgent).toBe(customLead);
    expect(selected.missingAgentOverride).toBeUndefined();
    expect(missing.rootAgent).toBe(customLead);
    expect(missing.missingAgentOverride).toBe('plugin:lead');
  });

  it('appends an override root once and deduplicates by canonical key', () => {
    const lead = agent('lead', { tools: delegateTools });
    const external = agent('external', {
      source: 'custom',
      tools: delegateTools,
    });
    const included = planOver(preset(), {
      agents: [lead, agent('member')],
      agentOverride: 'lead',
    });
    const appended = planOver(preset(), {
      agents: [lead, agent('member'), external],
      agentOverride: 'custom:external',
    });

    expect(included.agentKeys).toEqual(['builtIn:lead', 'builtIn:member']);
    expect(appended.agentKeys).toEqual([
      'builtIn:lead',
      'builtIn:member',
      'custom:external',
    ]);
  });
});

describe('plan status and launchability', () => {
  it('returns all three launch-block reasons', () => {
    const noRoot = manualPlan({ rootAgent: undefined });
    const nonDelegating = manualPlan({ rootAgent: agent('plain') });
    const noMembers = manualPlan({
      preset: preset({ agents: ['lead'] }),
      agentKeys: ['builtIn:lead'],
    });

    expect(teamLaunchBlockReason(noRoot)).toBe('no runnable team root');
    expect(teamLaunchBlockReason(nonDelegating)).toBe(
      'team root plain is not a delegating agent',
    );
    expect(teamLaunchBlockReason(noMembers)).toBe('no available team members');
  });

  it('narrows launchable plans and classifies availability status', () => {
    const available = manualPlan();
    const degraded = manualPlan({ missingAgents: ['missing'] });
    const unavailable = manualPlan({ rootAgent: undefined });

    expect(canLaunchTeam(available)).toBe(true);
    expect(canLaunchTeam(unavailable)).toBe(false);
    expect(teamPlanStatus(available)).toBe('available');
    expect(teamPlanStatus(degraded)).toBe('degraded');
    expect(teamPlanStatus(unavailable)).toBe('unavailable');
  });
});

describe('loadTeamOptions', () => {
  it('orders built-in teams by declaration, then customs alphabetically', () => {
    const options = loadTeamOptions({
      customPresetsRaw: [
        preset({ id: 'cz', name: 'Zulu' }),
        preset({ id: 'ca', name: 'Alpha' }),
      ],
      resolveAgent: () => undefined,
    });

    expect(options.map((option) => option.value)).toEqual([
      ...AGENT_MODE_PRESETS.map((builtIn) => builtIn.id),
      'ca',
      'cz',
    ]);
  });
});

describe('resolveTeamLaunch', () => {
  type LaunchArgs = Parameters<typeof resolveTeamLaunch<TeamCatalogAgent>>[0];

  function launchArgs(overrides: Partial<LaunchArgs> = {}): LaunchArgs {
    return {
      teamId: 'custom-team',
      customPresetsRaw: [preset()],
      resolveAgent: fromCatalog([
        agent('writer'),
        agent('lead', { tools: delegateTools }),
        agent('member'),
      ]),
      ...overrides,
    };
  }

  it('returns execution-scoped fields for a ready team', () => {
    expect(resolveTeamLaunch(launchArgs())).toEqual({
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

  it('blocks a planned team with no delegation-capable root', () => {
    expect(
      resolveTeamLaunch(
        launchArgs({
          customPresetsRaw: [preset({ agents: ['writer', 'plain'] })],
          resolveAgent: fromCatalog([agent('writer'), agent('plain')]),
        }),
      ),
    ).toEqual({
      status: 'blocked',
      reason: 'no runnable team root',
    });
  });
});
